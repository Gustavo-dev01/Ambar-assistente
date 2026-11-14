import json
import threading
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()

TITLE_MAX_LEN = 60


def _load() -> list[dict]:
    if not config.CONVERSATIONS_FILE.exists():
        return []
    try:
        return json.loads(config.CONVERSATIONS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(conversations: list[dict]) -> None:
    config.CONVERSATIONS_FILE.write_text(
        json.dumps(conversations, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _title_from_message(text: str) -> str:
    text = " ".join(text.strip().split())
    if len(text) <= TITLE_MAX_LEN:
        return text or "Nova conversa"
    return text[:TITLE_MAX_LEN].rstrip() + "…"


def all_conversations() -> list[dict]:
    """Lista todas as conversas sem o corpo de `messages` (usado pela sidebar)."""
    with _LOCK:
        conversations = _load()
    return [
        {k: v for k, v in c.items() if k != "messages"}
        for c in conversations
    ]


def search(query: str) -> list[dict]:
    """Busca por título OU conteúdo das mensagens (case-insensitive), não só o título
    já carregado no cliente. Retorna itens leves (sem `messages`), igual all_conversations()."""
    query = query.strip().lower()
    if not query:
        return all_conversations()

    with _LOCK:
        conversations = _load()

    matches = []
    for c in conversations:
        title_hit = query in c["title"].lower()
        content_hit = any(query in m["content"].lower() for m in c["messages"])
        if title_hit or content_hit:
            matches.append({k: v for k, v in c.items() if k != "messages"})
    return matches


def get(conversation_id: str) -> dict | None:
    with _LOCK:
        conversations = _load()
    for c in conversations:
        if c["id"] == conversation_id:
            return c
    return None


def create(first_message: str = "", project_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conversation = {
        "title": _title_from_message(first_message) if first_message else "Nova conversa",
        "pinned": False,
        "project_id": project_id,
        "messages": [],
        # Resumo acumulado das mensagens mais antigas, geradas conforme a conversa
        # ultrapassa MAX_HISTORY_MESSAGES (ver server.py::_maybe_summarize_overflow).
        # Vazio até a conversa ficar longa o bastante pra precisar.
        "summary": "",
        # True só pra UMA conversa reservada, criada sob demanda pelo scheduler
        # (agent/tasks.py::_get_or_create_automation_conversation) — separa execuções
        # de tarefas agendadas da conversa que o usuário está olhando de fato.
        "is_automation": False,
        "created_at": now,
        "updated_at": now,
    }
    with _LOCK:
        conversations = _load()
        conversations.append(conversation)
        _save(conversations)
    return conversation


def append_message(
    conversation_id: str, role: str, content: str, images: list[str] | None = None
) -> None:
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                message = {"role": role, "content": content}
                if images:
                    message["images"] = images
                c["messages"].append(message)
                c["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                if role == "user" and c["title"] == "Nova conversa":
                    c["title"] = _title_from_message(content)
                break
        else:
            return
        _save(conversations)


def set_summary(conversation_id: str, summary: str) -> None:
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                c["summary"] = summary
                _save(conversations)
                return


def set_messages(conversation_id: str, messages: list[dict]) -> None:
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                c["messages"] = messages
                c["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                break
        else:
            return
        _save(conversations)


def rename(conversation_id: str, title: str) -> bool:
    title = title.strip()
    if not title:
        return False
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                c["title"] = title
                _save(conversations)
                return True
    return False


def set_pinned(conversation_id: str, pinned: bool) -> bool:
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                c["pinned"] = pinned
                _save(conversations)
                return True
    return False


def set_automation_flag(conversation_id: str, is_automation: bool) -> bool:
    with _LOCK:
        conversations = _load()
        for c in conversations:
            if c["id"] == conversation_id:
                c["is_automation"] = is_automation
                _save(conversations)
                return True
    return False


def delete(conversation_id: str) -> bool:
    with _LOCK:
        conversations = _load()
        remaining = [c for c in conversations if c["id"] != conversation_id]
        if len(remaining) == len(conversations):
            return False
        _save(remaining)
        return True