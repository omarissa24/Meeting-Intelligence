"""Verify the config-driven STT provider factory.

`get_stt_provider()` reads `Settings.stt_provider` + `deepgram_api_key`
at first call and caches the result; tests clear the cache between
cases so each scenario starts clean.
"""

from __future__ import annotations

import pytest

import meeting_intelligence.config as config_mod
from meeting_intelligence.api import deps as deps_mod
from meeting_intelligence.stt.deepgram_nova import DeepgramNovaSTT
from meeting_intelligence.stt.in_memory_echo import InMemoryEchoSTT


@pytest.fixture(autouse=True)
def reset_caches() -> None:
    """Drop both memoised globals so monkeypatched env vars take effect."""
    deps_mod._build_provider.cache_clear()
    config_mod._settings = None
    yield
    deps_mod._build_provider.cache_clear()
    config_mod._settings = None


def test_default_returns_in_memory_echo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STT_PROVIDER", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)

    provider = deps_mod.get_stt_provider()
    assert isinstance(provider, InMemoryEchoSTT)


def test_explicit_echo_returns_in_memory_echo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "echo")

    provider = deps_mod.get_stt_provider()
    assert isinstance(provider, InMemoryEchoSTT)


def test_deepgram_with_key_returns_deepgram_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STT_PROVIDER", "deepgram")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key-1234")

    provider = deps_mod.get_stt_provider()
    assert isinstance(provider, DeepgramNovaSTT)


def test_deepgram_without_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "deepgram")
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY"):
        deps_mod.get_stt_provider()


def test_provider_is_cached_between_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "echo")
    first = deps_mod.get_stt_provider()
    second = deps_mod.get_stt_provider()
    assert first is second
