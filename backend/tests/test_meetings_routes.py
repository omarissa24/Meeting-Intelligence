"""Integration tests for /meetings routes — happy paths + auth + RLS isolation.

These tests need a real Postgres (skip cleanly without `TEST_DATABASE_URL`)
and they wire up a fresh FastAPI app per test with the auth + DB
dependencies overridden to point at the conftest's ephemeral test DB.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from meeting_intelligence.api.deps import get_auth_provider, get_session_factory
from meeting_intelligence.auth.workos_provider import WorkOSAuthProvider, mint_dev_token
from meeting_intelligence.config import Settings
from meeting_intelligence.main import create_app


@pytest.fixture
def dev_settings() -> Settings:
    return Settings(environment="development", dev_jwt_signing_key="x" * 64)


@pytest.fixture
def app(
    db_session_factory: async_sessionmaker[AsyncSession],
    dev_settings: Settings,
) -> FastAPI:
    app = create_app()
    app.dependency_overrides[get_session_factory] = lambda: db_session_factory
    app.dependency_overrides[get_auth_provider] = lambda: WorkOSAuthProvider(dev_settings)
    return app


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _bearer(settings: Settings, *, email: str, sub: str) -> str:
    return "Bearer " + mint_dev_token(
        settings=settings, workos_user_id=sub, email=email
    )


# --- Auth gate ---------------------------------------------------------------


def test_meetings_list_requires_auth(client: TestClient) -> None:
    r = client.get("/meetings")
    assert r.status_code == 401


def test_meeting_create_requires_auth(client: TestClient) -> None:
    r = client.post("/meetings", json={"title": "x"})
    assert r.status_code == 401


# --- Happy paths -------------------------------------------------------------


def test_create_meeting_happy_path(client: TestClient, dev_settings: Settings) -> None:
    auth = _bearer(dev_settings, email="alice@test.dev", sub="user_alice")
    r = client.post(
        "/meetings",
        json={"title": "Standup", "tags": ["weekly", "team-a"]},
        headers={"Authorization": auth},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "Standup"
    assert body["tags"] == ["weekly", "team-a"]
    assert body["status"] == "recording"
    assert body["startedAt"] is not None
    assert body["endedAt"] is None


def test_get_meeting_returns_segments_only_finals(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="bob@test.dev", sub="user_bob")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()

    # The route returns segments=[] when none have been written; we
    # don't drive the WS here — that's covered in test_transcript_ws_persistence.
    r = client.get(f"/meetings/{created['id']}", headers={"Authorization": auth})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == created["id"]
    assert body["segments"] == []


def test_list_meetings_paginates_newest_first(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="carol@test.dev", sub="user_carol")
    titles = [f"M-{i}" for i in range(5)]
    for t in titles:
        r = client.post("/meetings", json={"title": t}, headers={"Authorization": auth})
        assert r.status_code == 201

    r = client.get("/meetings?limit=3", headers={"Authorization": auth})
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 3
    # Newest first → reverse insertion order.
    assert [m["title"] for m in body["items"]] == ["M-4", "M-3", "M-2"]
    assert body["nextCursor"] is not None

    r2 = client.get(
        f"/meetings?limit=3&cursor={body['nextCursor']}",
        headers={"Authorization": auth},
    )
    assert r2.status_code == 200
    body2 = r2.json()
    titles2 = [m["title"] for m in body2["items"]]
    assert titles2 == ["M-1", "M-0"]
    assert body2["nextCursor"] is None


def test_list_meetings_filters_by_tag(
    client: TestClient, dev_settings: Settings
) -> None:
    """Phase 4 / FR-4.05: tag filter narrows the list. Cursor is unchanged."""
    auth = _bearer(dev_settings, email="filter@test.dev", sub="user_filter")
    # Create three meetings with different tag sets.
    a = client.post(
        "/meetings",
        json={"title": "Finance", "tags": ["finance"]},
        headers={"Authorization": auth},
    ).json()
    b = client.post(
        "/meetings",
        json={"title": "Product", "tags": ["product"]},
        headers={"Authorization": auth},
    ).json()
    c = client.post(
        "/meetings",
        json={"title": "Mixed", "tags": ["finance", "ops"]},
        headers={"Authorization": auth},
    ).json()
    _ = (a, b, c)

    # No filter → all three present.
    r = client.get("/meetings", headers={"Authorization": auth})
    assert r.status_code == 200
    titles = {m["title"] for m in r.json()["items"]}
    assert titles == {"Finance", "Product", "Mixed"}

    # Filter by `finance` → Finance + Mixed.
    r = client.get("/meetings?tags=finance", headers={"Authorization": auth})
    assert r.status_code == 200
    titles = {m["title"] for m in r.json()["items"]}
    assert titles == {"Finance", "Mixed"}

    # Filter by both `ops` and `product` (overlap, not all) → Mixed + Product.
    r = client.get(
        "/meetings?tags=ops&tags=product", headers={"Authorization": auth}
    )
    assert r.status_code == 200
    titles = {m["title"] for m in r.json()["items"]}
    assert titles == {"Mixed", "Product"}


def test_list_meetings_accepts_filter_params_without_error(
    client: TestClient, dev_settings: Settings
) -> None:
    """Sanity that the new filter params parse and don't 5xx.

    The actual SQL semantics are covered by the search route tests
    (which seed real durations / dates / tags into the test DB).
    Here we only check that the route accepts the params and returns
    the empty-list shape when nothing matches.
    """
    auth = _bearer(dev_settings, email="qparams@test.dev", sub="user_qparams")
    r = client.get(
        "/meetings"
        "?date_start=2025-01-01"
        "&date_end=2025-12-31"
        "&duration_min_seconds=60"
        "&duration_max_seconds=86400"
        "&tags=alpha&tags=beta",
        headers={"Authorization": auth},
    )
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []


def test_patch_meeting_updates_title_and_tags(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="d@test.dev", sub="user_d")
    created = client.post(
        "/meetings", json={"title": "old"}, headers={"Authorization": auth}
    ).json()

    r = client.patch(
        f"/meetings/{created['id']}",
        json={"title": "new", "tags": ["finance", "q3"]},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "new"
    assert body["tags"] == ["finance", "q3"]


def test_patch_validates_tag_count(client: TestClient, dev_settings: Settings) -> None:
    auth = _bearer(dev_settings, email="e@test.dev", sub="user_e")
    created = client.post("/meetings", json={}, headers={"Authorization": auth}).json()

    too_many = [f"t-{i}" for i in range(20)]
    r = client.patch(
        f"/meetings/{created['id']}",
        json={"tags": too_many},
        headers={"Authorization": auth},
    )
    assert r.status_code == 422


# --- Cross-user isolation (RLS) ---------------------------------------------


def test_user_b_cannot_read_user_a_meeting(
    client: TestClient, dev_settings: Settings
) -> None:
    auth_a = _bearer(dev_settings, email="a@test.dev", sub="user_a_iso")
    auth_b = _bearer(dev_settings, email="b@test.dev", sub="user_b_iso")

    a_meeting = client.post(
        "/meetings", json={"title": "A's secret"}, headers={"Authorization": auth_a}
    ).json()

    # B's GET on A's meeting → 404 (RLS makes it disappear, not 403)
    r = client.get(f"/meetings/{a_meeting['id']}", headers={"Authorization": auth_b})
    assert r.status_code == 404

    # B's PATCH on A's meeting → 404
    r = client.patch(
        f"/meetings/{a_meeting['id']}",
        json={"title": "hijack"},
        headers={"Authorization": auth_b},
    )
    assert r.status_code == 404

    # B's list does not include A's meeting
    r = client.get("/meetings", headers={"Authorization": auth_b})
    assert r.status_code == 200
    titles = [m["title"] for m in r.json()["items"]]
    assert "A's secret" not in titles


def test_get_meeting_invalid_uuid_404(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="f@test.dev", sub="user_f")
    r = client.get("/meetings/not-a-uuid", headers={"Authorization": auth})
    # FastAPI returns 422 for an unparseable path UUID.
    assert r.status_code in (404, 422)


# --- Speaker aliases (US-26 / FR-4.10 / FR-4.11) -----------------------------


def test_put_speaker_aliases_replace_all(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="spk@test.dev", sub="user_spk")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()
    mid = created["id"]

    # Empty by default.
    r = client.get(f"/meetings/{mid}", headers={"Authorization": auth})
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {}

    # PUT a couple of aliases.
    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {"spk-0": "Omar", "spk-1": "Priya"}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["speakerAliases"] == {"spk-0": "Omar", "spk-1": "Priya"}

    # Replace-all: PUT a new map drops the unmentioned keys.
    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {"spk-0": "Omar Issa"}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {"spk-0": "Omar Issa"}

    # Empty body clears everything.
    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {}


def test_put_speaker_aliases_drops_blank_values(
    client: TestClient, dev_settings: Settings
) -> None:
    """Empty / whitespace display name = "clear this alias"."""
    auth = _bearer(dev_settings, email="spk2@test.dev", sub="user_spk2")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()
    mid = created["id"]

    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {"spk-0": "Omar", "spk-1": "  ", "spk-2": ""}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {"spk-0": "Omar"}


def test_put_speaker_aliases_validates_length(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="spk3@test.dev", sub="user_spk3")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()
    mid = created["id"]

    too_long = "x" * 33
    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {"spk-0": too_long}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 422


def test_put_speaker_aliases_rejects_too_many(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="spk4@test.dev", sub="user_spk4")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()
    mid = created["id"]

    aliases = {f"spk-{i}": f"name-{i}" for i in range(33)}
    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": aliases},
        headers={"Authorization": auth},
    )
    assert r.status_code == 422


def test_put_speaker_aliases_trims_whitespace(
    client: TestClient, dev_settings: Settings
) -> None:
    auth = _bearer(dev_settings, email="spk5@test.dev", sub="user_spk5")
    created = client.post(
        "/meetings", json={"title": "M"}, headers={"Authorization": auth}
    ).json()
    mid = created["id"]

    r = client.put(
        f"/meetings/{mid}/speaker_aliases",
        json={"aliases": {"spk-0": "  Omar  "}},
        headers={"Authorization": auth},
    )
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {"spk-0": "Omar"}


def test_put_speaker_aliases_rls_isolation(
    client: TestClient, dev_settings: Settings
) -> None:
    auth_a = _bearer(dev_settings, email="spk_a@test.dev", sub="user_spk_a")
    auth_b = _bearer(dev_settings, email="spk_b@test.dev", sub="user_spk_b")

    a_meeting = client.post(
        "/meetings", json={"title": "A's secret"}, headers={"Authorization": auth_a}
    ).json()

    # B can't read or write A's aliases — RLS makes the meeting invisible.
    r = client.put(
        f"/meetings/{a_meeting['id']}/speaker_aliases",
        json={"aliases": {"spk-0": "hijack"}},
        headers={"Authorization": auth_b},
    )
    assert r.status_code == 404

    # A's aliases stay empty.
    r = client.get(f"/meetings/{a_meeting['id']}", headers={"Authorization": auth_a})
    assert r.status_code == 200
    assert r.json()["speakerAliases"] == {}


def test_speaker_aliases_requires_auth(client: TestClient) -> None:
    # PUT without auth — 401, never even hits the meeting lookup.
    r = client.put(
        "/meetings/00000000-0000-0000-0000-000000000000/speaker_aliases",
        json={"aliases": {}},
    )
    assert r.status_code == 401
