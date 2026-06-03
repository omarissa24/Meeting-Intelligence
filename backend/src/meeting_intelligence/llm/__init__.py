"""LLMProvider implementations.

Sits behind the architectural seam in `interfaces/llm.py`: feature code
(LangGraph nodes, Celery tasks, API routes) calls the abstract provider,
and `api/deps.py` chooses which concrete implementation to inject.

`AnthropicClaudeLLM` wraps the real `anthropic.AsyncAnthropic` client.
`InMemoryFakeLLM` is the test double — every code path can be exercised
without a real API key.
"""

from meeting_intelligence.llm.anthropic_claude import AnthropicClaudeLLM
from meeting_intelligence.llm.in_memory_fake import InMemoryFakeLLM

__all__ = ["AnthropicClaudeLLM", "InMemoryFakeLLM"]
