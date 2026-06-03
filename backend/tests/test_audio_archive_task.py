"""archive_meeting_audio — task-level tests.

Runs the task synchronously via `task_always_eager=True` so we exercise
the actual decorator + retry plumbing. We mock `_encode_wav_to_mp3`
(no ffmpeg on the test PATH), `_persist_audio_key` (the worker uses
its own engine pointed at `Settings.database_url`, which doesn't line
up with the ephemeral test DB the `db_session_factory` fixture makes),
and the storage put. End-to-end DB persistence is covered by the
manual smoke run in `docs/...` once the desktop player ships.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from celery.exceptions import Retry

from meeting_intelligence.worker.celery_app import celery_app
from meeting_intelligence.worker.tasks import audio_archive
from meeting_intelligence.worker.tasks.audio_archive import (
    AudioArchiveError,
    archive_meeting_audio,
)


@pytest.fixture
def eager_celery() -> Any:
    """Force tasks to run inline so we can assert on their behaviour."""
    prev_eager = celery_app.conf.task_always_eager
    prev_propagate = celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    try:
        yield celery_app
    finally:
        celery_app.conf.task_always_eager = prev_eager
        celery_app.conf.task_eager_propagates = prev_propagate


def _stub_storage_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, bytes]]:
    """Patch the storage build to return a list-capturing fake; return that list."""
    captured: list[tuple[str, bytes]] = []

    class _FakeStorage:
        async def put(self, key: str, data: bytes, content_type: str) -> str:
            captured.append((key, data))
            return f"local://{key}"

        async def get(self, key: str) -> bytes:  # pragma: no cover
            raise NotImplementedError

        async def presigned_url(self, key: str, expires_in: int) -> str:  # pragma: no cover
            raise NotImplementedError

        async def delete(self, key: str) -> None:  # pragma: no cover
            raise NotImplementedError

    monkeypatch.setattr(audio_archive, "_build_object_storage", lambda _settings: _FakeStorage())
    return captured


def _stub_persist(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, str]]:
    """Capture the DB write call so we don't actually need a DB."""
    calls: list[tuple[str, str, str]] = []

    async def _capture(meeting_id: Any, user_id: Any, key: str) -> None:
        calls.append((str(meeting_id), str(user_id), key))

    monkeypatch.setattr(audio_archive, "_persist_audio_key", _capture)
    return calls


def test_archive_encodes_uploads_and_persists(
    eager_celery: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        audio_archive, "_encode_wav_to_mp3", lambda _wav: b"\xff\xfb\x90\x00fake-mp3"
    )
    storage_calls = _stub_storage_calls(monkeypatch)
    db_calls = _stub_persist(monkeypatch)

    meeting_id = uuid4()
    user_id = uuid4()
    wav_path = tmp_path / f"{meeting_id}.wav"
    wav_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")

    result = archive_meeting_audio.delay(
        meeting_id=str(meeting_id),
        user_id=str(user_id),
        wav_path=str(wav_path),
    )
    key = result.get(timeout=10)

    assert key == f"meetings/{user_id}/{meeting_id}.mp3"
    assert storage_calls == [(key, b"\xff\xfb\x90\x00fake-mp3")]
    assert db_calls == [(str(meeting_id), str(user_id), key)]
    assert not wav_path.exists()  # temp WAV cleaned up


def test_archive_skips_zero_byte_wav(
    eager_celery: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage_calls = _stub_storage_calls(monkeypatch)
    db_calls = _stub_persist(monkeypatch)

    meeting_id = uuid4()
    user_id = uuid4()
    wav_path = tmp_path / f"{meeting_id}.wav"
    wav_path.write_bytes(b"")

    result = archive_meeting_audio.delay(
        meeting_id=str(meeting_id),
        user_id=str(user_id),
        wav_path=str(wav_path),
    )
    out = result.get(timeout=5)
    assert out == ""
    assert storage_calls == []
    assert db_calls == []
    assert not wav_path.exists()


def test_archive_unlinks_wav_even_after_encode_failure(
    eager_celery: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(_wav: Path) -> bytes:
        raise AudioArchiveError("ffmpeg blew up")

    monkeypatch.setattr(audio_archive, "_encode_wav_to_mp3", _boom)
    _stub_storage_calls(monkeypatch)
    _stub_persist(monkeypatch)

    meeting_id = uuid4()
    user_id = uuid4()
    wav_path = tmp_path / f"{meeting_id}.wav"
    wav_path.write_bytes(b"RIFFx" * 1024)

    # Celery wraps the underlying AudioArchiveError in `Retry` when
    # `task_eager_propagates=True` and the task has `bind=True`. We
    # care that *something* raised to surface the failure path; the
    # `finally` block under test runs regardless.
    with pytest.raises((Retry, AudioArchiveError)):
        result = archive_meeting_audio.delay(
            meeting_id=str(meeting_id),
            user_id=str(user_id),
            wav_path=str(wav_path),
        )
        result.get(timeout=10)

    assert not wav_path.exists()
