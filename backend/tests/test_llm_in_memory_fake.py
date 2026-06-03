"""Unit tests for InMemoryFakeLLM.

The fake is the test double the entire summariser pipeline uses, so it
needs to be reliable: queue ordering, exhaustion behaviour, call
recording, and the tunable `count_tokens` value all matter.
"""

from __future__ import annotations

import pytest

from meeting_intelligence.llm.in_memory_fake import InMemoryFakeLLM


@pytest.mark.asyncio
async def test_tool_use_returns_canned_responses_in_order() -> None:
    fake = InMemoryFakeLLM(
        responses=[
            ({"summary": "first"}, 10, 20),
            ({"summary": "second"}, 30, 40),
        ],
    )

    first, in1, out1 = await fake.tool_use(
        system="sys",
        messages=[{"role": "user", "content": "a"}],
        tool_name="record_summary",
        tool_schema={},
        max_tokens=1000,
    )
    second, in2, out2 = await fake.tool_use(
        system="sys",
        messages=[{"role": "user", "content": "b"}],
        tool_name="record_summary",
        tool_schema={},
        max_tokens=1000,
    )

    assert first == {"summary": "first"}
    assert (in1, out1) == (10, 20)
    assert second == {"summary": "second"}
    assert (in2, out2) == (30, 40)
    assert len(fake.calls) == 2
    assert all(c.method == "tool_use" for c in fake.calls)


@pytest.mark.asyncio
async def test_tool_use_raises_when_queue_exhausted() -> None:
    fake = InMemoryFakeLLM(responses=[])
    with pytest.raises(IndexError, match="canned responses"):
        await fake.tool_use(
            system="sys",
            messages=[{"role": "user", "content": "a"}],
            tool_name="record_summary",
            tool_schema={},
            max_tokens=1000,
        )


@pytest.mark.asyncio
async def test_count_tokens_returns_configured_value() -> None:
    fake = InMemoryFakeLLM(token_count=500_000)
    n = await fake.count_tokens(
        system="sys",
        messages=[{"role": "user", "content": "irrelevant"}],
    )
    assert n == 500_000
    assert fake.calls[-1].method == "count_tokens"
