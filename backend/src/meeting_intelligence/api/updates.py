"""GET /updates — self-hosted Tauri updater manifest (US-24 / FR-4.06).

The desktop updater polls `/updates/{target}/{arch}/{current_version}`
on launch and every 24 h. Public and unauthenticated by design: the Rust
updater carries no WorkOS JWT, and the manifest is world-readable release
metadata anyway.

Responses follow the Tauri updater protocol:

  - 200 + ``{version, pub_date, url, signature, notes}`` when a strictly
    newer version exists for the requested platform.
  - 204 when there is nothing to do — no published release, unknown
    platform key, or the client is already current. Returning 204 for
    ``latest <= current`` is the server half of downgrade protection;
    the updater plugin enforces the same rule client-side.
  - 400 only for a malformed ``current_version`` (client bug, not state).
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse

from meeting_intelligence.api.deps import get_release_source
from meeting_intelligence.interfaces.releases import ReleaseSource

log = logging.getLogger("meeting_intelligence.api.updates")

router = APIRouter(tags=["updates"])


def parse_semver(version: str) -> tuple[int, int, int]:
    """Parse ``MAJOR.MINOR.PATCH`` (tolerating a leading ``v``) into a tuple.

    Deliberately strict beyond that — no pre-release/build suffixes. Release
    tags are plain semver (`scripts/release-desktop.sh` enforces it), so a
    tiny pure function beats a `packaging` dependency.
    """
    parts = version.removeprefix("v").split(".")
    if len(parts) != 3:
        raise ValueError(f"not a MAJOR.MINOR.PATCH version: {version!r}")
    try:
        major, minor, patch = (int(part) for part in parts)
    except ValueError as exc:
        raise ValueError(f"not a MAJOR.MINOR.PATCH version: {version!r}") from exc
    if min(major, minor, patch) < 0:
        raise ValueError(f"not a MAJOR.MINOR.PATCH version: {version!r}")
    return (major, minor, patch)


@router.get("/updates/{target}/{arch}/{current_version}")
async def check_for_update(
    target: str,
    arch: str,
    current_version: str,
    source: Annotated[ReleaseSource, Depends(get_release_source)],
) -> Response:
    try:
        current = parse_semver(current_version)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="current_version must be a MAJOR.MINOR.PATCH semver",
        ) from None

    manifest = await source.latest_release()
    if manifest is None:
        return Response(status_code=204)

    entry = manifest.platforms.get(f"{target}-{arch}")
    if entry is None:
        return Response(status_code=204)

    try:
        latest = parse_semver(manifest.version)
    except ValueError:
        # A malformed manifest is a release-pipeline bug, not the client's:
        # log loudly, tell the client there is no update.
        log.error("updates.manifest_version_invalid version=%r", manifest.version)
        return Response(status_code=204)

    if latest <= current:
        return Response(status_code=204)

    payload: dict[str, str] = {
        "version": manifest.version,
        "url": entry.url,
        "signature": entry.signature,
    }
    if manifest.pub_date is not None:
        payload["pub_date"] = manifest.pub_date.isoformat()
    if manifest.notes is not None:
        payload["notes"] = manifest.notes
    return JSONResponse(payload)
