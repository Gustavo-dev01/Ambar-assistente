import json
import re
import threading
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()


def _load() -> list[dict]:
    if not config.PROJECTS_FILE.exists():
        return []
    try:
        return json.loads(config.PROJECTS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(projects: list[dict]) -> None:
    config.PROJECTS_FILE.write_text(
        json.dumps(projects, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "projeto"


def _unique_dir_name(name: str, existing: list[dict]) -> str:
    base = _slugify(name)
    taken = {p["workspace_dir"] for p in existing}
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def all_projects() -> list[dict]:
    with _LOCK:
        return _load()


def get(project_id: str) -> dict | None:
    with _LOCK:
        projects = _load()
    for p in projects:
        if p["id"] == project_id:
            return p
    return None


def create(name: str, description: str = "") -> dict:
    name = name.strip()
    if not name:
        raise ValueError("Nome do projeto não pode ser vazio.")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _LOCK:
        projects = _load()
        project = {
            "name": name,
            "description": description.strip(),
            "workspace_dir": _unique_dir_name(name, projects),
            "created_at": now,
            "updated_at": now,
        }
        projects.append(project)
        _save(projects)
    (config.WORKSPACE_ROOT / project["workspace_dir"]).mkdir(parents=True, exist_ok=True)
    return project


def update(project_id: str, name: str | None = None, description: str | None = None) -> bool:
    with _LOCK:
        projects = _load()
        for p in projects:
            if p["id"] == project_id:
                if name is not None and name.strip():
                    p["name"] = name.strip()
                if description is not None:
                    p["description"] = description.strip()
                p["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                _save(projects)
                return True
    return False


def delete(project_id: str) -> bool:
    with _LOCK:
        projects = _load()
        remaining = [p for p in projects if p["id"] != project_id]
        if len(remaining) == len(projects):
            return False
        _save(remaining)
        return True


def as_prompt_block(project_id: str) -> str:
    project = get(project_id)
    if not project:
        return ""
    desc = f"\nDescrição: {project['description']}" if project["description"] else ""
    return (
        f"Você está trabalhando dentro do projeto \"{project['name']}\".{desc}\n"
        f"Use a subpasta \"{project['workspace_dir']}\" do workspace para os arquivos "
        f"deste projeto (ex: path=\"{project['workspace_dir']}/arquivo.py\")."
    )