"""Row-level security helpers.

Postgres RLS policies on `users`, `meetings`, and `transcript_segments`
key off the `app.current_user_id` GUC. Routes set it once per session;
batch writers set it once per transaction. `set_request_user` is the
only place that text gets formatted, so we don't sprinkle `SET LOCAL`
strings throughout the codebase.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def set_request_user(session: AsyncSession, user_id: UUID) -> None:
    """Bind the session's effective user for RLS policy evaluation.

    Uses `set_config(...)` rather than literal SQL so the UUID is bound
    as a parameter — RLS predicates are still trusted regardless, but
    parameterised binding keeps the contract honest.
    """
    await session.execute(
        text("SELECT set_config('app.current_user_id', :uid, true)"),
        {"uid": str(user_id)},
    )
