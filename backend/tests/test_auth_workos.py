"""Unit tests for the WorkOS auth provider's verify_token path.

The real RS256 path against WorkOS is an integration concern; these
tests cover the parts we own:

  * Dev-token (HS256, kid="dev") happy path.
  * Dev-token rejected when environment="production".
  * Dev-token rejected with bad signature.
  * Dev-token rejected when expired.
  * Token with unknown kid rejected.
  * Token with wrong alg rejected.
  * Missing claims rejected.
"""

from __future__ import annotations

import time

import jwt
import pytest

from meeting_intelligence.auth.workos_provider import (
    DEV_ISSUER,
    DEV_KID,
    TokenVerificationError,
    WorkOSAuthProvider,
    mint_dev_token,
)
from meeting_intelligence.config import Settings


def _settings(env: str = "development", dev_key: str | None = "dev-secret-aaa") -> Settings:
    return Settings(
        environment=env,  # type: ignore[arg-type]
        dev_jwt_signing_key=dev_key,
    )


@pytest.mark.asyncio
async def test_dev_token_happy_path() -> None:
    s = _settings()
    token = mint_dev_token(
        settings=s,
        workos_user_id="user_dev_1",
        email="alice@test.dev",
    )
    provider = WorkOSAuthProvider(s)
    user = await provider.verify_token(token)
    assert user.user_id == "user_dev_1"
    assert user.email == "alice@test.dev"
    assert user.organization_id is None


@pytest.mark.asyncio
async def test_dev_token_carries_organization_id() -> None:
    s = _settings()
    token = mint_dev_token(
        settings=s,
        workos_user_id="user_dev_2",
        email="bob@test.dev",
        organization_id="org_42",
    )
    user = await WorkOSAuthProvider(s).verify_token(token)
    assert user.organization_id == "org_42"


@pytest.mark.asyncio
async def test_dev_token_rejected_in_production() -> None:
    s_dev = _settings()
    token = mint_dev_token(
        settings=s_dev, workos_user_id="x", email="x@test.dev"
    )
    s_prod = Settings(environment="production", dev_jwt_signing_key="dev-secret-aaa")
    with pytest.raises(TokenVerificationError, match="dev tokens are disabled"):
        await WorkOSAuthProvider(s_prod).verify_token(token)


@pytest.mark.asyncio
async def test_dev_token_bad_signature_rejected() -> None:
    s = _settings()
    token = mint_dev_token(settings=s, workos_user_id="x", email="x@test.dev")
    # Flip the last byte of the signature.
    head, body, sig = token.rsplit(".", 2)
    tampered = f"{head}.{body}.{sig[:-1]}{'A' if sig[-1] != 'A' else 'B'}"
    with pytest.raises(TokenVerificationError):
        await WorkOSAuthProvider(s).verify_token(tampered)


@pytest.mark.asyncio
async def test_dev_token_expired_rejected() -> None:
    s = _settings()
    now = int(time.time())
    expired = jwt.encode(
        {
            "sub": "x",
            "email": "x@test.dev",
            "iss": DEV_ISSUER,
            "iat": now - 3600,
            "nbf": now - 3600,
            "exp": now - 1,
        },
        s.dev_jwt_signing_key,
        algorithm="HS256",
        headers={"kid": DEV_KID},
    )
    with pytest.raises(TokenVerificationError):
        await WorkOSAuthProvider(s).verify_token(expired)


@pytest.mark.asyncio
async def test_dev_token_wrong_alg_rejected() -> None:
    s = _settings()
    bogus = jwt.encode(
        {"sub": "x", "email": "x@test.dev", "iss": DEV_ISSUER, "exp": int(time.time()) + 60},
        "irrelevant",
        algorithm="HS512",  # not HS256
        headers={"kid": DEV_KID},
    )
    with pytest.raises(TokenVerificationError, match="dev token alg"):
        await WorkOSAuthProvider(s).verify_token(bogus)


@pytest.mark.asyncio
async def test_unknown_kid_rejected_when_workos_unconfigured() -> None:
    s = _settings()  # workos_client_id is None
    bogus = jwt.encode(
        {"sub": "x", "email": "x@test.dev"},
        "any-secret",
        algorithm="HS256",
        headers={"kid": "some-real-workos-kid"},
    )
    with pytest.raises(TokenVerificationError):
        await WorkOSAuthProvider(s).verify_token(bogus)


@pytest.mark.asyncio
async def test_token_missing_email_rejected() -> None:
    s = _settings()
    now = int(time.time())
    no_email = jwt.encode(
        {"sub": "x", "iss": DEV_ISSUER, "iat": now, "nbf": now, "exp": now + 60},
        s.dev_jwt_signing_key,
        algorithm="HS256",
        headers={"kid": DEV_KID},
    )
    with pytest.raises(TokenVerificationError, match="missing 'email'"):
        await WorkOSAuthProvider(s).verify_token(no_email)


@pytest.mark.asyncio
async def test_malformed_token_rejected() -> None:
    s = _settings()
    with pytest.raises(TokenVerificationError):
        await WorkOSAuthProvider(s).verify_token("not.a.jwt")


@pytest.mark.asyncio
async def test_dev_token_minting_blocked_in_production() -> None:
    s_prod = Settings(environment="production", dev_jwt_signing_key="x")
    with pytest.raises(RuntimeError, match="cannot be minted in production"):
        mint_dev_token(settings=s_prod, workos_user_id="x", email="x@test.dev")
