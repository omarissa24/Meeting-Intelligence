"""Unit tests for DeepgramNovaSTT with a mocked Deepgram SDK client.

The real SDK opens a WebSocket against Deepgram; here we replace the
`AsyncDeepgramClient` symbol with a hand-built fake so the tests are
hermetic, fast, and don't need an API key.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest

from meeting_intelligence.interfaces.stt import TranscriptEvent


class _FakeWord:
    def __init__(self, speaker: int | None) -> None:
        self.speaker = speaker


class _FakeAlternative:
    def __init__(self, transcript: str, speakers: list[int | None]) -> None:
        self.transcript = transcript
        self.words = [_FakeWord(s) for s in speakers]


class _FakeChannel:
    def __init__(self, transcript: str, speakers: list[int | None]) -> None:
        self.alternatives = [_FakeAlternative(transcript, speakers)]


class _FakeResults:
    """Stand-in for `ListenV1Results` — duck-typed to the attributes
    `_results_to_event` reads. We patch `isinstance(msg, ListenV1Results)`
    in the impl via the module-level import so the check passes against
    this fake."""

    def __init__(
        self,
        *,
        transcript: str,
        speakers: list[int | None],
        is_final: bool,
        start: float = 0.0,
        duration: float = 1.0,
    ) -> None:
        self.channel = _FakeChannel(transcript, speakers)
        self.is_final = is_final
        self.start = start
        self.duration = duration


class _FakeConn:
    """An async context manager + async iterator that pretends to be a Deepgram
    AsyncV1SocketClient. `outgoing` is the list of messages it will yield;
    `media_chunks` records every send_media call; `close_calls` counts
    send_close_stream invocations."""

    def __init__(self, outgoing: list[object]) -> None:
        self._outgoing = list(outgoing)
        self.media_chunks: list[bytes] = []
        self.close_calls = 0
        self._close_evt = asyncio.Event()

    async def send_media(self, chunk: bytes) -> None:
        self.media_chunks.append(chunk)

    async def send_close_stream(self) -> None:
        self.close_calls += 1
        self._close_evt.set()

    def __aiter__(self) -> AsyncIterator[object]:
        async def gen() -> AsyncIterator[object]:
            for msg in self._outgoing:
                yield msg
            # Mimic real Deepgram: the WS stays open until the client sends
            # close_stream, then drains and shuts down. Without this wait the
            # consumer loop exits before the producer task has finished
            # pumping audio, which doesn't match production behaviour.
            await self._close_evt.wait()

        return gen()


async def _collect(audio_chunks: list[bytes]) -> AsyncIterator[bytes]:
    for c in audio_chunks:
        yield c


@pytest.fixture
def patched_isinstance(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make `isinstance(msg, ListenV1Results)` accept `_FakeResults`.

    The impl imports `ListenV1Results` from the SDK; the cleanest way to
    let our fake satisfy that isinstance check is to patch the symbol
    bound in the impl module to a tuple including our fake.
    """
    import meeting_intelligence.stt.deepgram_nova as mod

    monkeypatch.setattr(mod, "ListenV1Results", _FakeResults)


@pytest.fixture
def patched_client(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Patch AsyncDeepgramClient where the impl reads it, then capture the
    instance used so tests can assert on it."""
    holder: dict[str, object] = {}

    def make(api_key: str) -> MagicMock:
        # The actual conn is set per-test via `holder["conn"] = _FakeConn(...)`
        # before transcribe() runs. Re-resolve at call time.
        client = MagicMock()

        @asynccontextmanager
        async def connect(**kwargs: object) -> AsyncIterator[_FakeConn]:
            holder["connect_kwargs"] = kwargs
            yield holder["conn"]  # type: ignore[arg-type]

        client.listen.v1.connect = connect
        return client

    monkeypatch.setattr(
        "meeting_intelligence.stt.deepgram_nova.AsyncDeepgramClient",
        MagicMock(side_effect=make),
    )
    return holder


async def test_transcribe_yields_event_for_final_results(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn(
        [
            _FakeResults(
                transcript="hello world",
                speakers=[0, 0],
                is_final=True,
                start=0.5,
                duration=1.5,
            )
        ]
    )
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    events: list[TranscriptEvent] = []
    async for ev in stt.transcribe("sess-1", _collect([b"\x00" * 100])):
        events.append(ev)

    assert len(events) == 1
    e = events[0]
    assert e.session_id == "sess-1"
    assert e.text == "hello world"
    assert e.speaker_id == "spk-0"
    assert e.is_final is True
    assert e.start_ms == 500
    assert e.end_ms == 2000  # (0.5 + 1.5) * 1000


async def test_transcribe_passes_correct_connect_options(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    patched_client["conn"] = _FakeConn([])

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    async for _ in stt.transcribe("sess-cfg", _collect([])):
        pass

    kwargs = patched_client["connect_kwargs"]
    assert kwargs == {  # type: ignore[comparison-overlap]
        "model": "nova-2",
        "encoding": "linear16",
        "sample_rate": 16000,
        "channels": 1,
        "diarize": True,
        "interim_results": True,
        "punctuate": True,
        "smart_format": True,
    }


async def test_transcribe_sends_every_chunk_and_closes(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn([])
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    chunks = [b"a" * 100, b"b" * 100, b"c" * 100]
    async for _ in stt.transcribe("sess-pump", _collect(chunks)):
        pass

    assert conn.media_chunks == chunks
    assert conn.close_calls == 1


async def test_transcribe_drops_empty_transcripts(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn(
        [
            _FakeResults(transcript="   ", speakers=[0], is_final=False),
            _FakeResults(transcript="real", speakers=[0], is_final=True),
        ]
    )
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    events = [e async for e in stt.transcribe("sess-empty", _collect([b"x"]))]

    assert len(events) == 1
    assert events[0].text == "real"


async def test_transcribe_picks_dominant_speaker(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn(
        [
            _FakeResults(
                transcript="four words here actually",
                speakers=[1, 1, 0, 1],  # speaker 1 dominates 3-1
                is_final=True,
            )
        ]
    )
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    events = [e async for e in stt.transcribe("sess-spk", _collect([b"x"]))]
    assert events[0].speaker_id == "spk-1"


async def test_transcribe_falls_back_to_spk0_when_diarisation_missing(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn(
        [
            _FakeResults(
                transcript="early utterance",
                speakers=[None, None],
                is_final=False,
            )
        ]
    )
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    events = [e async for e in stt.transcribe("sess-anon", _collect([b"x"]))]
    assert events[0].speaker_id == "spk-0"


async def test_transcribe_yields_interim_then_final(
    patched_client: dict[str, object],
    patched_isinstance: None,
) -> None:
    conn = _FakeConn(
        [
            _FakeResults(transcript="hello", speakers=[0], is_final=False),
            _FakeResults(transcript="hello world", speakers=[0, 0], is_final=True),
        ]
    )
    patched_client["conn"] = conn

    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    stt = DeepgramNovaSTT(api_key="fake")
    events = [e async for e in stt.transcribe("sess-interim", _collect([b"x"]))]
    assert [e.is_final for e in events] == [False, True]
    assert events[1].text == "hello world"


def test_constructor_rejects_empty_api_key() -> None:
    from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT

    with pytest.raises(ValueError, match="api_key"):
        DeepgramNovaSTT(api_key="")
