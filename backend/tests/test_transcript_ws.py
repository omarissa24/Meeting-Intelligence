"""WebSocket round-trip tests for /transcript/ws/{session_id}.

Uses FastAPI's TestClient (sync WS API). The synthetic ticker emits every
~1s, so probe-based tests look for the probe by its unique text rather
than asserting on frame order.
"""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from meeting_intelligence.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _hello(session_id: str = "sess-test") -> dict:
    return {
        "type": "client_hello",
        "sessionId": session_id,
        "clientVersion": "0.0.0-test",
        "capabilities": {"audioFormat": "pcm16le-mono-16khz", "sendsBinaryAudio": False},
    }


def test_hello_returns_session_started(client: TestClient) -> None:
    with client.websocket_connect("/transcript/ws/sess-test") as ws:
        ws.send_text(json.dumps(_hello()))
        first = json.loads(ws.receive_text())
        assert first["type"] == "session_started"
        assert first["sessionId"] == "sess-test"
        assert first["sttProvider"] == "in-memory-echo"
        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-test"}))


def test_text_probe_is_echoed_back(client: TestClient) -> None:
    needle = "probe-needle-xyz"
    with client.websocket_connect("/transcript/ws/sess-probe") as ws:
        ws.send_text(json.dumps(_hello("sess-probe")))
        _started = json.loads(ws.receive_text())
        ws.send_text(json.dumps({"type": "text_probe", "sessionId": "sess-probe", "text": needle}))

        for _ in range(20):
            frame = json.loads(ws.receive_text())
            if frame["type"] == "transcript_line" and frame["line"]["text"] == needle:
                assert frame["line"]["speakerId"] == "probe"
                assert frame["line"]["isFinal"] is True
                break
        else:
            pytest.fail("never received the probe echo within 20 frames")

        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-probe"}))


def test_client_bye_returns_session_ended(client: TestClient) -> None:
    with client.websocket_connect("/transcript/ws/sess-bye") as ws:
        ws.send_text(json.dumps(_hello("sess-bye")))
        _started = json.loads(ws.receive_text())
        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-bye"}))

        for _ in range(20):
            frame = json.loads(ws.receive_text())
            if frame["type"] == "session_ended":
                assert frame["sessionId"] == "sess-bye"
                assert "stats" in frame
                assert frame["stats"]["finalLineCount"] >= 0
                return
        pytest.fail("never received session_ended within 20 frames")


def test_invalid_hello_emits_error_and_closes(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with client.websocket_connect("/transcript/ws/sess-bad") as ws:
        # Send a bye first instead of hello — invalid first frame.
        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-bad"}))
        first = json.loads(ws.receive_text())
        assert first["type"] == "error"
        assert first["code"] == "INVALID_HELLO"
        assert first["recoverable"] is False
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()


def test_hello_session_id_mismatch_is_rejected(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with client.websocket_connect("/transcript/ws/sess-mismatch") as ws:
        ws.send_text(json.dumps(_hello("different-id")))
        first = json.loads(ws.receive_text())
        assert first["type"] == "error"
        assert first["code"] == "INVALID_HELLO"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()


def test_audio_chunk_routes_through_echo_provider(client: TestClient) -> None:
    """The route base64-decodes audio_chunk, feeds it to stt.transcribe(),
    and forwards each yielded TranscriptEvent as a transcript_line.

    InMemoryEchoSTT yields exactly one event per chunk with speaker_id="echo",
    so three chunks in should produce three echo lines out.
    """
    silence_1s = base64.b64encode(b"\x00" * 32000).decode("ascii")  # ~1s @ 16kHz/16-bit mono

    with client.websocket_connect("/transcript/ws/sess-audio") as ws:
        ws.send_text(json.dumps(_hello("sess-audio")))
        started = json.loads(ws.receive_text())
        assert started["type"] == "session_started"

        for seq in range(1, 4):
            ws.send_text(
                json.dumps(
                    {
                        "type": "audio_chunk",
                        "sessionId": "sess-audio",
                        "seq": seq,
                        "pcmBase64": silence_1s,
                    }
                )
            )

        echo_lines: list[dict] = []
        # Filter ticker lines (they have speaker_id="spk-1"/"spk-2") and keep
        # only echoes (speaker_id="echo"); 3 chunks → 3 echoes.
        for _ in range(30):
            frame = json.loads(ws.receive_text())
            if frame["type"] == "transcript_line" and frame["line"]["speakerId"] == "echo":
                echo_lines.append(frame["line"])
                if len(echo_lines) == 3:
                    break
        assert len(echo_lines) == 3
        assert all(line["isFinal"] for line in echo_lines)

        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-audio"}))


def test_second_connection_with_same_session_id_starts_fresh_session(
    client: TestClient,
) -> None:
    """Locks in the current Phase-1 stateless contract: each WS connection
    spawns a brand-new STT session, even when the path session_id matches a
    previous one. This is what desktop reconnect (FR-1.10) currently relies on.

    A future Phase-2 slice that introduces server-side resume tokens will
    have to consciously change this assertion — that's the point.
    """
    session_id = "sess-recon"

    with client.websocket_connect(f"/transcript/ws/{session_id}") as ws_a:
        ws_a.send_text(json.dumps(_hello(session_id)))
        first_started = json.loads(ws_a.receive_text())
        assert first_started["type"] == "session_started"
        assert first_started["sessionId"] == session_id
        first_started_at = first_started["startedAt"]
        ws_a.send_text(json.dumps({"type": "client_bye", "sessionId": session_id}))

    # New connection with the SAME session_id — server should treat it as
    # a fresh session (different startedAt) because no persistence exists.
    with client.websocket_connect(f"/transcript/ws/{session_id}") as ws_b:
        ws_b.send_text(json.dumps(_hello(session_id)))
        second_started = json.loads(ws_b.receive_text())
        assert second_started["type"] == "session_started"
        assert second_started["sessionId"] == session_id
        # The startedAt timestamps prove the two are independent sessions.
        assert second_started["startedAt"] != first_started_at
        ws_b.send_text(json.dumps({"type": "client_bye", "sessionId": session_id}))


def test_invalid_base64_audio_chunk_emits_error(client: TestClient) -> None:
    with client.websocket_connect("/transcript/ws/sess-bad-audio") as ws:
        ws.send_text(json.dumps(_hello("sess-bad-audio")))
        _started = json.loads(ws.receive_text())

        ws.send_text(
            json.dumps(
                {
                    "type": "audio_chunk",
                    "sessionId": "sess-bad-audio",
                    "seq": 1,
                    "pcmBase64": "not valid base64!!!",
                }
            )
        )

        for _ in range(20):
            frame = json.loads(ws.receive_text())
            if frame["type"] == "error":
                assert frame["code"] == "INVALID_AUDIO"
                assert frame["recoverable"] is True
                break
        else:
            pytest.fail("never received INVALID_AUDIO error")

        ws.send_text(json.dumps({"type": "client_bye", "sessionId": "sess-bad-audio"}))
