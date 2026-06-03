"""Dev-only local-storage download route.

`LocalDiskObjectStorage.presigned_url` mints HMAC-signed tokens that
point at this route. The route validates the token + TTL, then streams
the file from disk. **404s in production** so the local-storage path
can't accidentally bypass S3 in a deployed environment.

The route deliberately does NOT require a bearer token — the HMAC-signed
URL IS the auth. Tokens carry an embedded expiry; replays past TTL fail
even with a valid signature.
"""

from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, Response

from meeting_intelligence.config import Settings, get_settings
from meeting_intelligence.storage.local_disk import (
    _safe_relative_path,
    verify_local_token,
)

router = APIRouter(prefix="/storage/local", tags=["storage"])
log = logging.getLogger("meeting_intelligence.storage.local")


def _resolve_root(settings: Settings) -> Path:
    import tempfile

    root = settings.local_object_storage_root or str(
        Path(tempfile.gettempdir()) / "meeting-intelligence-objects"
    )
    return Path(root)


def _resolve_signing_key(settings: Settings) -> bytes:
    """Hydrate the persisted dev signing key.

    Tokens minted in a previous process must still verify after a
    restart, so the key lives under `<root>/.signing-key` rather than
    being a process-scoped random. Imported from `api.deps` lazily
    (avoid circular import: deps imports storage too).
    """
    from meeting_intelligence.api.deps import ensure_local_signing_key

    key = ensure_local_signing_key(settings, _resolve_root(settings))
    return key.encode()


@router.get("/{token}")
async def download_local_object(
    token: str,
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    if settings.environment == "production":
        # In production we serve via S3 presigned URLs only. The route
        # exists to keep the import graph stable, but it must never
        # serve content.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")

    signing_key = _resolve_signing_key(settings)
    try:
        key, _ = verify_local_token(token, signing_key)
    except ValueError as exc:
        log.info("storage.local.download_rejected reason=%s", exc)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc

    rel = _safe_relative_path(key)
    target = _resolve_root(settings) / rel
    if not target.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="object not found")

    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(target, media_type=media_type)
