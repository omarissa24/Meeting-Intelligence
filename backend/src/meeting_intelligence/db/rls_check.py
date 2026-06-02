"""RLS-bypass guard for application startup.

Postgres unconditionally bypasses every RLS policy — even with FORCE
ROW LEVEL SECURITY set — for any role that has `rolsuper = true` or
`rolbypassrls = true`. That means a backend connecting to the DB as
`postgres` (or any role granted `BYPASSRLS`) silently serves cross-user
data, regardless of how carefully the policies are written.

`assert_not_bypassing_rls` is the runtime contract that prevents this
mistake. The lifespan calls it once with the freshly-built engine; if
the role would bypass, uvicorn fails to come up with a clear error.

This is intentionally hard-coded. There is no opt-out env var: anyone
with a real reason to bypass during a debug session can comment the
call out in `main.py` for the duration. Making the bypass explicit is
the whole point.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


class RLSBypassError(RuntimeError):
    """Raised when the configured DB role would bypass RLS policies."""


async def assert_not_bypassing_rls(engine: AsyncEngine) -> None:
    """Refuse to start if the engine's connection role bypasses RLS.

    Asks Postgres directly rather than trusting the configured URL —
    the env may say one thing while the actual session is another (a
    `SET ROLE` upstream, a connection pool replacing the user, etc).
    The check covers both `rolsuper` and `rolbypassrls`; either one
    causes a silent RLS-off failure.

    Raises:
        RLSBypassError: if the connection role has rolsuper=true or
            rolbypassrls=true. The message names the role and points
            to infra/README.md for the fix.
    """
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT current_user, rolsuper, rolbypassrls "
                    "FROM pg_roles WHERE rolname = current_user"
                )
            )
        ).one()

    role, is_super, can_bypass = row[0], bool(row[1]), bool(row[2])

    if is_super or can_bypass:
        flags = ", ".join(
            name
            for name, on in (("rolsuper", is_super), ("rolbypassrls", can_bypass))
            if on
        )
        raise RLSBypassError(
            f"backend is connected to Postgres as role {role!r} which "
            f"has {flags} — RLS policies are silently bypassed. Connect "
            f"as a non-privileged role (e.g. `app_user`); see "
            f"infra/README.md → Application role for the dev setup."
        )
