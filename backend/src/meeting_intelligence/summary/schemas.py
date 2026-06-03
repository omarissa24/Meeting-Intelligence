"""Pydantic schemas for LLM structured output.

The summariser forces Anthropic to call `record_summary` with a JSON
input matching `SummaryPayload`. Pydantic validates the response; on
ValidationError we retry once with the error appended (see runner).

`RECORD_SUMMARY_TOOL_SCHEMA` is the JSON Schema dict passed to the
tool-use request. We hand-write it rather than auto-deriving from the
Pydantic model to keep tight control over the tool description fields
visible to Claude — the descriptions ARE part of the prompt.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class ActionItemPayload(BaseModel):
    """One action item extracted from the transcript.

    `owner` and `deadline` are optional — the prompt instructs the
    model to leave them unset rather than guess. The desktop renders
    `Unassigned` / `No deadline set` in those cases (US-16).
    """

    description: str = Field(..., description="What needs to be done")
    owner: str | None = Field(
        default=None, description="Who is responsible, or null"
    )
    deadline: date | None = Field(
        default=None,
        description="ISO 8601 date (yyyy-mm-dd), or null if not stated",
    )


class TopicPayload(BaseModel):
    """A topic discussed during the meeting plus its estimated duration."""

    name: str = Field(..., description="Short topic label, 2-6 words")
    duration_seconds: int = Field(
        ...,
        ge=0,
        description="Estimated time (seconds) spent on this topic",
    )


class SummaryPayload(BaseModel):
    """Full structured output produced by the LangGraph reduce node.

    Empty arrays are valid — when no decisions were made, the model
    must return `decisions: []` rather than inventing one. The desktop
    surfaces the absence as "No decisions recorded" (US-15).
    """

    summary: str = Field(
        ...,
        description="Clear professional prose summarising the meeting",
    )
    decisions: list[str] = Field(
        default_factory=list,
        description=(
            "Each decision is a single sentence. Empty list when none "
            "were made."
        ),
    )
    action_items: list[ActionItemPayload] = Field(
        default_factory=list,
        description=(
            "Action items only — concrete next steps assigned to a "
            "person, even if owner/deadline aren't stated."
        ),
    )
    topics: list[TopicPayload] = Field(
        default_factory=list,
        description="3-8 topics in order of first appearance",
    )


# JSON Schema for the Anthropic `record_summary` tool. Mirrors
# `SummaryPayload` exactly; descriptions are visible to Claude so they
# DOUBLE as instructions.
RECORD_SUMMARY_TOOL_SCHEMA: dict[str, object] = {
    "type": "object",
    "required": ["summary", "decisions", "action_items", "topics"],
    "properties": {
        "summary": {
            "type": "string",
            "description": (
                "Clear professional prose summarising the meeting's "
                "main purpose, key discussion, and outcome. Plain "
                "paragraphs, not bullet fragments."
            ),
        },
        "decisions": {
            "type": "array",
            "description": (
                "Decisions made during the meeting. Each entry is a "
                "single sentence describing what was agreed (and by "
                "whom if determinable). Empty array if none were made "
                "— do NOT invent one."
            ),
            "items": {"type": "string"},
        },
        "action_items": {
            "type": "array",
            "description": (
                "Concrete next steps. Empty array when none. Do not "
                "invent owners or deadlines — leave them null when "
                "the transcript doesn't state them."
            ),
            "items": {
                "type": "object",
                "required": ["description"],
                "properties": {
                    "description": {"type": "string"},
                    "owner": {"type": ["string", "null"]},
                    "deadline": {
                        "type": ["string", "null"],
                        "description": "ISO date yyyy-mm-dd, or null",
                    },
                },
            },
        },
        "topics": {
            "type": "array",
            "description": (
                "3-8 topics in order of first appearance. Each item "
                "has a short label and an estimated duration in "
                "seconds."
            ),
            "items": {
                "type": "object",
                "required": ["name", "duration_seconds"],
                "properties": {
                    "name": {"type": "string"},
                    "duration_seconds": {"type": "integer", "minimum": 0},
                },
            },
        },
    },
}


# Tool name used in `tool_choice={"type": "tool", "name": ...}`. Kept
# as a constant so the runner and the LLM provider stay in sync.
RECORD_SUMMARY_TOOL_NAME = "record_summary"
