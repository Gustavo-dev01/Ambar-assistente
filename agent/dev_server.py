import os
import re
import subprocess
import threading

from . import config, tools

_PORT_PATTERN = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])[:/](\d+)")

CREATE_NO_WINDOW = 0x08000000  # só existe no Windows; app é Windows-only.

# Teto de espera de cada chamada externa (netstat/taskkill/wait). start() e stop() são
# SÍNCRONOS e chegam a ser chamados de dentro do fluxo do agente, então cada segundo
# aqui é um segundo com o app inteiro parado. Eram 5s cada, somando até ~20s de
# congelamento aparente. taskkill/netstat resolvem em milissegundos quando funcionam;
# se estourar, é porque não vão funcionar mesmo — esperar mais não ajuda.
_SUBPROC_TIMEOUT = 2


class DevServerState:
    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.command: str | None = None
        self.url: str | None = None
        self.entry_path: str | None = None
        self.output_lines: list[str] = []
        self.lock = threading.Lock()


STATE = DevServerState()

# Último arquivo .html escrito pelo agente (caminho relativo à workspace). Serve de
# "página inicial" do preview: sem isso, `python -m http.server` responde a LISTAGEM da
# pasta, e o usuário via os próprios arquivos pessoais (PDFs, textos, outros projetos)
# em vez do que acabou de pedir. Atualizado por server.py a cada agent-write de HTML.
_LAST_HTML: str | None = None


def remember_html(path: str) -> None:
    """Registra o HTML recém-criado como página de entrada do próximo preview."""
    global _LAST_HTML
    _LAST_HTML = path.replace("\\", "/").lstrip("/")


_COMMAND_PORT_PATTERN = re.compile(r"\b(\d{4,5})\b")


def _kill_orphan_on_port(port: str) -> None:
    """Mata qualquer processo órfão de uma execução anterior do preview que ainda esteja
    escutando nessa porta (ex: Ambar fechado via crash/Encerrar Tarefa, sem passar pelo
    stop() normal em app.py). Melhor esforço: usa netstat/taskkill do próprio Windows,
    sem dependência nova (psutil). Nunca levanta — se falhar, start() segue e o próximo
    subprocess.Popen pode simplesmente não conseguir bindar, erro visível de qualquer jeito."""
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
            timeout=_SUBPROC_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return

    pids = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == "TCP" and f":{port}" in parts[1] and "LISTENING" in parts[3]:
            pids.add(parts[-1])

    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/PID", pid, "/F"],
                capture_output=True,
                creationflags=CREATE_NO_WINDOW,
                timeout=_SUBPROC_TIMEOUT,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass


def _check_allowed(command: str) -> None:
    first_token = command.strip().split(" ")[0].lower()
    if first_token not in config.DEV_SERVER_ALLOWED:
        raise PermissionError(
            f"Comando '{first_token}' não está liberado para preview. "
            f"Permitidos: {', '.join(sorted(config.DEV_SERVER_ALLOWED))}"
        )
    if tools._references_outside_workspace(command):
        raise PermissionError(
            "Comando bloqueado: referencia um caminho fora da workspace "
            f"({config.WORKSPACE_ROOT})."
        )


def start(command: str) -> str:
    _check_allowed(command)
    with STATE.lock:
        if STATE.process and STATE.process.poll() is None:
            raise RuntimeError(
                f"Já existe um servidor rodando (PID {STATE.process.pid}, comando '{STATE.command}'). "
                "Pare antes de iniciar outro."
            )
        port_match = _COMMAND_PORT_PATTERN.search(command)
        if port_match:
            _kill_orphan_on_port(port_match.group(1))

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        STATE.process = subprocess.Popen(
            command,
            shell=True,
            cwd=config.WORKSPACE_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
        STATE.command = command
        STATE.url = None
        # Congela o alvo no início: se o agente escrever outro HTML enquanto o servidor
        # roda, a URL deste preview não muda no meio do caminho.
        STATE.entry_path = _LAST_HTML
        STATE.output_lines = []

    threading.Thread(target=_watch_output, daemon=True).start()
    return f"Servidor iniciado (PID {STATE.process.pid}) com o comando: {command}. Detectando a porta local..."


def _watch_output():
    proc = STATE.process
    if not proc or not proc.stdout:
        return
    for line in proc.stdout:
        # Tudo que pode DEMORAR fica fora do lock. Antes, o is_file() (acesso a disco)
        # rodava com o lock na mão, e o `for line in proc.stdout` volta a bloquear logo
        # em seguida esperando a próxima linha: se stop() pedisse o lock nesse intervalo,
        # os dois lados ficavam esperando um ao outro e o app inteiro congelava com a CPU
        # em 0% — foi exatamente o travamento relatado em 2026-08-12.
        texto = line.rstrip()
        nova_url = None
        match = _PORT_PATTERN.search(line)
        if match:
            base = f"http://127.0.0.1:{match.group(1)}"
            # Aponta direto pro HTML recém-criado quando ele existe de verdade na
            # workspace: o usuário vê o que pediu em vez de uma lista de arquivos, e a
            # listagem deixa de expor o resto da pasta.
            entry = STATE.entry_path
            nova_url = (
                f"{base}/{entry}"
                if entry and (config.WORKSPACE_ROOT / entry).is_file()
                else base
            )

        with STATE.lock:
            if proc is not STATE.process:
                return
            STATE.output_lines.append(texto)
            if STATE.url is None and nova_url:
                STATE.url = nova_url

        if proc.poll() is not None:
            break


def stop() -> str:
    with STATE.lock:
        if not STATE.process or STATE.process.poll() is not None:
            STATE.process = None
            STATE.url = None
            return "Nenhum servidor de preview rodando."
        # taskkill /T (mata a árvore inteira), não terminate()/kill(): como start() usa
        # shell=True, o PID do Popen é o cmd.exe intermediário no Windows — terminate()
        # matava só esse processo, deixando o processo real do servidor (ex: python -m
        # http.server, PID diferente) órfão e ainda ocupando a porta.
        try:
            subprocess.run(
                ["taskkill", "/PID", str(STATE.process.pid), "/T", "/F"],
                capture_output=True,
                creationflags=CREATE_NO_WINDOW,
                timeout=_SUBPROC_TIMEOUT,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        # wait() DENTRO do try: se o taskkill não deu conta (processo preso, permissão),
        # o TimeoutExpired daqui subia e o estado NUNCA era limpo — o Ambar ficava
        # convencido de que o servidor ainda existe e recusava iniciar outro, sem forma
        # de sair disso a não ser reabrir o app (travamento relatado em 2026-08-12).
        try:
            STATE.process.wait(timeout=_SUBPROC_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired):
            pass
        STATE.process = None
        STATE.url = None
        STATE.command = None
        STATE.entry_path = None
        return "Servidor de preview parado."


def status() -> dict:
    with STATE.lock:
        running = STATE.process is not None and STATE.process.poll() is None
        return {
            "running": running,
            "command": STATE.command,
            "url": STATE.url,
            "recent_output": STATE.output_lines[-20:],
        }