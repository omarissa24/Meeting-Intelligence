"""End-to-end RLS check.

Seeds two users (A, B) and a meeting per user using a session that
does *not* set `app.current_user_id` (the test runs as the migration
owner; FORCE ROW LEVEL SECURITY makes that owner subject to the
policies, so the seed needs to set the GUC explicitly to A's id while
inserting A's rows, then to B's id for B's rows).

Then asserts:
  - A session with the GUC set to A's id sees only A's data.
  - A session attempting to INSERT a meeting `user_id = B.id` while
    the GUC is set to A is rejected by the WITH CHECK clause.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.db.rls import set_request_user


async def _seed_user(session: AsyncSession, email: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    # We're FORCEd by RLS; bypass-by-insert means we have to set the GUC
    # to the row we're about to create.
    await set_request_user(session, user_id)
    await session.execute(
        text(
            "INSERT INTO users (id, email) VALUES (:id, :email)"
        ),
        {"id": str(user_id), "email": email},
    )
    return user_id


async def _seed_meeting(session: AsyncSession, user_id: uuid.UUID, title: str) -> uuid.UUID:
    meeting_id = uuid.uuid4()
    await set_request_user(session, user_id)
    await session.execute(
        text(
            "INSERT INTO meetings (id, user_id, status, title) "
            "VALUES (:id, :user_id, 'pending', :title)"
        ),
        {"id": str(meeting_id), "user_id": str(user_id), "title": title},
    )
    return meeting_id


@pytest.mark.asyncio
async def test_rls_isolates_meetings_per_user(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with db_session_factory() as seed:
        user_a = await _seed_user(seed, f"a-{uuid.uuid4()}@example.com")
        user_b = await _seed_user(seed, f"b-{uuid.uuid4()}@example.com")
        await _seed_meeting(seed, user_a, "A's standup")
        await _seed_meeting(seed, user_b, "B's review")
        await seed.commit()

    # Session scoped to A — should see exactly one meeting, A's.
    async with db_session_factory() as as_a:
        await set_request_user(as_a, user_a)
        rows = (
            await as_a.execute(text("SELECT title FROM meetings ORDER BY title"))
        ).fetchall()
        assert [r[0] for r in rows] == ["A's standup"]

    # Session scoped to B — should see exactly one meeting, B's.
    async with db_session_factory() as as_b:
        await set_request_user(as_b, user_b)
        rows = (
            await as_b.execute(text("SELECT title FROM meetings ORDER BY title"))
        ).fetchall()
        assert [r[0] for r in rows] == ["B's review"]


@pytest.mark.asyncio
async def test_rls_rejects_cross_user_insert(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A session bound to A cannot create a meeting owned by B (WITH CHECK)."""
    async with db_session_factory() as seed:
        user_a = await _seed_user(seed, f"a-{uuid.uuid4()}@example.com")
        user_b = await _seed_user(seed, f"b-{uuid.uuid4()}@example.com")
        await seed.commit()

    async with db_session_factory() as as_a:
        await set_request_user(as_a, user_a)
        # Postgres reports RLS violations as InsufficientPrivilege, which
        # SQLAlchemy maps onto ProgrammingError (subclass of DBAPIError) —
        # not IntegrityError.
        with pytest.raises(DBAPIError, match="row-level security"):
            await as_a.execute(
                text(
                    "INSERT INTO meetings (user_id, status) "
                    "VALUES (:user_id, 'pending')"
                ),
                {"user_id": str(user_b)},
            )
            await as_a.commit()


@pytest.mark.asyncio
async def test_rls_isolates_meeting_summaries_per_user(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Phase 3: each user only sees their own meeting_summaries rows."""
    async with db_session_factory() as seed:
        user_a = await _seed_user(seed, f"a-{uuid.uuid4()}@example.com")
        user_b = await _seed_user(seed, f"b-{uuid.uuid4()}@example.com")
        meeting_a = await _seed_meeting(seed, user_a, "A's meeting")
        meeting_b = await _seed_meeting(seed, user_b, "B's meeting")
        await set_request_user(seed, user_a)
        await seed.execute(
            text(
                "INSERT INTO meeting_summaries (meeting_id, user_id, status, summary) "
                "VALUES (:m, :u, 'completed', :s)"
            ),
            {"m": str(meeting_a), "u": str(user_a), "s": "A summary"},
        )
        await set_request_user(seed, user_b)
        await seed.execute(
            text(
                "INSERT INTO meeting_summaries (meeting_id, user_id, status, summary) "
                "VALUES (:m, :u, 'completed', :s)"
            ),
            {"m": str(meeting_b), "u": str(user_b), "s": "B summary"},
        )
        await seed.commit()

    async with db_session_factory() as as_a:
        await set_request_user(as_a, user_a)
        rows = (
            await as_a.execute(text("SELECT summary FROM meeting_summaries"))
        ).fetchall()
        assert [r[0] for r in rows] == ["A summary"]

    async with db_session_factory() as as_b:
        await set_request_user(as_b, user_b)
        rows = (
            await as_b.execute(text("SELECT summary FROM meeting_summaries"))
        ).fetchall()
        assert [r[0] for r in rows] == ["B summary"]


@pytest.mark.asyncio
async def test_rls_isolates_action_items_per_user(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with db_session_factory() as seed:
        user_a = await _seed_user(seed, f"a-{uuid.uuid4()}@example.com")
        user_b = await _seed_user(seed, f"b-{uuid.uuid4()}@example.com")
        meeting_a = await _seed_meeting(seed, user_a, "A's meeting")
        meeting_b = await _seed_meeting(seed, user_b, "B's meeting")
        await set_request_user(seed, user_a)
        await seed.execute(
            text(
                "INSERT INTO action_items (meeting_id, user_id, description, order_index) "
                "VALUES (:m, :u, 'A todo', 0)"
            ),
            {"m": str(meeting_a), "u": str(user_a)},
        )
        await set_request_user(seed, user_b)
        await seed.execute(
            text(
                "INSERT INTO action_items (meeting_id, user_id, description, order_index) "
                "VALUES (:m, :u, 'B todo', 0)"
            ),
            {"m": str(meeting_b), "u": str(user_b)},
        )
        await seed.commit()

    async with db_session_factory() as as_a:
        await set_request_user(as_a, user_a)
        rows = (
            await as_a.execute(text("SELECT description FROM action_items"))
        ).fetchall()
        assert [r[0] for r in rows] == ["A todo"]

    async with db_session_factory() as as_b:
        await set_request_user(as_b, user_b)
        rows = (
            await as_b.execute(text("SELECT description FROM action_items"))
        ).fetchall()
        assert [r[0] for r in rows] == ["B todo"]
