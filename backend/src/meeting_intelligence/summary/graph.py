"""LangGraph state graph for FR-3.01 summarisation.

Three nodes:

  - `chunk_buffer`: deterministic, no LLM. Splits the transcript into
    word-budgeted chunks (single chunk for short meetings; many for
    long ones) and sets `too_short=True` when the transcript falls
    below the 50-word threshold.
  - `incremental_summary`: only fires when there is more than one
    chunk. Loops over chunks serially calling `llm.complete` to
    produce a per-chunk condensation. (Serial, not parallel — keeps
    rate limits + observability simple; the meeting is already over,
    so wall-clock budget is the user's stop-to-summary perception, not
    a per-chunk constraint.)
  - `final_reduce`: emits the structured `SummaryPayload` via forced
    tool use. Reads either the chunk summaries or the full transcript
    based on the chunk count.

Branching:
  chunk_buffer
    │
    ├── too_short=True → END (runner short-circuits)
    ├── len(chunks)==1 → final_reduce (single-pass)
    └── len(chunks)>1  → incremental_summary → final_reduce
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol, TypedDict, cast

from langgraph.graph import END, START, StateGraph
from langgraph.types import RunnableConfig  # type: ignore[attr-defined]

from meeting_intelligence.summary.prompts import (
    INCREMENTAL_PROMPT_TEMPLATE,
    REDUCE_FROM_CHUNK_SUMMARIES_LABEL,
    REDUCE_FROM_FULL_TRANSCRIPT_LABEL,
    REDUCE_PROMPT_TEMPLATE,
    SYSTEM_PROMPT,
    TOO_SHORT_WORD_THRESHOLD,
)
from meeting_intelligence.summary.schemas import (
    RECORD_SUMMARY_TOOL_NAME,
    RECORD_SUMMARY_TOOL_SCHEMA,
)


class SummariserLLM(Protocol):
    """Subset of LLMProvider+extras the summariser actually invokes.

    Both `AnthropicClaudeLLM` and `InMemoryFakeLLM` satisfy this. We
    type the runner against this protocol rather than `LLMProvider`
    directly so mypy keeps the `tool_use` / `count_tokens` extras in
    the type checker's view.
    """

    async def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> str: ...

    async def tool_use(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int,
    ) -> tuple[dict[str, Any], int, int]: ...

    async def count_tokens(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
    ) -> int: ...


class SummaryState(TypedDict, total=False):
    """Graph-traversal state.

    `total=False` so partial updates from each node merge cleanly. The
    runner pre-populates `transcript_text` and `speaker_count`; the
    nodes write the rest as they go.
    """

    transcript_text: str
    speaker_count: int
    chunks: list[str]
    incremental_summaries: list[str]
    final: dict[str, Any] | None
    too_short: bool
    input_tokens: int
    output_tokens: int


# Word budget per chunk when we fall through to the chunked path. Each
# 5 minutes of typical conversation is roughly 700-900 words; 4000
# words gives the model a comfortable ~5-6 minute window and stays
# well clear of any per-chunk token ceiling.
WORDS_PER_CHUNK = 4000


# ---- Nodes -----------------------------------------------------------------


async def chunk_buffer_node(
    state: SummaryState,
    config: RunnableConfig,
) -> SummaryState:
    """Tokenise into chunks; set too_short for transcripts below threshold."""
    transcript = state.get("transcript_text", "") or ""
    words = transcript.split()
    if len(words) < TOO_SHORT_WORD_THRESHOLD:
        return {"chunks": [], "too_short": True}

    if len(words) <= WORDS_PER_CHUNK:
        return {"chunks": [transcript], "too_short": False}

    chunks: list[str] = []
    for i in range(0, len(words), WORDS_PER_CHUNK):
        chunks.append(" ".join(words[i : i + WORDS_PER_CHUNK]))
    return {"chunks": chunks, "too_short": False}


async def incremental_summary_node(
    state: SummaryState,
    config: RunnableConfig,
) -> SummaryState:
    """Per-chunk condensation. Parallel fan-out across `chunks`.

    Chunks are semantically independent — chunk N's condensation
    doesn't depend on chunk N-1's output, only the reduce step
    consumes them collectively. So we `asyncio.gather` over the
    chunks: wall-clock = slowest single chunk, not sum of chunks.
    This is the FR-3.15 ≤45s budget lever for the map-reduce path.

    Anthropic's per-key concurrency limits comfortably accommodate
    the chunk counts our 180k-token guard produces (≤~5-10 chunks),
    so we don't bound the gather. If a deployment ever bumps that
    cap, layer a `Semaphore` here.
    """
    llm = _llm_from_config(config)
    chunks = state.get("chunks") or []
    in_tok = state.get("input_tokens", 0)
    out_tok = state.get("output_tokens", 0)

    async def _summarise_one(idx: int, chunk: str) -> str:
        prompt = INCREMENTAL_PROMPT_TEMPLATE.format(
            chunk_index=idx + 1,
            chunk_total=len(chunks),
            chunk_text=chunk,
        )
        text = await llm.complete(
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1200,
        )
        # The fake provider returns "" from complete(); guard so an
        # empty response doesn't poison the reduce step.
        return text or f"(chunk {idx + 1} produced no output)"

    summaries = await asyncio.gather(
        *(_summarise_one(idx, chunk) for idx, chunk in enumerate(chunks))
    )

    return {
        "incremental_summaries": list(summaries),
        "input_tokens": in_tok,
        "output_tokens": out_tok,
    }


async def final_reduce_node(
    state: SummaryState,
    config: RunnableConfig,
) -> SummaryState:
    """Emit the structured SummaryPayload via forced tool use."""
    llm = _llm_from_config(config)
    chunks = state.get("chunks") or []
    if not chunks:
        # too_short branch should short-circuit before we hit reduce.
        # Defensive — return a no-op so the graph still terminates.
        return {"final": None}

    incrementals = state.get("incremental_summaries") or []
    if incrementals:
        source_label = REDUCE_FROM_CHUNK_SUMMARIES_LABEL
        source_body = "\n\n".join(
            f"Chunk {i + 1}:\n{s}" for i, s in enumerate(incrementals)
        )
    else:
        source_label = REDUCE_FROM_FULL_TRANSCRIPT_LABEL
        source_body = chunks[0]

    prompt = REDUCE_PROMPT_TEMPLATE.format(
        source_label=source_label,
        source_body=source_body,
    )
    payload, in_t, out_t = await llm.tool_use(
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
        tool_name=RECORD_SUMMARY_TOOL_NAME,
        tool_schema=RECORD_SUMMARY_TOOL_SCHEMA,
        max_tokens=4000,
    )
    return {
        "final": payload,
        "input_tokens": state.get("input_tokens", 0) + in_t,
        "output_tokens": state.get("output_tokens", 0) + out_t,
    }


# ---- Routing ---------------------------------------------------------------


def _route_after_chunking(state: SummaryState) -> str:
    if state.get("too_short"):
        return "end"
    chunks = state.get("chunks") or []
    if len(chunks) > 1:
        return "incremental"
    return "reduce"


def _llm_from_config(config: RunnableConfig) -> SummariserLLM:
    """Pull the LLM out of the runnable config.

    LangGraph passes `RunnableConfig` to every node; we look it up
    under `configurable.llm`. Tests inject a fake; production uses
    `AnthropicClaudeLLM`. Both satisfy `SummariserLLM`.
    """
    configurable = (config or {}).get("configurable") or {}
    llm = configurable.get("llm")
    if llm is None:
        raise RuntimeError(
            "summariser graph invoked without an `llm` in RunnableConfig"
        )
    return cast(SummariserLLM, llm)


# ---- Compile ---------------------------------------------------------------


def build_summary_graph() -> Any:
    """Return the compiled LangGraph state graph.

    Compilation is cheap; the runner builds it per invocation rather
    than caching. Avoids a global mutable state surface that would
    complicate worker reload semantics.
    """
    graph = StateGraph(SummaryState)
    graph.add_node("chunk_buffer", chunk_buffer_node)
    graph.add_node("incremental_summary", incremental_summary_node)
    graph.add_node("final_reduce", final_reduce_node)

    graph.add_edge(START, "chunk_buffer")
    graph.add_conditional_edges(
        "chunk_buffer",
        _route_after_chunking,
        {
            "end": END,
            "incremental": "incremental_summary",
            "reduce": "final_reduce",
        },
    )
    graph.add_edge("incremental_summary", "final_reduce")
    graph.add_edge("final_reduce", END)
    return graph.compile()
