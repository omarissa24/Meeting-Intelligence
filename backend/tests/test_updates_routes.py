"""GET /updates/{target}/{arch}/{current_version} — route contract tests.

Covers the full Tauri-updater response matrix against the fake release
source via dependency overrides:

  - strictly newer release → 200 with the Tauri payload shape
  - equal or older release (downgrade attempt) → 204
  - unknown platform key → 204
  - no published release at all → 204
  - malformed current_version → 400
  - leading-`v` versions tolerated on both sides
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from meeting_intelligence.api.deps import get_release_source
from meeting_intelligence.api.updates import parse_semver
from meeting_intelligence.interfaces.releases import (
    PlatformEntry,
    ReleaseManifest,
    ReleaseSource,
)
from meeting_intelligence.main import create_app
from meeting_intelligence.releases.fake import InMemoryFakeReleaseSource


def _manifest(version: str) -> ReleaseManifest:
    return ReleaseManifest(
        version=version,
        pub_date=datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC),
        notes="bug fixes",
        platforms={
            "darwin-aarch64": PlatformEntry(
                url="https://example.com/marens.app.tar.gz",
                signature="c2lnbmF0dXJl",
            ),
            "windows-x86_64": PlatformEntry(
                url="https://example.com/marens.msi",
                signature="c2lnbmF0dXJlLXdpbg==",
            ),
        },
    )


@pytest.fixture
def fake_source() -> InMemoryFakeReleaseSource:
    return InMemoryFakeReleaseSource()


@pytest.fixture
def client(fake_source: ReleaseSource) -> Iterator[TestClient]:
    app = create_app()
    app.dependency_overrides[get_release_source] = lambda: fake_source
    with TestClient(app) as test_client:
        yield test_client


def test_newer_release_returns_tauri_payload(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    resp = client.get("/updates/darwin/aarch64/1.1.9")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "1.2.0"
    assert body["url"] == "https://example.com/marens.app.tar.gz"
    assert body["signature"] == "c2lnbmF0dXJl"
    assert body["notes"] == "bug fixes"
    assert body["pub_date"].startswith("2026-06-01T12:00:00")


def test_windows_platform_resolves_its_own_entry(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    resp = client.get("/updates/windows/x86_64/1.0.0")
    assert resp.status_code == 200
    assert resp.json()["url"] == "https://example.com/marens.msi"


def test_equal_version_is_204(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    assert client.get("/updates/darwin/aarch64/1.2.0").status_code == 204


def test_older_release_is_204_downgrade_protection(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    assert client.get("/updates/darwin/aarch64/2.0.0").status_code == 204


def test_unknown_platform_is_204(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    assert client.get("/updates/linux/x86_64/1.0.0").status_code == 204


def test_no_release_is_204(client: TestClient) -> None:
    assert client.get("/updates/darwin/aarch64/1.0.0").status_code == 204


def test_malformed_current_version_is_400(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("1.2.0")
    assert client.get("/updates/darwin/aarch64/not-a-version").status_code == 400
    assert client.get("/updates/darwin/aarch64/1.2").status_code == 400
    assert client.get("/updates/darwin/aarch64/1.2.3.4").status_code == 400


def test_v_prefixed_versions_tolerated(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("v1.2.0")
    resp = client.get("/updates/darwin/aarch64/v1.1.0")
    assert resp.status_code == 200
    assert resp.json()["version"] == "v1.2.0"


def test_malformed_manifest_version_degrades_to_204(
    client: TestClient, fake_source: InMemoryFakeReleaseSource
) -> None:
    fake_source.manifest = _manifest("latest")
    assert client.get("/updates/darwin/aarch64/1.0.0").status_code == 204


def test_parse_semver_rules() -> None:
    assert parse_semver("1.2.3") == (1, 2, 3)
    assert parse_semver("v10.0.1") == (10, 0, 1)
    for bad in ("1.2", "1.2.3.4", "1.2.x", "1.-2.3", "1.2.3-beta", ""):
        with pytest.raises(ValueError):
            parse_semver(bad)
