import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone

from . import config

_LOCK = threading.Lock()

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _load() -> list[dict]:
    if not config.TASKS_FILE.exists():
        return []
    try:
        return json.loads(config.TASKS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(tasks: list[dict]) -> None:
    config.TASKS_FILE.write_text(
        json.dumps(tasks, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _compute_next_run(schedule_type: str, schedule_value: dict, base: datetime | None = None) -> str:
    """Calcula next_run_at (ISO8601 UTC). base é o "agora" de referência (parametrizável
    só pra facilitar teste, sem depender do relógio real).

    HORÁRIO É INTERPRETADO NO FUSO LOCAL DA MÁQUINA, não em UTC. O usuário digita "09:00"
    olhando o relógio dele; se hour/minute fossem aplicados sobre o "agora" em UTC, uma
    tarefa pedida pras 9h dispararia às 6h da manhã num fuso UTC-3 (bug real: a tarefa era
    criada, aparecia na lista e disparava — só que na hora errada, o que é pior que não
    funcionar, porque parece certo). O armazenamento continua em UTC (comparação simples
    e sem ambiguidade no scheduler_loop); a conversão acontece aqui, na fronteira.

    Só afeta daily/weekly: "once" é um intervalo relativo (daqui N minutos), que independe
    de fuso."""
    now_utc = base or datetime.now(timezone.utc)
    if schedule_type == "once":
        # schedule_value = {"minutes_from_now": N}, calculado no momento da CRIAÇÃO e
        # nunca recalculado depois — "daqui 2 horas" é relativo a agora, não um horário fixo.
        minutes = schedule_value["minutes_from_now"]
        return (now_utc + timedelta(minutes=minutes)).isoformat(timespec="seconds")

    # astimezone() sem argumento converte pro fuso local do sistema, resolvendo horário de
    # verão pela regra vigente na data — por isso os cálculos abaixo são feitos no horário
    # local e só o resultado final volta pra UTC.
    now_local = now_utc.astimezone()

    if schedule_type == "daily":
        hour, minute = schedule_value["hour"], schedule_value["minute"]
        candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now_local:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc).isoformat(timespec="seconds")

    if schedule_type == "weekly":
        hour, minute = schedule_value["hour"], schedule_value["minute"]
        target_weekday = WEEKDAYS.index(schedule_value["weekday"])
        candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        days_ahead = (target_weekday - now_local.weekday()) % 7
        candidate += timedelta(days=days_ahead)
        if candidate <= now_local:
            candidate += timedelta(days=7)
        return candidate.astimezone(timezone.utc).isoformat(timespec="seconds")

    raise ValueError(f"Tipo de agendamento desconhecido: {schedule_type}")


def _validate_schedule(schedule_type: str, schedule_value: dict) -> None:
    """Valida schedule_type/schedule_value ANTES de gravar — tanto _compute_next_run
    quanto o disparo real (scheduler_loop) assumem que esses campos já são válidos."""
    if schedule_type == "once":
        minutes = schedule_value.get("minutes_from_now")
        if not isinstance(minutes, int) or minutes <= 0:
            raise ValueError("minutes_from_now precisa ser um inteiro positivo.")
    elif schedule_type in ("daily", "weekly"):
        hour, minute = schedule_value.get("hour"), schedule_value.get("minute")
        if not isinstance(hour, int) or not (0 <= hour <= 23):
            raise ValueError("hour precisa ser um inteiro entre 0 e 23.")
        if not isinstance(minute, int) or not (0 <= minute <= 59):
            raise ValueError("minute precisa ser um inteiro entre 0 e 59.")
        if schedule_type == "weekly" and schedule_value.get("weekday") not in WEEKDAYS:
            raise ValueError(f"weekday precisa ser um de: {', '.join(WEEKDAYS)}.")
    else:
        raise ValueError(f"schedule_type inválido: {schedule_type!r} (use once/daily/weekly).")


def create(instruction: str, schedule_type: str, schedule_value: dict) -> dict:
    instruction = instruction.strip()
    if not instruction:
        raise ValueError("Instrução da tarefa não pode ser vazia.")
    _validate_schedule(schedule_type, schedule_value)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    task = {
        "instruction": instruction,
        "schedule_type": schedule_type,
        "schedule_value": schedule_value,
        "next_run_at": _compute_next_run(schedule_type, schedule_value),
        "enabled": True,
        "last_run_at": None,
        "last_run_result": None,
        "created_at": now_iso,
    }
    with _LOCK:
        tasks = _load()
        tasks.append(task)
        _save(tasks)
    return task


def all_tasks() -> list[dict]:
    with _LOCK:
        return _load()


def due_tasks() -> list[dict]:
    """Tarefas habilitadas cujo next_run_at já passou. Usado pelo scheduler_loop."""
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return [t for t in all_tasks() if t["enabled"] and t["next_run_at"] <= now_iso]


def mark_run(task_id: str, result: str) -> None:
    """Grava o resultado e recalcula/desativa next_run_at:
    - "once": desativa (enabled=False) depois de rodar uma vez.
    - "daily"/"weekly": recalcula next_run_at pra próxima ocorrência."""
    with _LOCK:
        tasks = _load()
        for t in tasks:
            if t["id"] == task_id:
                t["last_run_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                t["last_run_result"] = result
                if t["schedule_type"] == "once":
                    t["enabled"] = False
                else:
                    t["next_run_at"] = _compute_next_run(t["schedule_type"], t["schedule_value"])
                break
        else:
            return
        _save(tasks)


def set_enabled(task_id: str, enabled: bool) -> bool:
    with _LOCK:
        tasks = _load()
        for t in tasks:
            if t["id"] == task_id:
                t["enabled"] = enabled
                _save(tasks)
                return True
    return False


def remove(task_id: str) -> bool:
    with _LOCK:
        tasks = _load()
        remaining = [t for t in tasks if t["id"] != task_id]
        if len(remaining) == len(tasks):
            return False
        _save(remaining)
        return True


def _get_or_create_automation_conversation(conversations_module) -> dict:
    """Uma única conversa persistente reservada pra automação, criada sob demanda na
    primeira tarefa que disparar. Reutiliza a MESMA conversa em disparos futuros, não
    cria uma nova a cada execução. conversations_module é passado como parâmetro (em vez
    de importado no topo) só pra deixar explícito que tasks.py não depende de server.py —
    evita import circular, já que server.py importa tasks.py pros endpoints de CRUD."""
    for c in conversations_module.all_conversations():
        if c.get("is_automation"):
            return conversations_module.get(c["id"])
    conv = conversations_module.create(first_message="Execuções automáticas")
    conversations_module.set_automation_flag(conv["id"], True)
    return conv


async def scheduler_loop(run_task_fn) -> None:
    """Loop de fundo, criado como asyncio.Task no mesmo event loop do uvicorn
    (registrado em agent/server.py via @app.on_event("startup")). run_task_fn é
    injetado (server._run_task_loop) em vez de importado direto, pra evitar import
    circular com server.py."""
    from . import conversations

    while True:
        try:
            for task in due_tasks():
                conv = _get_or_create_automation_conversation(conversations)
                conversations.append_message(conv["id"], "user", task["instruction"])
                result = await run_task_fn(conv["id"], conv.get("project_id"))
                mark_run(task["id"], result)
        except Exception:
            # Nunca deixa o loop morrer por causa de uma tarefa individual falhando.
            pass
        await asyncio.sleep(config.SCHEDULER_POLL_SECONDS)