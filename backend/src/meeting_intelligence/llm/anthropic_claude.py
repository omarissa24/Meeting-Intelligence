"""Anthropic Claude implementation of `LLMProvider`.

Sits behind the architectural seam established in `interfaces/llm.py`:
graph nodes never import this module directly — they receive an
`LLMProvider` via `RunnableConfig` and call the ABC. The summariser
runner is responsible for picking the concrete impl.

Two surfaces beyond the ABC:

  - `tool_use(...)` — runs `messages.create` with a forced single-tool
    `tool_choice`. Anthropic doesn't support OpenAI-style
    `response_format=json_schema`; forced tool use is the canonical
    pattern for structured output. Returns the parsed tool input dict.
  - `count_tokens(...)` — wraps `messages.count_tokens`, used by the
    summariser to gate the chunked-fallback path (FR-3.07). Vendor-
    specific by nature; lives on the adapter, not the ABC.

Both are async — the SDK is async-first.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from anthropic import AsyncAnthropic

from meeting_intelligence.interfaces.llm import LLMProvider

log = logging.getLogger("meeting_intelligence.llm.anthropic_claude")


class AnthropicClaudeLLM(LLMProvider):
    """Async Claude client behind the `LLMProvider` ABC.

    Constructor takes the API key + model name explicitly so it stays
    independent of the global `Settings` singleton; `api/deps.py` does
    the wiring. Reusing one instance across requests is safe — the SDK
    pools its own httpx connections.
    """

    provider_id: str = "anthropic-claude"

    def __init__(self, *, api_key: str, model: str) -> None:
        if not api_key:
            raise ValueError("AnthropicClaudeLLM requires a non-empty api_key")
        if not model:
            raise ValueError("AnthropicClaudeLLM requires a non-empty model")
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model

    async def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> str:
        """Single text completion. See ABC for shape."""
        response = await self._client.messages.create(
            model=self._model,
            system=system,
            messages=messages,  # type: ignore[arg-type]
            max_tokens=max_tokens,
        )
        # The SDK returns a list of content blocks; for plain text
        # completions only the first text block matters.
        for block in response.content:
            if getattr(block, "type", None) == "text":
                return str(getattr(block, "text", ""))
        return ""

    async def stream(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> AsyncIterator[str]:
        """Token streaming. Phase 3 doesn't use this; ABC requires it."""

        async def _gen() -> AsyncIterator[str]:
            async with self._client.messages.stream(
                model=self._model,
                system=system,
                messages=messages,  # type: ignore[arg-type]
                max_tokens=max_tokens,
            ) as response:
                async for delta in response.text_stream:
                    yield delta

        return _gen()

    async def tool_use(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int,
    ) -> tuple[dict[str, Any], int, int]:
        """Invoke Claude with a forced single tool, return parsed input + token counts.

        Returns (tool_input, input_tokens, output_tokens). Raises
        `ToolUseError` if Claude declines to call the tool — extremely
        rare with `tool_choice` forced, but we surface it cleanly so
        the runner can flip status to `failed` rather than throwing.
        """
        tools: list[dict[str, Any]] = [
            {
                "name": tool_name,
                "description": (
                    "Record the structured output. ALWAYS call this tool — "
                    "do not respond in plain text."
                ),
                "input_schema": tool_schema,
            }
        ]
        response = await self._client.messages.create(  # type: ignore[call-overload]
            model=self._model,
            system=system,
            messages=messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice={"type": "tool", "name": tool_name},
        )
        # Find the first tool_use block matching our forced tool name.
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and getattr(
                block, "name", ""
            ) == tool_name:
                raw_input = getattr(block, "input", {})
                tool_input: dict[str, Any] = (
                    raw_input if isinstance(raw_input, dict) else {}
                )
                usage = response.usage
                return (
                    tool_input,
                    int(usage.input_tokens),
                    int(usage.output_tokens),
                )
        raise ToolUseError(
            f"Claude did not call the forced tool {tool_name!r}; "
            f"stop_reason={response.stop_reason!r}"
        )

    async def count_tokens(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
    ) -> int:
        """Server-side exact token count for FR-3.07 budget guard.

        The cheap call: input tokens only, no model invocation. We use
        this to fork the summariser between single-pass and chunked
        paths before paying for a full `messages.create`.
        """
        response = await self._client.messages.count_tokens(
            model=self._model,
            system=system,
            messages=messages,  # type: ignore[arg-type]
        )
        return int(response.input_tokens)


class ToolUseError(RuntimeError):
    """Raised when Claude refuses to call the forced tool.

    Lives in this module because it's tied to the Anthropic-specific
    tool-use protocol. The runner catches it and marks the summary
    `failed` rather than retrying — the model already declined and a
    second identical call won't fix that.
    """
