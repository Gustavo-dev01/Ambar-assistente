import json
import threading
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()


def _load() -> list[dict]:
    if not config.MEMORY_FILE.exists():
        return []
    try:
        return json.loads(config.MEMORY_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(entries: list[dict]) -> None:
    config.MEMORY_FILE.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def add(text: str) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("Memória vazia não pode ser salva.")
    entry = {
        "text": text,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with _LOCK:
        entries = _load()
        entries.append(entry)
        _save(entries)
    return entry


def all_entries() -> list[dict]:
    with _LOCK:
        return _load()


def remove(entry_id: str) -> bool:
    with _LOCK:
        entries = _load()
        remaining = [e for e in entries if e["id"] != entry_id]
        if len(remaining) == len(entries):
            return False
        _save(remaining)
        return True


def clear() -> None:
    with _LOCK:
        _save([])


def as_prompt_block() -> str:
    entries = all_entries()
    if not entries:
        return ""
    lines = [f"- {entry['text']}" for entry in entries]
    return (
        "Memórias salvas de conversas anteriores (use como contexto quando fizer sentido, "
        "não fique repetindo isso pro usuário sem necessidade):\n" + "\n".join(lines)
    )