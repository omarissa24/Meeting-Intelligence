"""InMemoryFakeEmbeddingProvider unit tests.

The fake is the test double for the OpenAI provider. The contract we
care about — and all of search testing depends on — is:

  - Same text → same vector (no flake on repeated runs).
  - Distinct text → distinct vector (cosine distance > 0).
  - Vectors are 1536-dim and L2-normalised so cosine distance is
    bounded in [0, 2].

If any of these break, downstream search tests would silently degrade
to "first 10 rows" behavior. So we lock them in tightly here.
"""

from __future__ import annotations

import math

import pytest

from meeting_intelligence.embedding.fake import InMemoryFakeEmbeddingProvider


def _cosine_distance(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return 1.0 - dot


@pytest.mark.asyncio
async def test_fake_is_deterministic() -> None:
    p = InMemoryFakeEmbeddingProvider()
    v1 = (await p.embed(["hello world"]))[0]
    v2 = (await p.embed(["hello world"]))[0]
    assert v1 == v2


@pytest.mark.asyncio
async def test_fake_returns_correct_dim() -> None:
    p = InMemoryFakeEmbeddingProvider()
    v = (await p.embed(["any text"]))[0]
    assert len(v) == 1536
    assert p.dimensions == 1536


@pytest.mark.asyncio
async def test_fake_vectors_are_unit_normalised() -> None:
    p = InMemoryFakeEmbeddingProvider()
    v = (await p.embed(["unit norm check"]))[0]
    norm = math.sqrt(sum(x * x for x in v))
    # Floating-point round-trip; tolerate tiny drift.
    assert abs(norm - 1.0) < 1e-9


@pytest.mark.asyncio
async def test_fake_distinct_inputs_produce_distinct_vectors() -> None:
    p = InMemoryFakeEmbeddingProvider()
    [v1, v2] = await p.embed(["first phrase", "totally different content"])
    assert v1 != v2
    # Random unit vectors are nearly orthogonal in 1536-dim — cosine
    # distance well above zero.
    assert _cosine_distance(v1, v2) > 0.5


@pytest.mark.asyncio
async def test_fake_preserves_order() -> None:
    p = InMemoryFakeEmbeddingProvider()
    inputs = ["alpha", "beta", "gamma", "delta"]
    vectors = await p.embed(inputs)
    assert len(vectors) == len(inputs)
    # Re-embedding any single input alone matches the corresponding
    # row from the batch — provider must not depend on neighbouring
    # inputs.
    for i, txt in enumerate(inputs):
        single = (await p.embed([txt]))[0]
        assert single == vectors[i]


@pytest.mark.asyncio
async def test_fake_empty_input_returns_empty() -> None:
    p = InMemoryFakeEmbeddingProvider()
    assert await p.embed([]) == []


@pytest.mark.asyncio
async def test_fake_records_calls_for_assertion() -> None:
    p = InMemoryFakeEmbeddingProvider()
    await p.embed(["one"])
    await p.embed(["two", "three"])
    assert len(p.calls) == 2
    assert p.calls[0].inputs == ["one"]
    assert p.calls[1].inputs == ["two", "three"]
