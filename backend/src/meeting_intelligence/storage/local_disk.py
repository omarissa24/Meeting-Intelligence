"""Filesystem-backed `ObjectStorageProvider` for dev + tests.

This is the default backend (`OBJECT_STORAGE_BACKEND=local`) so the
local dev story works without standing up MinIO or shipping S3
credentials. Production deployments MUST switch to `s3`.

The presigned URL flow is implemented as a hash-signed token pointing
at the dev-only `GET /storage/local/{token}` route in
`api/storage.py`. The route validates the token signature and TTL,
then streams the file. This route 404s in production environments,
so even if `OBJECT_STORAGE_BACKEND=local` ended up set in production
the URLs would be unreachable.

Tokens carry an HMAC-SHA256 signature over `key|expires_at`, encoded
url-safe base64. Tokens are opaque to the client; the desktop just
follows the URL.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from pathlib import Path
from typing import Final

from meeting_intelligence.interfaces.storage import ObjectStorageProvider

log = logging.getLogger("meeting_intelligence.storage.local")

_PATH_SAFE: Final[set[str]] = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./"
)


def _safe_relative_path(key: str) -> Path:
    """Map a storage key to a relative `Path`, refusing traversal escapes.

    Keys are app-controlled (`meetings/<user_id>/<meeting_id>.mp3`) but
    we still treat the input adversarially: `..` segments, leading
    slashes, NUL bytes, and any character outside the conservative
    whitelist are refused. Returns a relative `Path` ready to join to
    the storage root.
    """
    if not key or key.startswith("/") or "\x00" in key or any(c not in _PATH_SAFE for c in key):
        raise ValueError(f"invalid storage key: {key!r}")
    parts = key.split("/")
    if any(p in ("", "..", ".") for p in parts):
        raise ValueError(f"invalid storage key: {key!r}")
    return Path(*parts)


class LocalDiskObjectStorage(ObjectStorageProvider):
    def __init__(self, root: str | Path, signing_key: str, base_url: str):
        """Construct a local-disk storage rooted at `root`.

        Args:
            root: directory under which all object keys are written.
                Created lazily; per-key subdirectories are created at
                `put` time.
            signing_key: symmetric secret used to sign presigned URL
                tokens. Must match what the `/storage/local/{token}`
                route uses to verify (configured in
                `Settings.local_storage_signing_key`).
            base_url: external URL prefix the presigned URL is rooted
                at — typically the running backend's base URL plus
                `/storage/local`. Used only to format the URL string;
                the route itself does the verification.
        """
        self._root = Path(root)
        self._signing_key = signing_key.encode()
        self._base_url = base_url.rstrip("/")

    async def put(self, key: str, data: bytes, content_type: str) -> str:
        rel = _safe_relative_path(key)
        target = self._root / rel
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        # Write through a temp file in the same directory then atomically
        # rename — keeps a partial write from being readable mid-flight.
        tmp = target.with_suffix(target.suffix + ".tmp")

        def _write() -> None:
            with tmp.open("wb") as f:
                f.write(data)
            tmp.replace(target)

        await asyncio.to_thread(_write)
        log.info("storage.local.put key=%s bytes=%d", key, len(data))
        # `content_type` is ignored on disk (no metadata sidecar in this
        # layer); the route serves audio/mpeg unconditionally because
        # all current callers store MP3.
        return f"local://{key}"

    async def get(self, key: str) -> bytes:
        rel = _safe_relative_path(key)
        target = self._root / rel

        def _read() -> bytes:
            return target.read_bytes()

        return await asyncio.to_thread(_read)

    async def presigned_url(self, key: str, expires_in: int) -> str:
        # Validate the key shape early so a malformed call fails before
        # we mint a token that would fail signature check anyway.
        _safe_relative_path(key)
        expires_at = int(time.time()) + max(1, expires_in)
        token = mint_local_token(key, expires_at, self._signing_key)
        return f"{self._base_url}/{token}"

    async def delete(self, key: str) -> None:
        rel = _safe_relative_path(key)
        target = self._root / rel

        def _unlink() -> None:
            try:
                target.unlink()
            except FileNotFoundError:
                # Idempotent delete — same contract S3 gives us.
                pass

        await asyncio.to_thread(_unlink)
        log.info("storage.local.delete key=%s", key)


def mint_local_token(key: str, expires_at: int, signing_key: bytes) -> str:
    """Build a `key|expires_at|sig` token, base64-url-encoded as one blob.

    Token format is opaque to the client: the inner JSON shape can
    change without breaking URLs already in flight, since the desktop
    just follows the URL string.
    """
    payload = {"k": key, "e": expires_at}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(signing_key, body, hashlib.sha256).digest()
    blob = body + b"." + sig
    return base64.urlsafe_b64encode(blob).rstrip(b"=").decode()


def verify_local_token(
    token: str, signing_key: bytes, *, now: int | None = None
) -> tuple[str, int]:
    """Decode + verify a token; return `(key, expires_at)`.

    Raises `ValueError` on tamper, malformed input, or expiry.
    """
    try:
        padding = "=" * (-len(token) % 4)
        blob = base64.urlsafe_b64decode(token + padding)
    except Exception as exc:
        raise ValueError(f"malformed token: {exc}") from exc
    body, _, sig = blob.rpartition(b".")
    if not body or len(sig) != 32:
        raise ValueError("malformed token")
    expected = hmac.new(signing_key, body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise ValueError("bad signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed token body: {exc}") from exc
    key = payload.get("k")
    expires_at = payload.get("e")
    if not isinstance(key, str) or not isinstance(expires_at, int):
        raise ValueError("malformed token payload")
    if (now or int(time.time())) >= expires_at:
        raise ValueError("token expired")
    # Re-validate the key shape so the route doesn't have to.
    _safe_relative_path(key)
    return key, expires_at
