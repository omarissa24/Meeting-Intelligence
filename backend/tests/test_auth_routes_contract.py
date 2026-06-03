"""Contract pins for the WorkOS auth HTTP routes.

These tests don't exercise the real WorkOS SDK (that's an integration
concern). Instead they fix the *desktop-facing contract* of each
route, so a future refactor of `api/auth.py` can't silently break the
Tauri client:

  * GET /auth/authorize redirects to a WorkOS-issued URL (307); the
    `state` we passed must round-trip in the redirect target.
  * GET /auth/callback returns JSON with `accessToken` /
    `refreshToken` / `user` keys — NOT a redirect. The Tauri deep-link
    handler parses this body verbatim.
  * POST /auth/refresh accepts `{refreshToken}` and returns the same
    TokenResponse shape.
  * POST /auth/logout returns `{logoutUrl: <string>}`.

The WorkOS client is stubbed via FastAPI's dependency override system
so each test can pin behavior without standing up real credentials.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from meeting_intelligence.api.auth import get_workos_client
from meeting_intelligence.api.deps import get_session_factory
from meeting_intelligence.config import Settings, get_settings
from meeting_intelligence.main import app


class _StubAuth:
    """Minimal stand-in for `workos.user_management`."""

    def __init__(self) -> None:
        self.last_state: str | None = None

    def get_authorization_url(
        self,
        *,
        provider: str,
        redirect_uri: str,
        state: str,
    ) -> str:
        # Persist the state so the redirect-roundtrip test can assert
        # the route actually passes it through, and return a
        # WorkOS-shaped URL that includes the same state.
        self.last_state = state
        return (
            f"https://api.workos.com/user_management/authorize?"
            f"client_id=test&redirect_uri={redirect_uri}&state={state}"
        )

    async def authenticate_with_code(self, *, code: str) -> Any:
        return _AuthResult(
            access_token=f"access-{code}",
            refresh_token=f"refresh-{code}",
            user={"id": "user_test", "email": "alice@example.com"},
        )

    async def authenticate_with_refresh_token(self, *, refresh_token: str) -> Any:
        # Surface a rotated refresh token so the desktop's
        # re-store-after-refresh path is exercised.
        return _AuthResult(
            access_token="access-rotated",
            refresh_token=f"{refresh_token}-rotated",
            user={"id": "user_test", "email": "alice@example.com"},
        )

    def get_logout_url(self, session_id: str) -> str:
        return f"https://api.workos.com/user_management/logout?session_id={session_id}"


class _AuthResult:
    def __init__(
        self, access_token: str, refresh_token: str | None, user: dict[str, Any]
    ) -> None:
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.user = _UserModel(user)


class _UserModel:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data
        # Expose the core fields the callback handler reads via attribute
        # access (`result.user.id`, `result.user.email`) — the real WorkOS
        # SDK returns a Pydantic model where those are real attributes.
        self.id = data.get("id")
        self.email = data.get("email")

    def model_dump(self) -> dict[str, Any]:
        return dict(self._data)


class _StubClient:
    """Stand-in matching the small surface `auth.py` uses."""

    def __init__(self) -> None:
        self.user_management = _StubAuth()


class _FakeSession:
    """Captures upsert SQL without touching a real DB."""

    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.committed = False

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def execute(self, stmt: Any, params: dict[str, Any] | None = None) -> Any:
        # str(stmt) collapses SQLAlchemy `text()` to its raw SQL; we
        # only care that the upsert was issued.
        self.executed.append((str(stmt), params or {}))

        class _Row:
            def __init__(self, data: dict[str, Any]) -> None:
                self.id = data.get("id", "fake-id")

        # The route only reads `.execute(...)` for side effect; mimic the
        # `Result` API shallowly so `await session.execute(...).scalar()`
        # would not blow up if added later.
        class _Result:
            def scalar(self) -> str:
                return "fake-id"

            def one(self) -> _Row:
                return _Row({"id": "fake-id"})

        return _Result()

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        return None


def _fake_session_factory() -> Any:
    """Match `async_sessionmaker[AsyncSession]`'s call shape."""
    return _FakeSession()


@pytest.fixture
def client() -> TestClient:
    stub = _StubClient()
    app.dependency_overrides[get_workos_client] = lambda: stub
    app.dependency_overrides[get_session_factory] = lambda: _fake_session_factory
    # Pin redirect_uri so the desktop deep-link contract is real.
    settings = Settings(
        workos_api_key="sk_test",
        workos_client_id="client_test",
        workos_redirect_uri="meeting-intelligence://auth/callback",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        yield TestClient(app, follow_redirects=False)
    finally:
        app.dependency_overrides.pop(get_workos_client, None)
        app.dependency_overrides.pop(get_session_factory, None)
        app.dependency_overrides.pop(get_settings, None)


def test_authorize_redirects_with_state_roundtripped(client: TestClient) -> None:
    resp = client.get("/auth/authorize", params={"state": "csrf-nonce-abc"})
    assert resp.status_code == 307
    location = resp.headers["location"]
    assert "state=csrf-nonce-abc" in location
    assert "redirect_uri=meeting-intelligence%3A%2F%2Fauth%2Fcallback" in location or (
        "redirect_uri=meeting-intelligence://auth/callback" in location
    )


def test_callback_returns_json_not_redirect(client: TestClient) -> None:
    resp = client.get("/auth/callback", params={"code": "the-code"})
    assert resp.status_code == 200
    body = resp.json()
    # The desktop's `TokenResponse` deserializer keys off these exact
    # field names — pin them so a refactor can't silently break it.
    assert set(body.keys()) >= {"accessToken", "refreshToken", "user"}
    assert body["accessToken"] == "access-the-code"
    assert body["refreshToken"] == "refresh-the-code"
    assert body["user"]["email"] == "alice@example.com"


def test_refresh_accepts_refreshToken_payload_and_returns_rotated(
    client: TestClient,
) -> None:
    resp = client.post("/auth/refresh", json={"refreshToken": "old-rt"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["accessToken"] == "access-rotated"
    # WorkOS rotates the refresh token; the contract is that the
    # desktop must re-store whatever comes back.
    assert body["refreshToken"] == "old-rt-rotated"


def test_refresh_rejects_empty_payload(client: TestClient) -> None:
    resp = client.post("/auth/refresh", json={})
    # 422 is FastAPI's standard "missing required field" — pin so we
    # don't accidentally degrade to a 500 or a silent default.
    assert resp.status_code == 422


def test_logout_returns_logoutUrl(client: TestClient) -> None:
    resp = client.post("/auth/logout", params={"sessionId": "sess_xyz"})
    assert resp.status_code == 200
    body = resp.json()
    assert "logoutUrl" in body
    assert body["logoutUrl"].startswith("https://api.workos.com/")
