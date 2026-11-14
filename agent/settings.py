import json
import threading

from . import config

_LOCK = threading.Lock()


def _load() -> dict:
    if not config.SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(config.SETTINGS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _save(data: dict) -> None:
    config.SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_model() -> str:
    with _LOCK:
        return _load().get("model") or config.MODEL_NAME


def set_model(model: str) -> None:
    with _LOCK:
        data = _load()
        data["model"] = model
        _save(data)


def get_keep_alive():
    """Quanto tempo o Ollama mantém o modelo na memória sem uso.

    SEMPRE use isto nas chamadas ao Ollama, nunca config.OLLAMA_KEEP_ALIVE direto — essa
    constante é só o padrão de fábrica, e a preferência do usuário (tela "Modelos de IA")
    tem precedência.

    Converte com _parse_keep_alive porque o valor é salvo como string no JSON, e o Ollama
    devolve HTTP 400 pra "-1" em string — só aceita "para sempre" como o NÚMERO -1 (ver o
    comentário longo em config.py; foi um bug real que derrubou toda resposta do agente)."""
    with _LOCK:
        raw = _load().get("keep_alive")
    if not raw:
        return config.OLLAMA_KEEP_ALIVE
    return config._parse_keep_alive(str(raw))


def set_keep_alive(value: str) -> None:
    with _LOCK:
        data = _load()
        data["keep_alive"] = value
        _save(data)


def get_preload_model() -> bool:
    """Se o modelo deve ser carregado na memória junto com o app, em vez de na primeira
    pergunta. Desligado por padrão — ver config.PRELOAD_MODEL_DEFAULT."""
    with _LOCK:
        value = _load().get("preload_model")
    if value is None:
        return config.PRELOAD_MODEL_DEFAULT
    return bool(value)


def set_preload_model(enabled: bool) -> None:
    with _LOCK:
        data = _load()
        data["preload_model"] = bool(enabled)
        _save(data)


def get_contact_email() -> str:
    with _LOCK:
        return _load().get("contact_email") or ""


def set_contact_email(email: str) -> str:
    with _LOCK:
        data = _load()
        data["contact_email"] = email.strip()
        _save(data)
        return data["contact_email"]


def get_last_seen_automation() -> str:
    """ISO8601 UTC do último momento em que o usuário abriu a view Automação — usado
    pra decidir se há atividade não vista na conversa de automação (ver
    server.py::automation_status)."""
    with _LOCK:
        return _load().get("last_seen_automation_at") or ""


def set_last_seen_automation(timestamp: str) -> None:
    with _LOCK:
        data = _load()
        data["last_seen_automation_at"] = timestamp
        _save(data)