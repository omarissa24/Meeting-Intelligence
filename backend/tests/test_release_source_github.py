"""GitHubReleaseSource — fetch, cache, and degradation behavior.

All HTTP goes through an injected httpx.MockTransport; no network.

Covers:

  - happy path: releases/latest → latest.json asset → parsed manifest
  - 404 from GitHub (no published releases) → None, not an error
  - TTL cache: a second call inside the TTL window makes zero requests
  - stale-on-error: upstream failure after a successful fetch serves the
    cached manifest instead of raising
  - failure with an empty cache degrades to None (route turns it into 204)
  - release without a latest.json asset → None with a warning
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from meeting_intelligence.releases.github import GitHubReleaseSource

API = "https://api.github.com"
REPO = "acme/marens"

LATEST_JSON = {
    "version": "1.4.0",
    "pub_date": "2026-06-01T12:00:00Z",
    "notes": "release notes",
    "platforms": {
        "darwin-aarch64": {
            "url": "https://github.com/acme/marens/releases/download/v1.4.0/marens.app.tar.gz",
            "signature": "c2ln",
        }
    },
}


class _CountingHandler:
    """MockTransport handler that scripts responses and counts requests."""

    def __init__(self, release_assets: list[dict[str, Any]] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.fail = False
        self.release_404 = False
        assets = (
            release_assets
            if release_assets is not None
            else [
                {
                    "name": "latest.json",
                    "browser_download_url": f"{API}/asset/latest.json",
                }
            ]
        )
        self._release_body = {"tag_name": "v1.4.0", "assets": assets}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail:
            raise httpx.ConnectError("upstream down", request=request)
        if request.url.path.endswith("/releases/latest"):
            if self.release_404:
                return httpx.Response(404)
            return httpx.Response(200, json=self._release_body)
        if request.url.path == "/asset/latest.json":
            return httpx.Response(200, content=json.dumps(LATEST_JSON))
        return httpx.Response(500)


def _source(handler: _CountingHandler, ttl: int = 300) -> GitHubReleaseSource:
    return GitHubReleaseSource(
        repo=REPO,
        cache_ttl_seconds=ttl,
        transport=httpx.MockTransport(handler),
    )


async def test_fetches_and_parses_manifest() -> None:
    handler = _CountingHandler()
    manifest = await _source(handler).latest_release()
    assert manifest is not None
    assert manifest.version == "1.4.0"
    assert manifest.platforms["darwin-aarch64"].signature == "c2ln"
    # One API call + one asset download.
    assert len(handler.requests) == 2


async def test_no_published_release_returns_none() -> None:
    handler = _CountingHandler()
    handler.release_404 = True
    assert await _source(handler).latest_release() is None


async def test_ttl_cache_avoids_refetch() -> None:
    handler = _CountingHandler()
    source = _source(handler, ttl=300)
    first = await source.latest_release()
    second = await source.latest_release()
    assert first is second
    assert len(handler.requests) == 2  # only the initial fetch pair


async def test_stale_manifest_served_on_upstream_failure() -> None:
    handler = _CountingHandler()
    source = _source(handler, ttl=0)  # ttl=0 → every call refetches
    fresh = await source.latest_release()
    assert fresh is not None
    handler.fail = True
    stale = await source.latest_release()
    assert stale is fresh


async def test_failure_with_empty_cache_degrades_to_none() -> None:
    handler = _CountingHandler()
    handler.fail = True
    assert await _source(handler).latest_release() is None


async def test_release_without_manifest_asset_returns_none() -> None:
    handler = _CountingHandler(release_assets=[{"name": "marens.dmg"}])
    assert await _source(handler).latest_release() is None
