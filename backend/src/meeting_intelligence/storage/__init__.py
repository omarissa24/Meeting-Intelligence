"""Concrete `ObjectStorageProvider` implementations.

Selection happens via `Settings.object_storage_backend` (`s3` | `local`)
through the `get_object_storage` DI in `api/deps.py`. Both
implementations satisfy the same async ABC defined in
`interfaces/storage.py`; routes and Celery tasks are written against
the interface, not the concrete class.
"""

from meeting_intelligence.storage.local_disk import LocalDiskObjectStorage
from meeting_intelligence.storage.s3 import S3ObjectStorage

__all__ = ["LocalDiskObjectStorage", "S3ObjectStorage"]
