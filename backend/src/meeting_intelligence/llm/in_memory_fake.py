"""In-memory fake `LLMProvider` for tests.

The summariser pipeline talks to an `LLMProvider` so we can drop a
deterministic stub in for unit tests, integration tests, and dev runs
without an Anthropic key. Mirrors the `tool_use(...)` and
`count_tokens(...)` surface of `AnthropicClaudeLLM` so the runner
doesn't branch on which provider it has.

The fake records every call so tests can assert the LLM was (or wasn't)
invoked — the too-short branch in particular skips the LLM, and we want
to prove that didn't fire by accident.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from meeting_intelligence.interfaces.llm import LLMProvider


@dataclass
class FakeCall:
    """Recorded invocation, surfaced via `InMemoryFakeLLM.calls`."""

    method: str
    system: str
    messages: list[dict[str, str]]
    tool_name: str | None = None


class InMemoryFakeLLM(LLMProvider):
    """Replays canned tool-call responses in order.

    Each `tool_use(...)` call dequeues the next canned `(input, in_tok,
    out_tok)` from `responses`. If the queue is exhausted, raises
    `IndexError` — fail loud so a misconfigured test doesn't silently
    swallow real bugs.

    `count_tokens` returns whatever the constructor was told to report.
    Tests that exercise the FR-3.07 chunked-fallback path bump this
    above `summary_token_budget` to fork the runner.
    """

    provider_id: str = "in-memory-fake"

    def __init__(
        self,
        *,
        responses: list[tuple[dict[str, Any], int, int]] | None = None,
        token_count: int = 100,
    ) -> None:
        self._queue: list[tuple[dict[str, Any], int, int]] = list(responses or [])
        self._token_count = token_count
        self.calls: list[FakeCall] = []

    # --- LLMProvider ABC -----------------------------------------------------

    async def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> str:
        # Phase-3 summariser only uses `tool_use`. Implementing
        # `complete` keeps the ABC happy and gives Phase 5+ a clean
        # surface.
        self.calls.append(FakeCall("complete", system=system, messages=list(messages)))
        return ""

    async def stream(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> AsyncIterator[str]:
        self.calls.append(FakeCall("stream", system=system, messages=list(messages)))

        async def _empty() -> AsyncIterator[str]:
            if False:
                yield ""

        return _empty()

    # --- Anthropic-shaped extras (used by the summariser runner) -------------

    async def tool_use(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int,
    ) -> tuple[dict[str, Any], int, int]:
        self.calls.append(
            FakeCall(
                "tool_use",
                system=system,
                messages=list(messages),
                tool_name=tool_name,
            )
        )
        if not self._queue:
            raise IndexError(
                "InMemoryFakeLLM: no canned responses left — "
                "pass enough entries via `responses=[...]`"
            )
        return self._queue.pop(0)

    async def count_tokens(
        self,
        *,
        system: str,
        messages: list[dict[str, str]],
    ) -> int:
        self.calls.append(
            FakeCall("count_tokens", system=system, messages=list(messages))
        )
        return self._token_count
