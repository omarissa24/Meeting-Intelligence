"""Auth HTTP routes.

WorkOS AuthKit hosted flow:
  GET  /auth/authorize  -> 302 to AuthKit
  GET  /auth/callback   -> exchanges `code` for tokens
  POST /auth/refresh    -> refreshes access token
  POST /auth/logout     -> returns AuthKit logout URL

Plus the dev-only:
  POST /auth/dev-token  -> mints a JWT verifiable by WorkOSAuthProvider's
                            dev path. Hard-404 in production.

Routes here intentionally use no auth dependency — they ARE the auth.
The dev-token endpoint is gated on `settings.environment != "production"`
and 404s otherwise. Tests cover both branches.
"""

from __future__ import annotations

import logging
import secrets
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from workos import AsyncWorkOSClient

from meeting_intelligence.api.deps import get_session_factory
from meeting_intelligence.auth.workos_provider import mint_dev_token
from meeting_intelligence.config import Settings, get_settings

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("meeting_intelligence.auth")


# --- WorkOS client wiring ----------------------------------------------------


def get_workos_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncWorkOSClient:
    """Build the AsyncWorkOSClient for the request.

    Cheap to construct (just stores config); avoids module-level globals
    so tests can override or skip the dep cleanly.
    """
    if not settings.workos_api_key or not settings.workos_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WorkOS is not configured",
        )
    return AsyncWorkOSClient(
        api_key=settings.workos_api_key,
        client_id=settings.workos_client_id,
    )


# --- Routes ------------------------------------------------------------------


@router.get("/authorize")
async def authorize(
    settings: Annotated[Settings, Depends(get_settings)],
    workos: Annotated[AsyncWorkOSClient, Depends(get_workos_client)],
    state: str | None = None,
) -> RedirectResponse:
    """Redirect to AuthKit. Caller may pass `state` for CSRF protection.

    The desktop client opens this URL in the system browser. AuthKit
    presents email/password + Google sign-in and on success redirects
    back to `workos_redirect_uri` (typically a localhost loopback
    intercepted by the Tauri shell) with `?code=...&state=...`.
    """
    redirect_uri = settings.workos_redirect_uri
    if not redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="workos_redirect_uri is not configured",
        )
    state = state or secrets.token_urlsafe(16)
    url = workos.user_management.get_authorization_url(
        provider="authkit",
        redirect_uri=redirect_uri,
        state=state,
    )
    return RedirectResponse(url=url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


class TokenResponse(BaseModel):
    accessToken: str
    refreshToken: str | None = None
    user: dict[str, Any]


@router.get("/callback", response_model=TokenResponse)
async def callback(
    code: str,
    workos: Annotated[AsyncWorkOSClient, Depends(get_workos_client)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
) -> TokenResponse:
    """Exchange the AuthKit `code` for an access+refresh token pair.

    Returns the raw WorkOS response shape; the desktop client stores
    these in the OS credential store. The HTTP body is intentionally
    JSON (not a redirect) so the desktop's loopback interceptor can
    parse it without re-following.

    Side effect: provisions the local `users` row via `auth.upsert_user`
    so subsequent authed requests (which only carry `sub` in the JWT —
    AuthKit access tokens do not include `email`) can resolve the
    caller via `auth.lookup_user_by_workos_id`.
    """
    try:
        result = await workos.user_management.authenticate_with_code(code=code)
    except Exception as exc:
        log.info("auth.callback_failed reason=%s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    workos_user_id = result.user.id
    email = getattr(result.user, "email", None)
    if not email:
        # WorkOS guarantees email on User; surface clearly if it ever
        # comes back missing rather than INSERT-ing NULL into a NOT NULL
        # column and 500-ing the request.
        log.info("auth.callback_missing_email workos_user_id=%s", workos_user_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="WorkOS user record missing email",
        )

    async with session_factory() as session:
        try:
            await session.execute(
                text(
                    "SELECT id FROM auth.upsert_user(:wid, :email, NULL)"
                ),
                {"wid": workos_user_id, "email": email},
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return TokenResponse(
        accessToken=result.access_token,
        refreshToken=cast(str | None, getattr(result, "refresh_token", None)),
        user=_user_dict(result.user),
    )


class RefreshRequest(BaseModel):
    refreshToken: str = Field(min_length=1)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    workos: Annotated[AsyncWorkOSClient, Depends(get_workos_client)],
) -> TokenResponse:
    try:
        result = await workos.user_management.authenticate_with_refresh_token(
            refresh_token=body.refreshToken,
        )
    except Exception as exc:
        log.info("auth.refresh_failed reason=%s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    return TokenResponse(
        accessToken=result.access_token,
        refreshToken=cast(str | None, getattr(result, "refresh_token", None)),
        user=_user_dict(result.user),
    )


class LogoutResponse(BaseModel):
    logoutUrl: str


@router.post("/logout", response_model=LogoutResponse)
async def logout(
    workos: Annotated[AsyncWorkOSClient, Depends(get_workos_client)],
    sessionId: str | None = None,
) -> LogoutResponse:
    """Return the AuthKit logout URL the desktop should open.

    WorkOS doesn't revoke tokens server-side from a "logout" call;
    instead it ends the AuthKit session (so any session-bound
    refresh tokens stop minting new access tokens). The desktop
    deletes its locally-cached tokens after this.
    """
    if not sessionId:
        # No session id — best we can do is hand back AuthKit's plain
        # sign-out URL with a redirect to the home origin.
        return LogoutResponse(logoutUrl=workos.user_management.get_logout_url(""))
    return LogoutResponse(logoutUrl=workos.user_management.get_logout_url(sessionId))


# --- Dev-only token issuer ---------------------------------------------------


class DevTokenRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    workosUserId: str | None = None
    organizationId: str | None = None
    ttlSeconds: int = Field(default=86400, ge=1, le=86400 * 7)


class DevTokenResponse(BaseModel):
    accessToken: str


@router.post("/dev-token", response_model=DevTokenResponse)
async def dev_token(
    body: DevTokenRequest,
    settings: Annotated[Settings, Depends(get_settings)],
) -> DevTokenResponse:
    """Mint a JWT the WorkOSAuthProvider accepts under its dev `kid`.

    Returns 404 in production. Used by integration tests + curl smoke
    runs so we don't have to drive the AuthKit browser flow to get a
    valid bearer.
    """
    if settings.environment == "production":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if not settings.dev_jwt_signing_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DEV_JWT_SIGNING_KEY is not configured",
        )

    workos_user_id = body.workosUserId or f"dev_{body.email}"
    token = mint_dev_token(
        settings=settings,
        workos_user_id=workos_user_id,
        email=str(body.email),
        organization_id=body.organizationId,
        ttl_seconds=body.ttlSeconds,
    )
    return DevTokenResponse(accessToken=token)


# --- helpers ------------------------------------------------------------------


def _user_dict(user: Any) -> dict[str, Any]:
    """Best-effort serialise a WorkOS User dataclass into a JSON-safe dict.

    The SDK returns Pydantic-ish dataclasses depending on the version.
    `model_dump` works for the v5+ Pydantic models; `__dict__` is the
    universal fallback.
    """
    dump = getattr(user, "model_dump", None)
    if callable(dump):
        return cast(dict[str, Any], dump())
    return dict(user.__dict__)
