"""Release source interface (US-24 — self-hosted update manifest).

The desktop Tauri updater polls `GET /updates/{target}/{arch}/{current_version}`
on the backend rather than a third-party host directly — that route is the
"self-hosted update manifest" FR-4.06 requires. The route needs the latest
published release's updater manifest; where that manifest lives (GitHub
Releases for MVP) hides behind `ReleaseSource` so the registry can move
(S3, internal mirror) via config without touching the route.

`ReleaseManifest` mirrors Tauri's `latest.json` shape: one version with a
`platforms` map keyed by `{target}-{arch}` (e.g. `darwin-aarch64`,
`windows-x86_64`), each entry carrying the artifact URL and its minisign
signature from the Tauri signing keypair.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from pydantic import BaseModel


class PlatformEntry(BaseModel):
    """One platform's artifact in a Tauri updater manifest."""

    url: str
    signature: str


class ReleaseManifest(BaseModel):
    """Tauri `latest.json`: a single released version, per-platform artifacts."""

    version: str
    pub_date: datetime | None = None
    notes: str | None = None
    platforms: dict[str, PlatformEntry]


class ReleaseSource(ABC):
    """Latest-release lookup behind the `Settings.updates_provider` seam."""

    @abstractmethod
    async def latest_release(self) -> ReleaseManifest | None:
        """Return the newest published release manifest, or None when there is none."""
        raise NotImplementedError
