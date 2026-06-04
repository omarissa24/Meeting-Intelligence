"""Real-OpenAI embedding e2e — opt-in via `pytest -m e2e`.

Default `pytest` runs skip these (`addopts = -m 'not e2e'`); they
only fire when:

  - The `e2e` marker is selected, AND
  - `OPENAI_API_KEY` is set in the environment.

What's verified:

  1. The provider returns 1536-dimensional vectors (FR-4.02).
  2. Semantically related queries are closer than unrelated ones —
     "budget overrun" is closer to "we exceeded our financial
     projections" than to "the new hire starts Monday". This is the
     end-to-end faithfulness check that swap-out from fake to real
     OpenAI doesn't silently degrade ranking.

Cost: 4 short embedding calls per run (~$0.000001). Negligible.
"""

from __future__ import annotations

import math
import os

import pytest

from meeting_intelligence.config import get_settings
from meeting_intelligence.embedding.openai import OpenAIEmbeddingProvider

pytestmark = pytest.mark.e2e


def _cosine_distance(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return 1.0 - dot


@pytest.fixture(scope="session")
def real_provider() -> OpenAIEmbeddingProvider:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        pytest.skip(
            "OPENAI_API_KEY not set; skipping real-OpenAI embedding e2e. "
            "Run with `OPENAI_API_KEY=… uv run pytest -m e2e tests/e2e/test_real_openai_embed.py`"
        )
    return OpenAIEmbeddingProvider(
        api_key=api_key, model=get_settings().embedding_model
    )


@pytest.mark.asyncio
async def test_provider_returns_1536_dim_vectors(
    real_provider: OpenAIEmbeddingProvider,
) -> None:
    [v] = await real_provider.embed(["A short test phrase."])
    assert len(v) == 1536
    # OpenAI's text-embedding-3-small returns L2-normalised vectors.
    # We don't strictly require it for cosine distance to work, but a
    # major drift would change downstream score interpretation.
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 0.01


@pytest.mark.asyncio
async def test_semantically_related_phrases_are_closer(
    real_provider: OpenAIEmbeddingProvider,
) -> None:
    """The contract that makes search work.

    A query about budget overruns should land closer to a sentence
    about exceeding financial projections than to an unrelated
    sentence about onboarding. If this stops being true, search is
    broken regardless of the rest of the pipeline.
    """
    query = "we are concerned about budget overruns this quarter"
    related = "we exceeded our financial projections by 20% last quarter"
    unrelated = "the new hire starts onboarding on Monday"

    vectors = await real_provider.embed([query, related, unrelated])
    assert len(vectors) == 3
    q, r, u = vectors

    related_distance = _cosine_distance(q, r)
    unrelated_distance = _cosine_distance(q, u)

    # The related phrase must be strictly closer. We don't pin a
    # specific gap because OpenAI may revise the model — but any
    # sane embedding model will keep this ordering.
    assert related_distance < unrelated_distance, (
        f"semantic ranking broken: related={related_distance:.4f} "
        f"unrelated={unrelated_distance:.4f}"
    )
