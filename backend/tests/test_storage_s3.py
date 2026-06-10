"""S3 `ObjectStorageProvider` — placeholder.

The async aioboto3 + moto combination has known compatibility friction
on current versions (`MockRawResponse.raw_headers` missing,
`httpchecksum` coroutine concat). Rather than ship flaky tests, we
defer real S3 coverage to:

  * Integration smoke against MinIO (next compose slice).
  * Production `S3ObjectStorage` exercised end-to-end on first deploy.

Local-disk and route tests already cover the `ObjectStorageProvider`
interface contract; the S3 implementation is a thin aioboto3 wrapper.
"""

from __future__ import annotations

from typing import Any

import pytest

from meeting_intelligence.storage.s3 import S3ObjectStorage, s3_put_sync


def test_s3_constructor_validates_bucket() -> None:
    """At minimum, prove the class refuses to instantiate without a bucket.

    Heavier integration coverage lands when MinIO is in compose.
    """
    with pytest.raises(ValueError, match="bucket"):
        S3ObjectStorage(bucket="")


class _CapturingS3Client:
    """Stands in for the aioboto3 s3 client context manager."""

    def __init__(self, calls: list[dict[str, Any]]) -> None:
        self._calls = calls

    async def __aenter__(self) -> _CapturingS3Client:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def put_object(self, **kwargs: Any) -> None:
        self._calls.append(kwargs)


async def test_put_sets_server_side_encryption() -> None:
    """US-13: every upload requests AES-256 encryption at rest."""
    storage = S3ObjectStorage(bucket="test-bucket")
    calls: list[dict[str, Any]] = []

    class _FakeSession:
        def client(self, *_args: Any, **_kwargs: Any) -> _CapturingS3Client:
            return _CapturingS3Client(calls)

    storage._session = _FakeSession()  # type: ignore[assignment]

    await storage.put("meetings/u/m.mp3", b"abc", content_type="audio/mpeg")

    assert len(calls) == 1
    assert calls[0]["ServerSideEncryption"] == "AES256"
    assert calls[0]["Bucket"] == "test-bucket"
    assert calls[0]["ContentType"] == "audio/mpeg"


def test_put_sync_sets_server_side_encryption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Celery worker's blocking PUT mirrors the async path's SSE."""
    calls: list[dict[str, Any]] = []

    class _FakeClient:
        def put_object(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    import boto3

    monkeypatch.setattr(boto3, "client", lambda *a, **k: _FakeClient())

    s3_put_sync(
        bucket="test-bucket",
        key="meetings/u/m.mp3",
        data=b"abc",
        content_type="audio/mpeg",
        endpoint_url=None,
        region=None,
        access_key_id=None,
        secret_access_key=None,
    )

    assert len(calls) == 1
    assert calls[0]["ServerSideEncryption"] == "AES256"
