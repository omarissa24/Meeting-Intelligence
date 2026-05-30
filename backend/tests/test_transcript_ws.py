"""WebSocket round-trip tests for /transcript/ws/{session_id}.

Uses FastAPI's TestClient (sync WS API). The synthetic ticker emits every
~1s, so probe-based tests look for the probe by its unique text rather
than asserting on frame order.
"""

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
