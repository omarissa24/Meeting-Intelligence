"""WorkOS AuthKit provider.

Verifies WorkOS access tokens (RS256, signed by WorkOS's JWKS) and —
in non-production environments only — also accepts dev tokens minted
by `POST /auth/dev-token` (HS256, signed by `DEV_JWT_SIGNING_KEY`).
The two paths share a verifier so route code never branches on
"is this a real or dev token".

The dev path uses a distinct `kid = dev` so a leaked dev secret can
never validate as a real WorkOS token: the JWKS lookup keys off `kid`
and the dev branch only activates when `environment != 'production'`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import jwt
from jwt import PyJWKClient

from meeting_intelligence.config import Settings
from meeting_intelligence.interfaces.auth import AuthenticatedUser, AuthProvider

log = logging.getLogger("meeting_intelligence.auth")


DEV_KID = "dev"
DEV_ISSUER = "meeting-intelligence-dev"


class TokenVerificationError(Exception):
    """Raised when a token is missing, malformed, expired, or signed by an unknown key."""


def _default_jwks_url(client_id: str) -> str:
    return f"https://api.workos.com/sso/jwks/{client_id}"


def _default_issuer(client_id: str) -> str:
    """Issuer claim WorkOS AuthKit (User Management) puts on access tokens.

    Each WorkOS client gets its own issuer URL of the form
    `https://api.workos.com/user_management/<client_id>`, so the issuer
    is fully determined by the client_id and we can derive it at boot
    rather than asking operators to set a redundant env var. Override
    via `WORKOS_JWT_ISSUER` only if WorkOS publishes a new issuer
    convention.
    """
    return f"https://api.workos.com/user_management/{client_id}"


class WorkOSAuthProvider(AuthProvider):
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._jwks_client: PyJWKClient | None = None
        self._jwks_lock = asyncio.Lock()

    # --- AuthProvider interface ----------------------------------------

    async def verify_token(self, token: str) -> AuthenticatedUser:
        try:
            unverified_header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise TokenVerificationError(f"malformed token header: {exc}") from exc

        alg = unverified_header.get("alg")
        kid = unverified_header.get("kid")

        # Dev path: HS256 + kid="dev". Hard-gated by environment so a leaked
        # dev secret cannot be used in production even if it makes it to the
        # request.
        if kid == DEV_KID:
            return self._verify_dev_token(token, alg=alg)

        if alg != "RS256":
            raise TokenVerificationError(f"unsupported alg: {alg!r}")

        return await self._verify_workos_token(token, kid=kid)

    async def start_sso(self, organization_id: str, redirect_uri: str) -> str:
        # SSO/SAML hand-off lands in the Phase-5 desktop slice. The HTTP
        # /auth/authorize route already builds AuthKit URLs through the
        # WorkOS SDK directly; this method exists only to satisfy the
        # interface and gives a single seam to extend later.
        raise NotImplementedError("start_sso not implemented; use AuthKit /authorize route")

    # --- internals -----------------------------------------------------

    async def _verify_workos_token(
        self,
        token: str,
        *,
        kid: str | None,
    ) -> AuthenticatedUser:
        if not self._settings.workos_client_id:
            raise TokenVerificationError("workos_client_id is not configured")

        client = await self._get_jwks_client()

        try:
            signing_key = client.get_signing_key_from_jwt(token).key
        except jwt.PyJWKClientError:
            # kid-miss: drop the cache once and retry — handles WorkOS key
            # rotation. PyJWKClient itself does not refresh on miss.
            log.info("auth.jwks_kid_miss kid=%s; refreshing", kid)
            self._jwks_client = None
            client = await self._get_jwks_client()
            try:
                signing_key = client.get_signing_key_from_jwt(token).key
            except jwt.PyJWKClientError as exc2:
                raise TokenVerificationError(
                    f"unknown signing key (kid={kid!r}): {exc2}"
                ) from exc2

        expected_issuer = self._settings.workos_jwt_issuer or _default_issuer(
            self._settings.workos_client_id
        )
        try:
            payload: dict[str, Any] = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                issuer=expected_issuer,
                # AuthKit access tokens omit `aud`; we don't enforce it.
                # `iss`, `exp`, and `nbf` cover the security-critical claims.
                options={"require": ["exp", "iss"], "verify_aud": False},
            )
        except jwt.PyJWTError as exc:
            raise TokenVerificationError(f"workos token rejected: {exc}") from exc

        return _user_from_payload(payload)

    def _verify_dev_token(self, token: str, *, alg: str | None) -> AuthenticatedUser:
        if self._settings.environment == "production":
            raise TokenVerificationError("dev tokens are disabled in production")
        if alg != "HS256":
            raise TokenVerificationError(f"dev token alg must be HS256, got {alg!r}")

        signing_key = self._settings.dev_jwt_signing_key
        if not signing_key:
            raise TokenVerificationError("dev_jwt_signing_key is not configured")

        try:
            payload = jwt.decode(
                token,
                signing_key,
                algorithms=["HS256"],
                issuer=DEV_ISSUER,
                options={"require": ["exp", "iss"], "verify_aud": False},
            )
        except jwt.PyJWTError as exc:
            raise TokenVerificationError(f"dev token rejected: {exc}") from exc

        return _user_from_payload(payload)

    async def _get_jwks_client(self) -> PyJWKClient:
        if self._jwks_client is not None:
            return self._jwks_client
        async with self._jwks_lock:
            if self._jwks_client is not None:
                return self._jwks_client
            if self._settings.workos_jwks_url:
                url = self._settings.workos_jwks_url
            elif self._settings.workos_client_id:
                url = _default_jwks_url(self._settings.workos_client_id)
            else:
                raise TokenVerificationError(
                    "JWKS URL not configured: set WORKOS_CLIENT_ID or WORKOS_JWKS_URL"
                )
            # PyJWKClient is sync but only does a one-shot HTTP fetch the
            # first time it's used; the cost is bounded and we drop+rebuild
            # on kid-miss above. Doing it under the lock makes the
            # construction itself single-flight.
            self._jwks_client = PyJWKClient(url, cache_keys=True, lifespan=300)
            log.info("auth.jwks_client_built url=%s", url)
            return self._jwks_client


def _user_from_payload(payload: dict[str, Any]) -> AuthenticatedUser:
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise TokenVerificationError("token missing 'sub'")
    # WorkOS AuthKit access tokens omit `email`. Dev tokens minted
    # via /auth/dev-token DO carry it. Either is acceptable here —
    # the local users row was created at /auth/callback time, and
    # `_resolve_user` looks up by `workos_user_id` first.
    email = payload.get("email")
    org = payload.get("organization_id")
    return AuthenticatedUser(
        user_id=sub,
        email=email if isinstance(email, str) and email else None,
        organization_id=org if isinstance(org, str) and org else None,
    )


# --- Dev token minting ------------------------------------------------
#
# Lives next to the verifier so the contract (alg, kid, issuer, claims)
# stays in one file. Only called by `POST /auth/dev-token` in non-prod.


def mint_dev_token(
    *,
    settings: Settings,
    workos_user_id: str,
    email: str,
    organization_id: str | None = None,
    ttl_seconds: int = 60 * 60 * 24,
) -> str:
    if settings.environment == "production":
        raise RuntimeError("dev tokens cannot be minted in production")
    signing_key = settings.dev_jwt_signing_key
    if not signing_key:
        raise RuntimeError("dev_jwt_signing_key is not configured")

    now = int(time.time())
    payload = {
        "sub": workos_user_id,
        "email": email,
        "iss": DEV_ISSUER,
        "iat": now,
        "nbf": now,
        "exp": now + ttl_seconds,
    }
    if organization_id:
        payload["organization_id"] = organization_id
    return jwt.encode(payload, signing_key, algorithm="HS256", headers={"kid": DEV_KID})


__all__ = [
    "DEV_ISSUER",
    "DEV_KID",
    "TokenVerificationError",
    "WorkOSAuthProvider",
    "mint_dev_token",
]
