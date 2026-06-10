"""In-memory fake release source for tests and simulated-update dev runs.

Tests construct it with a manifest directly. Dev servers get one built
from `Settings.updates_fake_manifest_path` (a local `latest.json`) so the
full desktop update flow — check, download, banner, restart — can be
exercised without publishing a real GitHub release.
"""

from __future__ import annotations

from meeting_intelligence.interfaces.releases import ReleaseManifest, ReleaseSource


class InMemoryFakeReleaseSource(ReleaseSource):
    """Serves whatever manifest it holds; `None` means no release yet."""

    def __init__(self, manifest: ReleaseManifest | None = None) -> None:
        self.manifest = manifest

    async def latest_release(self) -> ReleaseManifest | None:
        return self.manifest
