"""Celery worker entry-point.

`celery_app` is the canonical app handle. Run the worker with:

    uv run celery -A meeting_intelligence.worker.celery_app worker -l info

Tasks are auto-discovered from
`meeting_intelligence.worker.tasks` thanks to `app.autodiscover_tasks`
in `celery_app.py`.
"""

from meeting_intelligence.worker.celery_app import celery_app

__all__ = ["celery_app"]
