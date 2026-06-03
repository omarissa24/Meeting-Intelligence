"""Single entry point that the Celery summarise task invokes.

Builds the compiled LangGraph, runs it under an asyncio loop, and
validates the structured payload against `SummaryPayload`. On
ValidationError, retries ONCE with the validation error appended to
the prompt so the model has a chance to repair its own output. A
second failure returns `error` set so the runner caller can mark
`status='failed'`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pydantic import ValidationError

from meeting_intelligence.summary.graph import (
    SummariserLLM,
    SummaryState,
    build_summary_graph,
)
from meeting_intelligence.summary.prompts import TOO_SHORT_WORD_THRESHOLD
from meeting_intelligence.summary.schemas import SummaryPayload

log = logging.getLogger("meeting_intelligence.summary.runner")


@dataclass
class SummaryResult:
    """Outcome of one summarisation invocation.

    Exactly one of `payload`, `too_short`, or `error` is the truth:
      - `payload` set when the LLM produced a valid SummaryPayload.
      - `too_short` set when the transcript was below the 50-word
        floor (FR-3.09); the runner skips the LLM entirely.
      - `error` set when the LLM produced unrecoverable output
        (validation failure twice, or tool-use refusal).

    `confidence_low` flags meetings with fewer than 2 distinct speaker
    ids — surfaced as a footnote on the desktop (FR-3.09 / US-20).
    """

    payload: SummaryPayload | None = None
    too_short: bool = False
    error: str | None = None
    confidence_low: bool = False
    input_tokens: int = 0
    output_tokens: int = 0


async def summarise_transcript(
    *,
    transcript: str,
    speaker_count: int,
    llm: SummariserLLM,
) -> SummaryResult:
    """Run the LangGraph pipeline and return a validated result.

    The transcript is expected to be the speaker-tagged form (`S0:
    ...\nS1: ...`) that the Celery task assembles from
    transcript_segments. `speaker_count` is the distinct count
    pre-computed by the caller; we don't redo it here so the prompt
    sees the same number the audit log records.
    """
    confidence_low = speaker_count < 2
    if not transcript.strip() or len(transcript.split()) < TOO_SHORT_WORD_THRESHOLD:
        # Short-circuit even before invoking the graph. Saves a
        # round-trip and keeps the fake-provider call count at zero
        # for this branch — tests assert that.
        return SummaryResult(
            too_short=True,
            confidence_low=confidence_low,
        )

    graph = build_summary_graph()
    initial: SummaryState = {
        "transcript_text": transcript,
        "speaker_count": speaker_count,
    }
    config = {"configurable": {"llm": llm}}

    state = await graph.ainvoke(initial, config=config)

    if state.get("too_short"):
        # The graph re-confirmed too-short during chunk_buffer;
        # mirror the early-exit shape.
        return SummaryResult(
            too_short=True,
            confidence_low=confidence_low,
        )

    raw_payload = state.get("final")
    if raw_payload is None:
        return SummaryResult(
            error="LLM did not produce a structured payload",
            confidence_low=confidence_low,
        )

    try:
        payload = SummaryPayload.model_validate(raw_payload)
    except ValidationError as exc:
        log.warning(
            "summary.validate_failed_first_pass detail=%s", str(exc)[:500]
        )
        # One retry: re-invoke the reduce step with the validation
        # error appended so the model can repair its own output.
        retry = await _retry_reduce_with_error(state, llm, str(exc))
        if retry.payload is not None:
            return SummaryResult(
                payload=retry.payload,
                confidence_low=confidence_low,
                input_tokens=state.get("input_tokens", 0)
                + retry.input_tokens,
                output_tokens=state.get("output_tokens", 0)
                + retry.output_tokens,
            )
        return SummaryResult(
            error=f"LLM output failed validation twice: {exc}",
            confidence_low=confidence_low,
            input_tokens=state.get("input_tokens", 0),
            output_tokens=state.get("output_tokens", 0),
        )

    return SummaryResult(
        payload=payload,
        confidence_low=confidence_low,
        input_tokens=state.get("input_tokens", 0),
        output_tokens=state.get("output_tokens", 0),
    )


@dataclass
class _ReduceRetryResult:
    payload: SummaryPayload | None
    input_tokens: int
    output_tokens: int


async def _retry_reduce_with_error(
    state: SummaryState,
    llm: SummariserLLM,
    validation_error: str,
) -> _ReduceRetryResult:
    """Re-call tool_use with the validation error glued onto the prompt."""
    from meeting_intelligence.summary.prompts import (
        REDUCE_FROM_CHUNK_SUMMARIES_LABEL,
        REDUCE_FROM_FULL_TRANSCRIPT_LABEL,
        REDUCE_PROMPT_TEMPLATE,
        SYSTEM_PROMPT,
    )
    from meeting_intelligence.summary.schemas import (
        RECORD_SUMMARY_TOOL_NAME,
        RECORD_SUMMARY_TOOL_SCHEMA,
    )

    chunks = state.get("chunks") or []
    incrementals = state.get("incremental_summaries") or []
    if incrementals:
        source_label = REDUCE_FROM_CHUNK_SUMMARIES_LABEL
        source_body = "\n\n".join(
            f"Chunk {i + 1}:\n{s}" for i, s in enumerate(incrementals)
        )
    else:
        source_label = REDUCE_FROM_FULL_TRANSCRIPT_LABEL
        source_body = chunks[0] if chunks else ""

    base_prompt = REDUCE_PROMPT_TEMPLATE.format(
        source_label=source_label,
        source_body=source_body,
    )
    repair_suffix = (
        "\n\nIMPORTANT: your previous attempt failed schema validation:\n"
        f"{validation_error}\n"
        "Call the tool again with valid input."
    )
    try:
        raw, in_tok, out_tok = await llm.tool_use(
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": base_prompt + repair_suffix}
            ],
            tool_name=RECORD_SUMMARY_TOOL_NAME,
            tool_schema=RECORD_SUMMARY_TOOL_SCHEMA,
            max_tokens=4000,
        )
    except Exception as exc:
        log.warning("summary.retry_call_failed err=%s", exc)
        return _ReduceRetryResult(payload=None, input_tokens=0, output_tokens=0)

    try:
        return _ReduceRetryResult(
            payload=SummaryPayload.model_validate(raw),
            input_tokens=in_tok,
            output_tokens=out_tok,
        )
    except ValidationError as exc:
        log.warning(
            "summary.validate_failed_second_pass detail=%s", str(exc)[:500]
        )
        return _ReduceRetryResult(payload=None, input_tokens=in_tok, output_tokens=out_tok)
