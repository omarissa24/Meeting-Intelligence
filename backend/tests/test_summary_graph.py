"""LangGraph summariser tests with InMemoryFakeLLM.

Covers every code path the runner can take:
  - too-short transcript: short-circuits before the graph, no LLM call
  - single-pass: one chunk, only `final_reduce` fires
  - map-reduce: many chunks, `incremental_summary` then `final_reduce`
  - validation failure → retry → success
  - validation failure → retry → still bad → error result
  - confidence_low flag: <2 distinct speakers
"""

from __future__ import annotations

from typing import Any

import pytest

from meeting_intelligence.llm.in_memory_fake import InMemoryFakeLLM
from meeting_intelligence.summary import summarise_transcript
from meeting_intelligence.summary.runner import SummaryResult


def _valid_payload(summary: str = "Quarterly planning ran short.") -> dict[str, Any]:
    return {
        "summary": summary,
        "decisions": ["Approve Q3 hiring plan."],
        "action_items": [
            {
                "description": "Send budget memo",
                "owner": "Omar",
                "deadline": "2026-06-15",
            }
        ],
        "topics": [
            {"name": "Hiring plan", "duration_seconds": 600},
            {"name": "Budget memo", "duration_seconds": 300},
        ],
    }


def _long_transcript(words_per_chunk: int = 4000, chunks: int = 3) -> str:
    """Synthesize a transcript big enough to trip the chunked path."""
    word = "alpha"
    return " ".join([word] * (words_per_chunk * chunks))


# --- too-short branch -------------------------------------------------------


@pytest.mark.asyncio
async def test_short_transcript_skips_llm() -> None:
    fake = InMemoryFakeLLM(responses=[])
    result = await summarise_transcript(
        transcript="Hello world.",
        speaker_count=2,
        llm=fake,
    )
    assert isinstance(result, SummaryResult)
    assert result.too_short is True
    assert result.payload is None
    assert result.error is None
    # The whole point of too-short: the LLM was never called.
    assert fake.calls == []


# --- single-pass branch -----------------------------------------------------


@pytest.mark.asyncio
async def test_single_pass_calls_only_final_reduce() -> None:
    fake = InMemoryFakeLLM(
        responses=[(_valid_payload(), 100, 200)],
    )
    transcript = " ".join(["word"] * 200)  # well above 50 words
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=3,
        llm=fake,
    )
    assert result.payload is not None
    assert result.too_short is False
    assert result.error is None
    assert result.confidence_low is False
    assert result.input_tokens == 100
    assert result.output_tokens == 200
    # Single-pass: only one tool_use call, no `complete` calls.
    methods = [c.method for c in fake.calls]
    assert methods.count("tool_use") == 1
    assert methods.count("complete") == 0


# --- map-reduce branch ------------------------------------------------------


@pytest.mark.asyncio
async def test_map_reduce_runs_incrementals_then_reduce() -> None:
    fake = InMemoryFakeLLM(responses=[(_valid_payload(), 5_000, 800)])
    transcript = _long_transcript(chunks=3)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=4,
        llm=fake,
    )
    assert result.payload is not None
    methods = [c.method for c in fake.calls]
    # 3 incremental complete() calls + 1 reduce tool_use.
    assert methods.count("complete") == 3
    assert methods.count("tool_use") == 1


# --- validation retry -------------------------------------------------------


@pytest.mark.asyncio
async def test_validation_failure_then_retry_succeeds() -> None:
    invalid = {
        # Missing the required `summary` field — fails Pydantic.
        "decisions": [],
        "action_items": [],
        "topics": [],
    }
    fake = InMemoryFakeLLM(
        responses=[
            (invalid, 50, 30),
            (_valid_payload(), 70, 40),
        ],
    )
    transcript = " ".join(["word"] * 200)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=2,
        llm=fake,
    )
    assert result.payload is not None
    assert result.error is None
    # Two tool_use calls — first failed validation, second succeeded.
    methods = [c.method for c in fake.calls]
    assert methods.count("tool_use") == 2


@pytest.mark.asyncio
async def test_validation_failure_twice_returns_error() -> None:
    invalid = {"decisions": [], "action_items": [], "topics": []}
    fake = InMemoryFakeLLM(
        responses=[
            (invalid, 50, 30),
            (invalid, 70, 40),
        ],
    )
    transcript = " ".join(["word"] * 200)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=2,
        llm=fake,
    )
    assert result.payload is None
    assert result.error is not None
    assert "validation" in result.error.lower()


# --- confidence_low ---------------------------------------------------------


@pytest.mark.asyncio
async def test_confidence_low_flagged_on_one_speaker() -> None:
    fake = InMemoryFakeLLM(responses=[(_valid_payload(), 10, 20)])
    transcript = " ".join(["word"] * 200)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=1,
        llm=fake,
    )
    assert result.payload is not None
    assert result.confidence_low is True


@pytest.mark.asyncio
async def test_confidence_low_not_flagged_on_two_or_more_speakers() -> None:
    fake = InMemoryFakeLLM(responses=[(_valid_payload(), 10, 20)])
    transcript = " ".join(["word"] * 200)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=2,
        llm=fake,
    )
    assert result.confidence_low is False


# --- empty decisions allowed (hallucination guard) --------------------------


@pytest.mark.asyncio
async def test_empty_decisions_is_valid() -> None:
    """The hallucination guard says no-decisions → empty array, not invented."""
    payload_no_decisions = {
        "summary": "Casual chat about the weekend.",
        "decisions": [],
        "action_items": [],
        "topics": [{"name": "Weekend", "duration_seconds": 120}],
    }
    fake = InMemoryFakeLLM(responses=[(payload_no_decisions, 30, 50)])
    transcript = " ".join(["word"] * 200)
    result = await summarise_transcript(
        transcript=transcript,
        speaker_count=2,
        llm=fake,
    )
    assert result.payload is not None
    assert result.payload.decisions == []
    assert result.payload.action_items == []
