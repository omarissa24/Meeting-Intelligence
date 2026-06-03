"""FastAPI auth dependencies.

`get_current_user` validates the bearer token and resolves the local
`users` row via `auth.upsert_user` — a SECURITY DEFINER function added
in migration 0002 that bypasses RLS for the upsert (RLS keys off
`app.current_user_id`, which the requester doesn't know yet on first
login). Every other authenticated DB op goes through `get_request_session`,
which opens a session, sets the GUC to the resolved user id, and yields.

Routes must use `get_request_session` — never `get_db_session` directly —
so RLS policies always see the request's user_id.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import get_auth_provider, get_session_factory
from meeting_intelligence.auth.workos_provider import TokenVerificationError
from meeting_intelligence.db.models.user import User
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.interfaces.auth import AuthenticatedUser, AuthProvider

log = logging.getLogger("meeting_intelligence.auth")


_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="invalid or missing bearer token",
    headers={"WWW-Authenticate": "Bearer"},
)


def _parse_bearer(authorization: str | None) -> str:
    if not authorization:
        raise _UNAUTHORIZED
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise _UNAUTHORIZED
    token = parts[1].strip()
    if not token:
        raise _UNAUTHORIZED
    return token


async def _verify_or_401(auth: AuthProvider, token: str) -> AuthenticatedUser:
    try:
        return await auth.verify_token(token)
    except TokenVerificationError as exc:
        log.info("auth.token_rejected reason=%s", exc)
        raise _UNAUTHORIZED from exc


def _parse_org_id(raw: str | None) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


async def _resolve_user(session: AsyncSession, claims: AuthenticatedUser) -> User:
    """Resolve the local users row from a verified token.

    Two paths:
      * `claims.email` is set (dev tokens, future SSO claims that carry
        it) — call the SECURITY DEFINER upsert for find-or-create.
      * `claims.email` is None (WorkOS AuthKit access tokens) — read by
        `workos_user_id` only. Provisioning must already have happened
        at `/auth/callback` time, where the email is available; if no
        row matches we raise 401 so the desktop re-runs the login flow.

    The detached `User` instance returned here is what `get_request_session`
    binds the RLS GUC against; routes that need the live row re-fetch
    through that session.
    """
    if claims.email is not None:
        result = await session.execute(
            text(
                "SELECT id, email, organization_id, workos_user_id "
                "FROM auth.upsert_user(:wid, :email, :org)"
            ),
            {
                "wid": claims.user_id,
                "email": claims.email,
                "org": _parse_org_id(claims.organization_id),
            },
        )
        row = result.one()
        return User(
            id=row.id,
            email=row.email,
            organization_id=row.organization_id,
            workos_user_id=row.workos_user_id,
        )

    # No email on the token — the desktop's per-request path. The
    # users row was provisioned at /auth/callback time. Use the
    # SECURITY DEFINER lookup so the SELECT bypasses users-RLS (which
    # we can't satisfy here because `app.current_user_id` isn't bound
    # yet — that's exactly what we're trying to determine).
    select_row = await session.execute(
        text(
            "SELECT id, email, organization_id, workos_user_id "
            "FROM auth.lookup_user_by_workos_id(:wid)"
        ),
        {"wid": claims.user_id},
    )
    row = select_row.one_or_none()
    if row is None:
        raise TokenVerificationError(
            "user not provisioned for this workos_user_id; sign in again"
        )
    return User(
        id=row.id,
        email=row.email,
        organization_id=row.organization_id,
        workos_user_id=row.workos_user_id,
    )


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    auth: AuthProvider = Depends(get_auth_provider),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_session_factory),
) -> User:
    """Verify the bearer and return the local User.

    The returned instance is detached from any session. Routes that
    need the live, RLS-bound row should re-fetch it through
    `get_request_session`.
    """
    token = _parse_bearer(authorization)
    claims = await _verify_or_401(auth, token)

    async with session_factory() as session:
        try:
            user = await _resolve_user(session, claims)
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    log.debug(
        "auth.current_user_resolved user_id=%s workos_user_id=%s",
        user.id,
        claims.user_id,
    )
    return user


async def get_request_session(
    user: User = Depends(get_current_user),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_session_factory),
) -> AsyncIterator[AsyncSession]:
    """Yield a request-scoped DB session with RLS bound to the current user.

    Every authenticated route must use this — directly or transitively —
    so RLS policies always see the request's user_id. Commits on
    successful return; rolls back on exception.
    """
    async with session_factory() as session:
        await set_request_user(session, user.id)
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
