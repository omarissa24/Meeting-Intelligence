"""Celery application factory.

The broker + result backend both point at Redis (FR-2.14: "Redis is the
Celery broker for all background tasks"). When `REDIS_URL` is unset
(test environments that don't run the worker), we still construct the
app — Celery's `task_always_eager` flag in tests bypasses the broker
entirely, so the URL stub is fine.

DoD line 160 ("Celery worker monitored via Flower; failed tasks retry
up to 3 times before dead-lettering") is satisfied at the policy level
here: `task_acks_late=True` so a worker crash mid-task re-queues the
task, and per-task `max_retries=3` with `retry_backoff` is set on the
specific task decorators rather than globally (so heavyweight one-off
tasks can opt out).

Flower wiring is a separate compose-only concern and lands in the
infra slice.
"""

from __future__ import annotations

from celery import Celery

from meeting_intelligence.config import get_settings


def _build_app() -> Celery:
    settings = get_settings()
    broker_url = settings.redis_url or "redis://localhost:6379/0"
    app = Celery(
        "meeting_intelligence",
        broker=broker_url,
        backend=broker_url,
        include=["meeting_intelligence.worker.tasks.audio_archive"],
    )
    app.conf.update(
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_track_started=True,
        # Workers are CPU-light here (audio encode is the heavy step,
        # but ffmpeg runs in a subprocess) — `prefetch_multiplier=1`
        # avoids one slow task blocking faster ones for too long.
        worker_prefetch_multiplier=1,
        # Result expiration: short. The desktop polls
        # GET /meetings/:id/audio rather than reading task results
        # directly, so we don't need long-lived result rows in Redis.
        result_expires=3600,
        # Serializer pinned to JSON — no pickle. Closes a class of
        # arbitrary-code-execution attacks if Redis is ever exposed.
        accept_content=["json"],
        task_serializer="json",
        result_serializer="json",
    )
    return app


celery_app: Celery = _build_app()


__all__ = ["celery_app"]
