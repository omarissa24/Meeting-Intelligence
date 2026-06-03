"""S3 (and R2 / MinIO via `s3_endpoint_url`) `ObjectStorageProvider`.

Wraps `aioboto3` so the ABC stays async. Same interface used by the
filesystem implementation; the route + Celery task code is identical.

Pre-signed URL TTLs are clamped to `audio_presigned_url_ttl_seconds`
upstream; this module accepts whatever it's given. AWS itself caps
v4-signed URLs at 7 days, but FR-2.07 caps us at 1 hour.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aioboto3
from botocore.exceptions import ClientError

from meeting_intelligence.interfaces.storage import ObjectStorageProvider

log = logging.getLogger("meeting_intelligence.storage.s3")


class S3ObjectStorage(ObjectStorageProvider):
    def __init__(
        self,
        *,
        bucket: str,
        endpoint_url: str | None = None,
        region: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("S3ObjectStorage requires a bucket name")
        self._bucket = bucket
        self._endpoint_url = endpoint_url
        self._region = region
        self._access_key_id = access_key_id
        self._secret_access_key = secret_access_key
        # `aioboto3.Session` is cheap to construct repeatedly, but holding
        # one across calls plays nicer with credential providers.
        self._session = aioboto3.Session(
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
        )

    def _client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if self._endpoint_url:
            kwargs["endpoint_url"] = self._endpoint_url
        return kwargs

    async def put(self, key: str, data: bytes, content_type: str) -> str:
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            await s3.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        log.info("storage.s3.put bucket=%s key=%s bytes=%d", self._bucket, key, len(data))
        return f"s3://{self._bucket}/{key}"

    async def get(self, key: str) -> bytes:
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            resp = await s3.get_object(Bucket=self._bucket, Key=key)
            async with resp["Body"] as stream:
                return await stream.read()  # type: ignore[no-any-return]

    async def presigned_url(self, key: str, expires_in: int) -> str:
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            url = await s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=max(1, expires_in),
            )
            return str(url)

    async def delete(self, key: str) -> None:
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            try:
                await s3.delete_object(Bucket=self._bucket, Key=key)
            except ClientError as exc:
                # AWS already treats DELETE on a missing key as 204; only
                # surface unexpected errors.
                code = exc.response.get("Error", {}).get("Code")
                if code in ("NoSuchKey", "404"):
                    return
                raise
        log.info("storage.s3.delete bucket=%s key=%s", self._bucket, key)


# Synchronous twin for the Celery worker — Celery tasks aren't async
# without extra ceremony, and the worker only needs `put`. Keeps
# the dependency footprint identical (boto3 is pulled in by aioboto3).
def s3_put_sync(
    *,
    bucket: str,
    key: str,
    data: bytes,
    content_type: str,
    endpoint_url: str | None,
    region: str | None,
    access_key_id: str | None,
    secret_access_key: str | None,
) -> None:
    """Blocking PUT for use inside Celery tasks. Avoids running an
    asyncio loop just to call `aioboto3.put_object`."""
    import boto3  # local import — avoid pulling boto3 into hot paths

    client = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    )
    client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)


# `aioboto3`'s s3 GET stream uses `async with`, but mypy can't infer the
# `bytes` return without a cast — silence with the inline ignore above.

# Helper for the local-disk test helper to share so we don't duplicate.
__all__ = ["S3ObjectStorage", "s3_put_sync"]


async def _ensure_loop_alive() -> None:
    """Sanity check used in tests when constructing the session.

    aioboto3 reaches into the running loop on construction; in tests
    that don't have one yet (rare), the failure is opaque. This helper
    surfaces it cleanly.
    """
    asyncio.get_running_loop()
