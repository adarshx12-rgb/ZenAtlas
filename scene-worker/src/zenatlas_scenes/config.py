from __future__ import annotations

import re
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODEL = "gemini-3.8-flash"
MODEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9.\-]{1,79}")
WHISPER_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/\-]{0,99}")


class ConfigError(ValueError):
    pass


def load_env_file(path: Path, environ: MutableMapping[str, str]) -> None:
    """Fill unset variables from a KEY=VALUE file; variables already in the environment win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        environ.setdefault(key, value)


def _integer(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name, "").strip().lower()
    if not raw:
        return default
    if raw not in ("true", "false"):
        raise ConfigError(f"{name} must be true or false")
    return raw == "true"


@dataclass(frozen=True)
class Settings:
    database_url: str
    gemini_api_key: str
    gemini_model: str
    gemini_timeout_seconds: int
    media_root: Path | None
    max_media_seconds: int
    max_upload_bytes: int
    daily_request_budget: int
    lease_seconds: int
    poll_seconds: int
    transcribe_fallback: bool
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        database_url = env.get("DATABASE_URL", "").strip()
        if not database_url:
            raise ConfigError("Set DATABASE_URL to the runtime PostgreSQL connection")
        model = env.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
        if not MODEL_PATTERN.fullmatch(model):
            raise ConfigError("GEMINI_MODEL must be a Gemini model code such as gemini-3.8-flash")
        root = env.get("SCENE_MEDIA_ROOT", "").strip()
        media_root = Path(root) if root else None
        if media_root is not None and not media_root.is_absolute():
            raise ConfigError("SCENE_MEDIA_ROOT must be an absolute directory path")
        timeout = _integer(env, "GEMINI_TIMEOUT_SECONDS", 600, 30, 1800)
        lease = _integer(env, "SCENE_LEASE_SECONDS", 900, 120, 7200)
        if lease < timeout + 60:
            raise ConfigError("SCENE_LEASE_SECONDS must exceed GEMINI_TIMEOUT_SECONDS by at least 60 seconds")
        whisper_model = env.get("WHISPER_MODEL", "").strip() or "small"
        compute_type = env.get("WHISPER_COMPUTE_TYPE", "").strip() or "int8"
        if not WHISPER_NAME_PATTERN.fullmatch(whisper_model) or not WHISPER_NAME_PATTERN.fullmatch(compute_type):
            raise ConfigError("WHISPER_MODEL and WHISPER_COMPUTE_TYPE must be simple names")
        device = env.get("WHISPER_DEVICE", "").strip() or "cpu"
        if device not in ("cpu", "cuda", "auto"):
            raise ConfigError("WHISPER_DEVICE must be cpu, cuda or auto")
        return cls(
            database_url=database_url,
            gemini_api_key=env.get("GEMINI_API_KEY", "").strip(),
            gemini_model=model,
            gemini_timeout_seconds=timeout,
            media_root=media_root,
            max_media_seconds=_integer(env, "SCENE_MAX_MEDIA_SECONDS", 2700, 1, 10800),
            max_upload_bytes=_integer(env, "SCENE_MAX_UPLOAD_BYTES", 2 * 1024**3, 1, 2 * 1024**3),
            daily_request_budget=_integer(env, "SCENE_ANALYSIS_DAILY_BUDGET", 20, 0, 10000),
            lease_seconds=lease,
            poll_seconds=_integer(env, "SCENE_POLL_SECONDS", 5, 1, 300),
            transcribe_fallback=_boolean(env, "SCENE_TRANSCRIBE_FALLBACK", False),
            whisper_model=whisper_model,
            whisper_device=device,
            whisper_compute_type=compute_type,
        )

    def require_gemini(self) -> None:
        if not self.gemini_api_key or self.gemini_api_key.startswith("replace-"):
            raise ConfigError("Set GEMINI_API_KEY before starting scene analysis; queued jobs stay queued until then")
