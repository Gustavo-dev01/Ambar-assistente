import json
import threading
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()

# Diferente de memory.py (sem limite, decisão de arquitetura #5): standing orders são
# injetadas em TODA mensagem, não só quando relevante — sem teto, uma lista longa infla
# o prompt de forma constante em toda conversa. 20 entradas × 300 chars ≈ 6KB é generoso
# o bastante pra um usuário single-user nunca bater o teto organicamente sem perceber.
MAX_ENTRIES = 20
MAX_TEXT_LEN = 300


def _load() -> list[dict]:
    if not config.STANDING_ORDERS_FILE.exists():
        return []
    try:
        return json.loads(config.STANDING_ORDERS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(entries: list[dict]) -> None:
    config.STANDING_ORDERS_FILE.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def add(text: str) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("Ordem permanente vazia não pode ser salva.")
    if len(text) > MAX_TEXT_LEN:
        raise ValueError(f"Ordem permanente muito longa (máximo {MAX_TEXT_LEN} caracteres).")
    with _LOCK:
        entries = _load()
        if len(entries) >= MAX_ENTRIES:
            raise ValueError(
                f"Limite de {MAX_ENTRIES} ordens permanentes atingido. Remova uma antes de adicionar outra."
            )
        entry = {
            "text": text,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
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


def as_prompt_block() -> str:
    entries = all_entries()
    if not entries:
        return ""
    lines = [f"- {entry['text']}" for entry in entries]
    return (
        "Ordens permanentes do usuário (aplique em TODA conversa, mesmo sem ele repetir — "
        "não são fatos pra lembrar, são instruções de comportamento sempre ativas):\n"
        + "\n".join(lines)
    )