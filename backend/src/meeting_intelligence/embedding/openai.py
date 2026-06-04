"""OpenAI implementation of `EmbeddingProvider`.

Sits behind the architectural seam in `interfaces.embedding`: feature
code (search route, embed Celery task) never imports `openai`
directly.

The text-embedding-3-small model:

  - returns 1536-dimensional vectors natively (matches FR-4.02);
  - accepts up to 8192 input tokens per item;
  - accepts up to 2048 inputs per request (we cap at 256 — leaves
    headroom for the request payload to stay well under any URL/body
    limit and gives the worker tighter latency feedback per batch).

Retry policy is conservative: 3 attempts on `RateLimitError` /
`APITimeoutError`, exponential backoff (1s, 2s, 4s). Other errors
propagate to Celery, which decides whether to retry the outer task.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from openai import APITimeoutError, AsyncOpenAI, RateLimitError

from meeting_intelligence.interfaces.embedding import EmbeddingProvider

log = logging.getLogger("meeting_intelligence.embedding.openai")


# Per-request input cap. Below the OpenAI ceiling on purpose; bigger
# batches don't measurably reduce wall-clock and make a single transient
# error more painful to retry.
_BATCH_SIZE = 256

# Defensive truncation: the model accepts 8192 tokens, but our segments
# are typically a few hundred chars. Truncating to ~32k chars (≈8000
# tokens at the rough char-per-token ratio for English) keeps us safely
# inside the limit without paying a tokeniser round-trip.
_MAX_CHARS_PER_INPUT = 32_000

_DIMENSIONS = 1536


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """Async OpenAI embeddings client behind the `EmbeddingProvider` ABC."""

    provider_id: str = "openai"

    def __init__(self, *, api_key: str, model: str) -> None:
        if not api_key:
            raise ValueError("OpenAIEmbeddingProvider requires a non-empty api_key")
        if not model:
            raise ValueError("OpenAIEmbeddingProvider requires a non-empty model")
        self._client = AsyncOpenAI(api_key=api_key)
        self._model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # Truncate per item; preserve order across the batch boundary.
        prepared = [self._truncate(t) for t in texts]
        out: list[list[float]] = []
        for start in range(0, len(prepared), _BATCH_SIZE):
            batch = prepared[start : start + _BATCH_SIZE]
            vectors = await self._embed_batch(batch)
            out.extend(vectors)
        return out

    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        backoff = 1.0
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                response: Any = await self._client.embeddings.create(
                    model=self._model,
                    input=batch,
                )
                # The SDK preserves input order in `data`.
                return [list(item.embedding) for item in response.data]
            except (RateLimitError, APITimeoutError) as exc:
                last_exc = exc
                if attempt == 2:
                    break
                log.warning(
                    "openai-embed transient error (attempt %d/3): %s",
                    attempt + 1,
                    exc,
                )
                await asyncio.sleep(backoff)
                backoff *= 2
        # Exhausted retries — bubble up so the Celery task can decide.
        assert last_exc is not None
        raise last_exc

    @staticmethod
    def _truncate(text: str) -> str:
        if len(text) <= _MAX_CHARS_PER_INPUT:
            return text
        return text[:_MAX_CHARS_PER_INPUT]

    @property
    def dimensions(self) -> int:
        return _DIMENSIONS

    @property
    def model_version(self) -> str:
        return self._model
