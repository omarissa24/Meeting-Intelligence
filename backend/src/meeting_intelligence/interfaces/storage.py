"""Object-storage provider interface.

Implementations: S3, Cloudflare R2 (S3-compatible). Future: local filesystem
for tests / on-prem.
"""

from abc import ABC, abstractmethod


class ObjectStorageProvider(ABC):
    """Blob storage for audio files and transcript archives."""

    @abstractmethod
    async def put(self, key: str, data: bytes, content_type: str) -> str:
        """Upload `data` at `key`; return a stable object URL."""
        raise NotImplementedError

    @abstractmethod
    async def get(self, key: str) -> bytes:
        raise NotImplementedError

    @abstractmethod
    async def presigned_url(self, key: str, expires_in: int) -> str:
        raise NotImplementedError

    @abstractmethod
    async def delete(self, key: str) -> None:
        raise NotImplementedError
