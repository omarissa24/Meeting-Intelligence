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


def test_ensure_local_signing_key_persists_across_processes(tmp_path) -> None:
    """Regression: tokens minted in one process must verify in the next.

    The signing key was previously a process-scoped random, so a
    backend restart silently invalidated every cached audioUrl on the
    desktop. Now it lives under `<root>/.signing-key` so the same key
    survives.
    """
    from meeting_intelligence.config import Settings

    settings_a = Settings(local_storage_signing_key=None)
    key_a = deps_mod.ensure_local_signing_key(settings_a, tmp_path)
    assert key_a
    assert (tmp_path / ".signing-key").read_text().strip() == key_a

    # New Settings instance — simulates a process restart with no env
    # override. Should reuse the persisted key, not generate a new one.
    settings_b = Settings(local_storage_signing_key=None)
    key_b = deps_mod.ensure_local_signing_key(settings_b, tmp_path)
    assert key_b == key_a


def test_ensure_local_signing_key_is_idempotent(tmp_path) -> None:
    """Calling the helper twice must not regenerate or rewrite the key."""
    from meeting_intelligence.config import Settings

    settings = Settings(local_storage_signing_key=None)
    first = deps_mod.ensure_local_signing_key(settings, tmp_path)
    second = deps_mod.ensure_local_signing_key(settings, tmp_path)
    assert first == second
    assert settings.local_storage_signing_key == first


def test_ensure_local_signing_key_respects_explicit_value(tmp_path) -> None:
    """An env-supplied key wins; we don't overwrite it from disk."""
    from meeting_intelligence.config import Settings

    settings = Settings(local_storage_signing_key="explicit-key-from-env")
    out = deps_mod.ensure_local_signing_key(settings, tmp_path)
    assert out == "explicit-key-from-env"
    # No file written when settings already had the key.
    assert not (tmp_path / ".signing-key").exists()
