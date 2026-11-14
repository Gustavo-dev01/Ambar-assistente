import json
import threading

from . import config

_LOCK = threading.Lock()

DEFAULTS = {"name": "Você"}


def _load() -> dict:
    if not config.PROFILE_FILE.exists():
        return dict(DEFAULTS)
    try:
        data = json.loads(config.PROFILE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return dict(DEFAULTS)
    # Só o nome sai daqui. Arquivos salvos antes de 2026-08-10 têm um "email"
    # que a UI não mostra mais — descartado na leitura pra não vazar de volta
    # pro frontend nem ser regravado no _save().
    return {**DEFAULTS, "name": data.get("name") or DEFAULTS["name"]}


def _save(data: dict) -> None:
    config.PROFILE_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get() -> dict:
    with _LOCK:
        return _load()


def update(name: str | None = None) -> dict:
    with _LOCK:
        data = _load()
        if name is not None and name.strip():
            data["name"] = name.strip()
        _save(data)
        return data