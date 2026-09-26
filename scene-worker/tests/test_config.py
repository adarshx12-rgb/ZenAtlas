from __future__ import annotations

import pytest

from zenatlas_scenes.config import ConfigError, Settings, load_env_file


def test_defaults_are_conservative():
    settings = Settings.from_env({"DATABASE_URL": "postgresql://fixture"})
    assert settings.gemini_model == "gemini-3.8-flash" and settings.media_root is None
    assert (settings.lease_seconds, settings.gemini_timeout_seconds, settings.daily_request_budget) == (900, 600, 20)
    assert not settings.transcribe_fallback and settings.whisper_model == "large-v3-turbo"


@pytest.mark.parametrize(("env", "message"), [
    ({"DATABASE_URL": ""}, "DATABASE_URL"),
    ({"GEMINI_MODEL": "models/../gemini"}, "GEMINI_MODEL"),
    ({"SCENE_MEDIA_ROOT": "relative/media"}, "absolute"),
    ({"GEMINI_TIMEOUT_SECONDS": "900", "SCENE_LEASE_SECONDS": "900"}, "SCENE_LEASE_SECONDS"),
    ({"SCENE_ANALYSIS_DAILY_BUDGET": "many"}, "integer"),
    ({"SCENE_TRANSCRIBE_FALLBACK": "yes"}, "true or false"),
    ({"WHISPER_DEVICE": "gpu"}, "WHISPER_DEVICE"),
])
def test_invalid_settings_are_rejected(env, message):
    with pytest.raises(ConfigError, match=message):
        Settings.from_env({"DATABASE_URL": "postgresql://fixture", **env})


def test_analysis_requires_a_real_api_key():
    with pytest.raises(ConfigError):
        Settings.from_env({"DATABASE_URL": "postgresql://fixture", "GEMINI_API_KEY": "replace-with-key"}).require_gemini()
    Settings.from_env({"DATABASE_URL": "postgresql://fixture", "GEMINI_API_KEY": "configured"}).require_gemini()


def test_env_file_fills_only_unset_values(tmp_path):
    path = tmp_path / ".env"
    path.write_text('# comment\nGEMINI_MODEL="gemini-3.7-flash"\nDATABASE_URL=from-file\nEMPTY=\n', encoding="utf-8")
    environ = {"DATABASE_URL": "from-environment"}
    load_env_file(path, environ)
    assert environ == {"DATABASE_URL": "from-environment", "GEMINI_MODEL": "gemini-3.7-flash", "EMPTY": ""}



def test_fallback_models_default_to_gemini_through_openrouter_then_the_direct_key_and_are_validated():
    base = {"DATABASE_URL": "postgresql://x"}
    settings = Settings.from_env(base)
    assert settings.gemini_fallback_models == ("google/gemini-3.8-flash", "google/gemini-3.5-flash", "gemini-3.5-flash")
    assert (settings.openrouter_api_key, settings.openrouter_base_url) == ("", "https://openrouter.ai/api/v1")
    custom = Settings.from_env({**base, "GEMINI_FALLBACK_MODELS": " gemini-3.5-flash , google/gemini-3.1-flash-lite ",
                                "OPENROUTER_API_KEY": "k", "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1/"})
    assert custom.gemini_fallback_models == ("gemini-3.5-flash", "google/gemini-3.1-flash-lite")
    assert (custom.openrouter_api_key, custom.openrouter_base_url) == ("k", "https://openrouter.ai/api/v1")
    assert Settings.from_env({**base, "GEMINI_FALLBACK_MODELS": ""}).gemini_fallback_models == ()
    for bad in ("bad model!", "anthropic/claude-sonnet-5"):
        with pytest.raises(ConfigError):
            Settings.from_env({**base, "GEMINI_FALLBACK_MODELS": bad})
