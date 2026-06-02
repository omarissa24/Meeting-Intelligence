"""Database layer — engine, session factory, declarative base, models, RLS helpers.

Built on SQLAlchemy 2.0 async + Postgres + psycopg3. The schema is born here;
Alembic migrations under `backend/alembic/` drive its evolution.
"""

from meeting_intelligence.db.base import Base
from meeting_intelligence.db.engine import make_engine, make_session_factory
from meeting_intelligence.db.rls import set_request_user

__all__ = ["Base", "make_engine", "make_session_factory", "set_request_user"]
