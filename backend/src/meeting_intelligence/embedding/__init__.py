"""Embedding providers (Phase 4 semantic search).

The package exposes concrete implementations behind the
`EmbeddingProvider` ABC defined in `interfaces.embedding`. Pick the
implementation via `Settings.embedding_provider`; `api/deps.py` does
the wiring.
"""

from meeting_intelligence.embedding.fake import InMemoryFakeEmbeddingProvider
from meeting_intelligence.embedding.openai import OpenAIEmbeddingProvider

__all__ = ["InMemoryFakeEmbeddingProvider", "OpenAIEmbeddingProvider"]
