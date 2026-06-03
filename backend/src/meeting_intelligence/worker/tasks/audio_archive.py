"""On-stop audio archive task.

Triggered from the WS handler's `finally` block after every
authenticated session, with the path to a temp WAV file the handler
captured. The task:

  1. Encodes the WAV to a 128 kbps MP3 via `ffmpeg` (FR-2.06).
  2. Uploads the MP3 through the configured `ObjectStorageProvider`
     under `meetings/<user_id>/<meeting_id>.mp3` (FR-2.07: keys are
     workspace/user-scoped).
  3. Sets `meetings.audio_object_key` to the new key. Writes through
     `set_request_user(meeting.user_id)` so the RLS-bound UPDATE
     succeeds without a SECURITY DEFINER detour.
  4. Unlinks the temp WAV — even on encode/upload failure (move
     semantics, not copy).

Failure handling: encode and upload failures retry up to 3 times with
exponential backoff. SQL failures don't retry — they're either a
missing migration or a real bug, and either way more retries won't
help.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path
from uuid import UUID

from celery.exceptions import MaxRetriesExceededError, Retry
from sqlalchemy import text

from meeting_intelligence.api.deps import _build_object_storage
from meeting_intelligence.config import get_settings
from meeting_intelligence.db.engine import make_engine, make_session_factory
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.worker.celery_app import celery_app

log = logging.getLogger("meeting_intelligence.worker.audio_archive")


class AudioArchiveError(Exception):
    """Raised by `archive_meeting_audio` to mark a retry-eligible failure.

    Pure SQL errors propagate as themselves so retry logic can short-
    circuit them — mismatched schemas don't get better with rerunning.
    """


def _encode_wav_to_mp3(wav_path: Path) -> bytes:
    """Run `ffmpeg -i in.wav -codec:a libmp3lame -b:a 128k -f mp3 -`.

    Reads MP3 bytes off stdout; surfaces stderr on non-zero exit.
    Raises `AudioArchiveError` on any non-zero exit so the task layer
    can decide retry-vs-give-up.
    """
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-loglevel",
                "error",
                "-i",
                str(wav_path),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "-f",
                "mp3",
                "-",
            ],
            check=False,
            capture_output=True,
            timeout=600,  # 10 min ceiling for a 3 h meeting at 128k stereo
        )
    except FileNotFoundError as exc:
        # ffmpeg not on PATH — operational, not transient. Don't retry.
        raise RuntimeError("ffmpeg binary not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioArchiveError(f"ffmpeg timed out: {exc}") from exc

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace")[:2000]
        raise AudioArchiveError(f"ffmpeg failed (rc={proc.returncode}): {stderr}")

    return proc.stdout


async def _persist_audio_key(meeting_id: UUID, user_id: UUID, key: str) -> None:
    """UPDATE meetings.audio_object_key under RLS.

    Builds an engine and session per call — the worker isn't long-
    running enough on a single task to benefit from a pooled engine,
    and a per-task pool keeps the failure mode legible.
    """
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL must be set for audio archive task")
    engine = make_engine(settings.database_url)
    factory = make_session_factory(engine)
    try:
        async with factory() as session:
            await set_request_user(session, user_id)
            result = await session.execute(
                text(
                    "UPDATE meetings SET audio_object_key = :key "
                    "WHERE id = :id RETURNING id"
                ),
                {"key": key, "id": str(meeting_id)},
            )
            if result.scalar_one_or_none() is None:
                # RLS-scoped to user_id — a missing row means the meeting
                # was deleted between WS close and this task running.
                # That's a no-op, not an error: someone deleted the
                # parent row, the audio belongs in storage's purge path.
                log.info(
                    "audio_archive.meeting_vanished meeting_id=%s user_id=%s",
                    meeting_id,
                    user_id,
                )
                await session.rollback()
                return
            await session.commit()
    finally:
        await engine.dispose()


async def _do_archive(meeting_id: UUID, user_id: UUID, wav_path: Path) -> str:
    """Encode + upload + persist; returns the resulting storage key."""
    if not wav_path.exists():
        raise AudioArchiveError(f"wav source missing: {wav_path}")
    if wav_path.stat().st_size == 0:
        # Zero-byte WAV: the user clicked Stop before any audio frames
        # arrived. Don't bother encoding; just no-op cleanly.
        log.info("audio_archive.empty_wav meeting_id=%s; skipping", meeting_id)
        return ""

    log.info(
        "audio_archive.encode_start meeting_id=%s wav_bytes=%d",
        meeting_id,
        wav_path.stat().st_size,
    )
    mp3_bytes = await asyncio.to_thread(_encode_wav_to_mp3, wav_path)
    log.info(
        "audio_archive.encode_done meeting_id=%s mp3_bytes=%d",
        meeting_id,
        len(mp3_bytes),
    )

    storage = _build_object_storage(get_settings())
    key = f"meetings/{user_id}/{meeting_id}.mp3"
    await storage.put(key, mp3_bytes, content_type="audio/mpeg")

    await _persist_audio_key(meeting_id, user_id, key)
    return key


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True,
    name="meeting_intelligence.archive_meeting_audio",
    max_retries=3,
    default_retry_delay=30,
    acks_late=True,
)
def archive_meeting_audio(
    self: object,
    *,
    meeting_id: str,
    user_id: str,
    wav_path: str,
) -> str:
    """Celery task entry-point. See module docstring for semantics."""
    meeting_uuid = UUID(meeting_id)
    user_uuid = UUID(user_id)
    wav = Path(wav_path)

    try:
        try:
            return asyncio.run(_do_archive(meeting_uuid, user_uuid, wav))
        except AudioArchiveError as exc:
            log.warning(
                "audio_archive.transient_failure meeting_id=%s err=%s",
                meeting_id,
                exc,
            )
            try:
                # `self.retry` is provided by `bind=True` above. mypy
                # doesn't know — Celery's task type is dynamic.
                raise self.retry(exc=exc, countdown=30)  # type: ignore[attr-defined]
            except MaxRetriesExceededError:
                log.error(
                    "audio_archive.dead_letter meeting_id=%s reason=%s",
                    meeting_id,
                    exc,
                )
                # DoD line 160: surface a final dead-letter log line so an
                # operator can grep for it. The temp file unlink in
                # `finally` still runs.
                raise
            except Retry:
                # Celery raises `Retry` to signal the broker. Re-raise
                # for it to do its thing.
                raise
    finally:
        try:
            wav.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning(
                "audio_archive.unlink_failed wav_path=%s err=%s",
                wav_path,
                exc,
            )


__all__ = ["AudioArchiveError", "archive_meeting_audio"]
