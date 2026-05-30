"""LLM provider interface.

Implementations: Anthropic Claude (MVP). Future: a self-hosted model for
enterprise on-prem.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator


class LLMProvider(ABC):
    """Chat-style completion provider.

    Real summarisation goes through LangGraph nodes that call this provider —
    feature code never instantiates a vendor SDK directly.
    """

    @abstractmethod
    async def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> str:
        """Return a single completion."""
        raise NotImplementedError

    @abstractmethod
    async def stream(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int,
    ) -> AsyncIterator[str]:
        """Stream completion tokens."""
        raise NotImplementedError
