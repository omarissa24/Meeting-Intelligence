"""LangGraph summarisation pipeline.

Phase 3 / FR-3.01: graph orchestrates a chunk → incremental → reduce
flow that produces a structured `SummaryPayload` from a meeting
transcript. Graph nodes call the abstract `LLMProvider`, never an
SDK directly — `runner.summarise_transcript` is the single seam
the rest of the backend uses to invoke the pipeline.
"""

from meeting_intelligence.summary.runner import (
    SummaryResult,
    summarise_transcript,
)
from meeting_intelligence.summary.schemas import (
    ActionItemPayload,
    SummaryPayload,
    TopicPayload,
)

__all__ = [
    "ActionItemPayload",
    "SummaryPayload",
    "SummaryResult",
    "TopicPayload",
    "summarise_transcript",
]
