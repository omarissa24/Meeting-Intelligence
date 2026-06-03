"""Unit tests for AnthropicClaudeLLM.

Mocks `anthropic.AsyncAnthropic` so we can assert the call shape Phase 3
needs without a real API key:

- `tool_use(...)` invokes `messages.create` with the expected `tools`,
  forced `tool_choice`, and parses the resulting tool_use block back
  into a dict + token counts.
- `count_tokens(...)` invokes `messages.count_tokens` and returns
  `input_tokens` (used by FR-3.07 budget guard).
- `complete(...)` parses the first text block.
- `tool_use` raises `ToolUseError` when the model declines to call the
  tool.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from meeting_intelligence.llm.anthropic_claude import (
    AnthropicClaudeLLM,
    ToolUseError,
)


def _build_llm_with_mock(
    *,
    create_response: Any | None = None,
    count_tokens_response: Any | None = None,
) -> tuple[AnthropicClaudeLLM, MagicMock]:
    """Construct an LLM with a mocked underlying client.

    Returns `(llm, client_mock)` so tests can both call the LLM and
    assert against the recorded calls on the mock.
    """
    llm = AnthropicClaudeLLM(api_key="sk-test", model="claude-test-model")
    mock_client = MagicMock()
    mock_client.messages = MagicMock()
    if create_response is not None:
        mock_client.messages.create = AsyncMock(return_value=create_response)
    if count_tokens_response is not None:
        mock_client.messages.count_tokens = AsyncMock(
            return_value=count_tokens_response
        )
    llm._client = mock_client  # type: ignore[assignment]
    return llm, mock_client


@pytest.mark.asyncio
async def test_tool_use_returns_parsed_input_and_token_counts() -> None:
    tool_block = SimpleNamespace(
        type="tool_use",
        name="record_summary",
        input={"summary": "Quick standup", "decisions": [], "topics": []},
    )
    response = SimpleNamespace(
        content=[tool_block],
        usage=SimpleNamespace(input_tokens=42, output_tokens=11),
        stop_reason="tool_use",
    )
    llm, client = _build_llm_with_mock(create_response=response)

    payload, in_tok, out_tok = await llm.tool_use(
        system="sys",
        messages=[{"role": "user", "content": "transcript"}],
        tool_name="record_summary",
        tool_schema={"type": "object", "properties": {}},
        max_tokens=2000,
    )
    assert payload == {"summary": "Quick standup", "decisions": [], "topics": []}
    assert in_tok == 42
    assert out_tok == 11

    create_kwargs = client.messages.create.await_args.kwargs
    assert create_kwargs["model"] == "claude-test-model"
    assert create_kwargs["system"] == "sys"
    assert create_kwargs["tool_choice"] == {
        "type": "tool",
        "name": "record_summary",
    }
    assert len(create_kwargs["tools"]) == 1
    assert create_kwargs["tools"][0]["name"] == "record_summary"
    assert create_kwargs["max_tokens"] == 2000


@pytest.mark.asyncio
async def test_tool_use_raises_when_model_declines() -> None:
    response = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="I refuse")],
        usage=SimpleNamespace(input_tokens=5, output_tokens=3),
        stop_reason="end_turn",
    )
    llm, _ = _build_llm_with_mock(create_response=response)

    with pytest.raises(ToolUseError, match="record_summary"):
        await llm.tool_use(
            system="sys",
            messages=[{"role": "user", "content": "x"}],
            tool_name="record_summary",
            tool_schema={"type": "object"},
            max_tokens=1000,
        )


@pytest.mark.asyncio
async def test_count_tokens_returns_input_tokens() -> None:
    llm, client = _build_llm_with_mock(
        count_tokens_response=SimpleNamespace(input_tokens=12_345)
    )
    n = await llm.count_tokens(
        system="sys",
        messages=[{"role": "user", "content": "hello world" * 200}],
    )
    assert n == 12_345
    client.messages.count_tokens.assert_awaited_once()


@pytest.mark.asyncio
async def test_complete_extracts_first_text_block() -> None:
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="hello"),
            SimpleNamespace(type="text", text="ignored"),
        ],
    )
    llm, _ = _build_llm_with_mock(create_response=response)
    out = await llm.complete(system="sys", messages=[], max_tokens=100)
    assert out == "hello"


def test_constructor_validates_inputs() -> None:
    with pytest.raises(ValueError, match="api_key"):
        AnthropicClaudeLLM(api_key="", model="claude-test")
    with pytest.raises(ValueError, match="model"):
        AnthropicClaudeLLM(api_key="sk-test", model="")
