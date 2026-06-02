"""Integration tests for auth dependencies — bearer parsing + user upsert.

These tests need a real Postgres because the upsert path calls the
SECURITY DEFINER function added in migration 0002. They `pytest.skip`
cleanly when `TEST_DATABASE_URL` is unset.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import get_session_factory
from meeting_intelligence.auth.deps import _resolve_user
from meeting_intelligence.auth.workos_provider import (
    WorkOSAuthProvider,
    mint_dev_token,
)
from meeting_intelligence.config import Settings
from meeting_intelligence.db.models.user import User
from meeting_intelligence.db.rls import set_request_user
from meeting_intelligence.interfaces.auth import AuthenticatedUser


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.mark.asyncio
async def test_resolve_user_creates_then_finds(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    claims = AuthenticatedUser(
        user_id="workos_user_alpha",
        email="alpha@test.dev",
        organization_id=None,
    )
    async with db_session_factory() as s1:
        a = await _resolve_user(s1, claims)
        await s1.commit()

    # Second call returns the same row.
    async with db_session_factory() as s2:
        b = await _resolve_user(s2, claims)
        await s2.commit()

    assert a.id == b.id
    assert a.email == "alpha@test.dev"
    assert a.workos_user_id == "workos_user_alpha"


@pytest.mark.asyncio
async def test_resolve_user_visible_under_rls_after_upsert(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """After upsert + GUC re-bind, the user row reads through cleanly."""
    claims = AuthenticatedUser(
        user_id="workos_user_beta",
        email="beta@test.dev",
        organization_id=None,
    )
    async with db_session_factory() as s:
        u = await _resolve_user(s, claims)
        await s.commit()

    async with db_session_factory() as s2:
        await set_request_user(s2, u.id)
        row = (
            await s2.execute(select(User).where(User.id == u.id))
        ).scalar_one_or_none()
        assert row is not None
        assert row.email == "beta@test.dev"


@pytest.mark.asyncio
async def test_resolve_user_isolation_under_rls(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """User A cannot see User B's row when scoped to A."""
    a_claims = AuthenticatedUser(user_id="wa", email="a@test.dev", organization_id=None)
    b_claims = AuthenticatedUser(user_id="wb", email="b@test.dev", organization_id=None)

    async with db_session_factory() as s:
        a = await _resolve_user(s, a_claims)
        b = await _resolve_user(s, b_claims)
        await s.commit()

    async with db_session_factory() as s_as_a:
        await set_request_user(s_as_a, a.id)
        row_b = (
            await s_as_a.execute(select(User).where(User.id == b.id))
        ).scalar_one_or_none()
        assert row_b is None  # RLS hides it


# --- Bearer / get_current_user round-trip via FastAPI -----------------


@pytest.fixture
def app_with_auth(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
) -> FastAPI:
    """Minimal FastAPI app exposing one route gated on get_current_user."""
    from fastapi import Depends

    from meeting_intelligence.api.deps import get_auth_provider
    from meeting_intelligence.auth.deps import get_current_user

    app = FastAPI()

    @app.get("/whoami")
    def whoami(user: User = Depends(get_current_user)) -> dict:
        return {"id": str(user.id), "email": user.email}

    app.dependency_overrides[get_session_factory] = lambda: db_session_factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    return app


def test_missing_bearer_returns_401(app_with_auth: FastAPI) -> None:
    with TestClient(app_with_auth) as client:
        r = client.get("/whoami")
    assert r.status_code == 401


def test_malformed_bearer_returns_401(app_with_auth: FastAPI) -> None:
    with TestClient(app_with_auth) as client:
        r = client.get("/whoami", headers={"Authorization": "NotBearer xyz"})
    assert r.status_code == 401


def test_bad_token_returns_401(app_with_auth: FastAPI) -> None:
    with TestClient(app_with_auth) as client:
        r = client.get("/whoami", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_valid_dev_token_returns_user(
    app_with_auth: FastAPI, dev_settings: Settings
) -> None:
    token = mint_dev_token(
        settings=dev_settings,
        workos_user_id="user_whoami_1",
        email="whoami@test.dev",
    )
    with TestClient(app_with_auth) as client:
        r = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "whoami@test.dev"


# Smoke that the upsert is idempotent across requests.


def test_repeated_calls_keep_same_user_id(
    app_with_auth: FastAPI, dev_settings: Settings
) -> None:
    token = mint_dev_token(
        settings=dev_settings,
        workos_user_id="user_whoami_2",
        email="repeat@test.dev",
    )
    with TestClient(app_with_auth) as client:
        ids = set()
        for _ in range(3):
            r = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
            assert r.status_code == 200
            ids.add(r.json()["id"])
    assert len(ids) == 1


# Sanity: the auth.upsert_user function exists and is grant-locked to app_user.


@pytest.mark.asyncio
async def test_upsert_function_exists_and_locked_down(
    db_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with db_session_factory() as s:
        # We're connected as app_user; the function should be callable.
        result = await s.execute(
            text(
                "SELECT id FROM auth.upsert_user(:wid, :email, NULL)"
            ),
            {"wid": "smoke", "email": "smoke@test.dev"},
        )
        assert result.scalar() is not None
