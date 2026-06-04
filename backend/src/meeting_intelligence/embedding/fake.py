"""Deterministic in-memory `EmbeddingProvider` for tests.

Same input → same vector, every call. We seed a `random.Random` from
`sha256(text)` and draw 1536 floats, then L2-normalise so cosine
distance behaves predictably:

  - identical text → distance 0
  - distinct text  → distance > 0 (typically near 1, since random
    high-dim vectors are nearly orthogonal)

That predictability is what lets `test_search_routes.py` assert exact
ordering against a hand-crafted corpus without flake.

The provider also doubles as the default in CI: a leaked
`OPENAI_API_KEY` cannot accidentally cause the test suite to bill real
embeddings because `Settings.embedding_provider` defaults to `"fake"`.
"""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass

from meeting_intelligence.interfaces.embedding import EmbeddingProvider


@dataclass
class FakeEmbedCall:
    """Recorded invocation, surfaced via `InMemoryFakeEmbeddingProvider.calls`."""

    inputs: list[str]


class InMemoryFakeEmbeddingProvider(EmbeddingProvider):
    """SHA256-seeded RNG → 1536 floats per input, L2-normalised."""

    provider_id: str = "in-memory-fake"

    def __init__(self, *, dimensions: int = 1536) -> None:
        if dimensions <= 0:
            raise ValueError("dimensions must be positive")
        self._dimensions = dimensions
        self.calls: list[FakeEmbedCall] = []

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(FakeEmbedCall(inputs=list(texts)))
        return [self._embed_one(t) for t in texts]

    def _embed_one(self, text: str) -> list[float]:
        seed = int.from_bytes(
            hashlib.sha256(text.encode("utf-8")).digest()[:8], "big", signed=False
        )
        rng = random.Random(seed)
        # Standard-normal samples produce vectors that, once
        # L2-normalised, are uniformly distributed on the unit sphere.
        # That gives meaningful cosine distance (≠0 for distinct text).
        v = [rng.gauss(0.0, 1.0) for _ in range(self._dimensions)]
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_version(self) -> str:
        return "fake-embedding-v1"
