import json
import threading
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()


def _load() -> list[dict]:
    if not config.LIBRARY_FILE.exists():
        return []
    try:
        return json.loads(config.LIBRARY_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(items: list[dict]) -> None:
    config.LIBRARY_FILE.write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def all_items() -> list[dict]:
    with _LOCK:
        return _load()


def create(name: str, content: str) -> dict:
    name = name.strip()
    content = content.strip()
    if not name:
        raise ValueError("Nome do item não pode ser vazio.")
    if not content:
        raise ValueError("Conteúdo do item não pode ser vazio.")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    item = {
        "name": name,
        "content": content,
        "created_at": now,
    }
    with _LOCK:
        items = _load()
        items.append(item)
        _save(items)
    return item


def remove(item_id: str) -> bool:
    with _LOCK:
        items = _load()
        remaining = [i for i in items if i["id"] != item_id]
        if len(remaining) == len(items):
            return False
        _save(remaining)
        return True