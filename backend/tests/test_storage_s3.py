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

import pytest

from meeting_intelligence.storage.s3 import S3ObjectStorage


def test_s3_constructor_validates_bucket() -> None:
    """At minimum, prove the class refuses to instantiate without a bucket.

    Heavier integration coverage lands when MinIO is in compose.
    """
    with pytest.raises(ValueError, match="bucket"):
        S3ObjectStorage(bucket="")
