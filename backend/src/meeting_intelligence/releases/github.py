"""GitHub Releases-backed release source.

Reads the latest *published* release of `Settings.updates_github_repo`
via the GitHub REST API, downloads its `latest.json` asset (produced by
tauri-action with `includeUpdaterJson: true`), and parses it into a
`ReleaseManifest`. Draft releases are invisible to the `releases/latest`
endpoint — publishing the draft is the deliberate go-live gate for both
the website download links and auto-update rollout.

Caching: an in-process TTL cache (default 300 s) bounds GitHub traffic to
~12 requests/hour per machine, well under the unauthenticated 60/hour
rate limit. On fetch failure the previously cached manifest is served
stale (or the failure degrades to "no update" if nothing was ever
cached) — the updater endpoint must never 500 because GitHub hiccuped.
Failures also refresh the cache timestamp so a broken upstream isn't
hammered on every desktop poll.
"""

from __future__ import annotations

import logging
import time

import httpx

from meeting_intelligence.interfaces.releases import ReleaseManifest, ReleaseSource

log = logging.getLogger("meeting_intelligence.releases.github")

MANIFEST_ASSET_NAME = "latest.json"
_REQUEST_TIMEOUT_SECONDS = 10.0


class GitHubReleaseSource(ReleaseSource):
    """`ReleaseSource` over the GitHub `releases/latest` REST endpoint."""

    def __init__(
        self,
        repo: str,
        token: str | None = None,
        cache_ttl_seconds: int = 300,
        api_base_url: str = "https://api.github.com",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._repo = repo
        self._token = token
        self._ttl = cache_ttl_seconds
        self._api_base_url = api_base_url
        # Tests inject an httpx.MockTransport; production leaves this None.
        self._transport = transport
        self._cached: ReleaseManifest | None = None
        self._fetched_at: float | None = None

    async def latest_release(self) -> ReleaseManifest | None:
        now = time.monotonic()
        if self._fetched_at is not None and now - self._fetched_at < self._ttl:
            return self._cached
        try:
            manifest = await self._fetch()
        except Exception:
            log.warning(
                "updates.github_fetch_failed repo=%s serving_stale=%s",
                self._repo,
                self._cached is not None,
                exc_info=True,
            )
            self._fetched_at = now
            return self._cached
        self._cached = manifest
        self._fetched_at = now
        return manifest

    async def _fetch(self) -> ReleaseManifest | None:
        headers = {"Accept": "application/vnd.github+json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        async with httpx.AsyncClient(
            transport=self._transport,
            timeout=_REQUEST_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            resp = await client.get(
                f"{self._api_base_url}/repos/{self._repo}/releases/latest",
                headers=headers,
            )
            if resp.status_code == 404:
                # No published releases yet — normal pre-launch state.
                return None
            resp.raise_for_status()
            release = resp.json()

            asset_url: str | None = None
            for asset in release.get("assets", []):
                if asset.get("name") == MANIFEST_ASSET_NAME:
                    asset_url = asset.get("browser_download_url")
                    break
            if not asset_url:
                log.warning(
                    "updates.manifest_asset_missing repo=%s release=%s",
                    self._repo,
                    release.get("tag_name"),
                )
                return None

            manifest_resp = await client.get(
                asset_url, headers={"Accept": "application/octet-stream"}
            )
            manifest_resp.raise_for_status()
            return ReleaseManifest.model_validate_json(manifest_resp.content)
