"""Filesystem `ObjectStorageProvider` — round-trip + URL signing tests."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from meeting_intelligence.storage.local_disk import (
    LocalDiskObjectStorage,
    mint_local_token,
    verify_local_token,
)


@pytest.fixture
def storage(tmp_path: Path) -> LocalDiskObjectStorage:
    return LocalDiskObjectStorage(
        root=tmp_path,
        signing_key="x" * 48,
        base_url="http://test.invalid/storage/local",
    )


@pytest.mark.asyncio
async def test_put_get_roundtrip(storage: LocalDiskObjectStorage) -> None:
    payload = b"\x00\x01\x02\x03\xff"
    url = await storage.put("meetings/u/m.mp3", payload, "audio/mpeg")
    assert url == "local://meetings/u/m.mp3"

    out = await storage.get("meetings/u/m.mp3")
    assert out == payload


@pytest.mark.asyncio
async def test_delete_is_idempotent(storage: LocalDiskObjectStorage) -> None:
    await storage.put("k.bin", b"x", "application/octet-stream")
    await storage.delete("k.bin")
    # Second delete is a no-op — same contract S3 gives.
    await storage.delete("k.bin")


@pytest.mark.parametrize(
    "bad_key",
    [
        "/leading-slash",
        "../escape",
        "with\x00null",
        "ok/../bad",
        "",
        "trailing/",
    ],
)
@pytest.mark.asyncio
async def test_put_rejects_unsafe_keys(
    storage: LocalDiskObjectStorage, bad_key: str
) -> None:
    with pytest.raises(ValueError):
        await storage.put(bad_key, b"x", "application/octet-stream")


@pytest.mark.asyncio
async def test_presigned_url_round_trip(storage: LocalDiskObjectStorage) -> None:
    await storage.put("meetings/u/m.mp3", b"hello", "audio/mpeg")
    url = await storage.presigned_url("meetings/u/m.mp3", expires_in=120)
    assert url.startswith("http://test.invalid/storage/local/")
    token = url.rsplit("/", 1)[-1]
    key, exp = verify_local_token(token, b"x" * 48)
    assert key == "meetings/u/m.mp3"
    assert exp > int(time.time())


def test_token_tamper_rejected() -> None:
    sig_key = b"x" * 48
    token = mint_local_token("meetings/u/m.mp3", int(time.time()) + 60, sig_key)
    # Flip a byte deep in the body — the signature comparison must fail.
    decoded = bytearray(__import__("base64").urlsafe_b64decode(token + "==="))
    decoded[5] ^= 0xFF
    bad = (
        __import__("base64")
        .urlsafe_b64encode(bytes(decoded))
        .rstrip(b"=")
        .decode()
    )
    with pytest.raises(ValueError):
        verify_local_token(bad, sig_key)


def test_token_expired_rejected() -> None:
    sig_key = b"x" * 48
    # Generate with a 1-second TTL and verify just past it.
    token = mint_local_token("k", int(time.time()) - 1, sig_key)
    with pytest.raises(ValueError, match="expired"):
        verify_local_token(token, sig_key)


def test_token_wrong_key_rejected() -> None:
    token = mint_local_token("k", int(time.time()) + 60, b"x" * 48)
    with pytest.raises(ValueError, match="bad signature"):
        verify_local_token(token, b"y" * 48)


def test_token_with_dot_byte_in_signature_round_trips() -> None:
    """Regression: HMAC digest may contain 0x2e (".") at any byte
    position. The verifier must locate the separator at -33 positionally,
    not via `rpartition(b".")` — otherwise it splits on the internal dot
    and rejects valid tokens roughly 1 mint in 8.
    """
    sig_key = b"x" * 48
    # exp=1780000004 with key="meetings/u/m.mp3" produces an HMAC sig
    # containing 0x2e. Found by exhaustive search; pinned for stability.
    expires_at = 1_780_000_004
    token = mint_local_token("meetings/u/m.mp3", expires_at, sig_key)
    key, exp = verify_local_token(token, sig_key, now=expires_at - 1)
    assert key == "meetings/u/m.mp3"
    assert exp == expires_at
