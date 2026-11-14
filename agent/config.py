import os
import sys
from pathlib import Path

# BUNDLE_DIR: onde estão os recursos embutidos no build (ex: web/). No .exe do
# PyInstaller (modo onefile) isso é uma pasta temporária extraída a cada execução
# (sys._MEIPASS) — nunca usar pra guardar dados persistentes do usuário.
# USER_DIR: onde ficam data/ e workspace/, sempre ao lado do executável real (ou do
# projeto, em dev), pra sobreviver a reinícios e a updates do .exe.
if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    USER_DIR = Path(sys.executable).resolve().parent
else:
    BUNDLE_DIR = Path(__file__).resolve().parent.parent
    USER_DIR = BUNDLE_DIR

BASE_DIR = USER_DIR
WORKSPACE_ROOT = Path(os.environ.get("AGENT_WORKSPACE", USER_DIR / "workspace")).resolve()
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
MODEL_NAME = os.environ.get("AGENT_MODEL", "qwen2.5-coder:14b")

DATA_DIR = USER_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MEMORY_FILE = DATA_DIR / "memory.json"
CONVERSATIONS_FILE = DATA_DIR / "conversations.json"
PROJECTS_FILE = DATA_DIR / "projects.json"
LIBRARY_FILE = DATA_DIR / "library.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
PROFILE_FILE = DATA_DIR / "profile.json"
KNOWLEDGE_FILE = DATA_DIR / "knowledge.json"
TASKS_FILE = DATA_DIR / "tasks.json"
STANDING_ORDERS_FILE = DATA_DIR / "standing_orders.json"
# Fichas das imagens anexadas: cores/dimensões medidas dos pixels + descrição do modelo
# de visão, pra que QUALQUER modelo (inclusive os de texto) saiba o que a imagem é.
IMAGE_CARDS_FILE = DATA_DIR / "image_cards.json"

# ---------------------------------------------------------------------------
# E-MAIL DA AMBAR SYSTEMS — TROCAR AQUI, É O ÚNICO LUGAR.
#
# É pra onde o cliente manda o e-mail dele + o código da máquina pra pedir/renovar
# "Copiar tudo". Não é dado do cliente e por isso NÃO fica em settings.json:
# é o mesmo endereço em toda instalação.
#
# Conta criada em 2026-08-13 (Gmail por enquanto; se um dia virar domínio próprio,
# trocar aqui e rebuildar — clientes com build antiga continuam vendo o endereço
# antigo, então manter o Gmail recebendo).
#
# A UI trata como "ainda não configurado" qualquer valor com "@exemplo" (rede de
# segurança pra marcador esquecido, ver isSupportEmailReal em web/app.js) — este
# endereço é real e passa nessa checagem.

NON_SENSITIVE_TAGS = {"agent-read", "agent-list"}
SENSITIVE_TAGS = {
    "agent-write", "agent-edit", "agent-delete", "agent-run", "agent-preview",
    "agent-remember", "agent-schedule", "agent-standing-order",
}

# Primeiro token liberado para iniciar um servidor de preview.
DEV_SERVER_ALLOWED = {
    "npm", "npx", "yarn", "pnpm", "node",
    "python", "python3", "py",
    "uvicorn", "flask", "vite", "next", "ng",
}

# Trechos que bloqueiam um <agent-run>, mesmo depois de aprovado manualmente. Filtro por
# substring simples — não é à prova de ofuscação/variação de sintaxe, é só uma rede de
# segurança adicional pros casos mais óbvios/comuns (cmd.exe e PowerShell). A defesa
# principal continua sendo a confirmação manual: ver RISKY_COMMAND_PATTERNS abaixo, que
# gera um aviso visual na tela de confirmação em vez de bloquear.
BLOCKED_TOKENS = [
    "rm -rf /",
    "rm -rf ~",
    "format ",
    "mkfs",
    "del /f /s /q c:\\",
    ":(){:|:&};:",
    "shutdown",
    "remove-item -recurse -force c:\\",
    # Variações de PowerShell (alias e nome completo, com/sem aspas em "c:\").
    "remove-item -recurse -force \"c:\\",
    "remove-item -recurse -force 'c:\\",
    "ri -recurse -force c:\\",
    "rm -recurse -force c:\\",
    "format-volume",
    "clear-disk",
    "remove-item -recurse -force $env:userprofile",
    "remove-item -recurse -force $home",
    "stop-computer",
    "restart-computer",
    "reg delete hklm",
    "reg delete hkcu",
    "vssadmin delete shadows",
    "cipher /w",
]

# Padrões que não bloqueiam o comando, só disparam um aviso destacado na tela de
# confirmação (o usuário decide se aprova mesmo assim). Cobrem sinais de "isso é
# potencialmente destrutivo" sem tentar prever toda variação possível de sintaxe.
RISKY_COMMAND_PATTERNS = [
    "rm -rf", "rm -r ", "remove-item", "ri -r", "del /", "erase ",
    "format", "diskpart", "reg delete", "reg add",
    "shutdown", "restart-computer", "stop-computer",
    "net user", "icacls", "takeown",
    "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
    "> c:\\", ">c:\\",
]

# Padrões que indicam um comando referenciando um caminho fora da workspace —
# agent-run/agent-preview bloqueiam sempre que um destes aparece, mesmo aprovados
# manualmente. run_command roda com cwd=WORKSPACE_ROOT mas não valida o CONTEÚDO do
# comando, então nada impedia (antes desta lista) um comando de shell escrever fora do
# sandbox via caminho absoluto ou variável de perfil (ex: redirecionar pra
# "C:\Users\<usuário>\arquivo.txt" ou "$env:USERPROFILE\..."), contornando por completo
# a proteção de safe_path() que agent-write/agent-edit/agent-delete já têm. A checagem
# em tools.py._references_outside_workspace() trata a exceção de um caminho absoluto que
# aponte PRA DENTRO da própria WORKSPACE_ROOT (legítimo) — esta lista aqui cobre só os
# atalhos que sempre significam "fora", não caminhos completos de usuário.
OUT_OF_WORKSPACE_PATTERNS = [
    "$env:userprofile", "%userprofile%", "~\\", "~/",
    "$env:appdata", "%appdata%", "$env:localappdata", "%localappdata%",
]

MAX_TOOL_LOOPS = 8
COMMAND_TIMEOUT_SECONDS = 60

# Sem isso, o Ollama usa o num_ctx padrão do Modelfile do modelo (geralmente 2048-4096
# tokens) — bem menor que os 128k que modelos como qwen2.5vl suportam. Em conversas
# longas isso faz o Ollama truncar/reprocessar o prompt de forma cara a cada chamada,
# degradando o tempo de resposta progressivamente. 8192 é um meio-termo: cobre bem mais
# que o padrão sem exigir VRAM demais numa GPU de 12GB compartilhada com outros usos.
OLLAMA_NUM_CTX = int(os.environ.get("AGENT_NUM_CTX", "8192"))

# Sem isso, o Ollama descarrega o modelo da VRAM após 5min de ociosidade (padrão dele).
# Cada mensagem depois disso recarrega o modelo inteiro do disco pra VRAM antes de
# começar a gerar — um pico de disco alto por dezenas de segundos (modelo de 9GB) sem uso
# de GPU durante a leitura, facilmente confundido com "o agente travou" ou "a GPU não está
#
# PADRÃO "30m", NÃO -1: o Ambar passou a ser distribuído pra outras máquinas, e -1 (nunca
# descarregar) é agressivo demais como padrão de fábrica — numa GPU pequena, segurar
# vários GB indefinidamente atrapalha o resto do sistema do usuário. "30m" cobre uma
# sessão de trabalho contínua e devolve a memória quando o app fica parado. Quem tem
# folga de VRAM troca pra "Sempre" na tela de Modelos de IA (settings.get_keep_alive()),
# sem precisar mexer em variável de ambiente.
#
# Este valor é só o PADRÃO — a preferência salva pelo usuário tem precedência. Nunca use
# config.OLLAMA_KEEP_ALIVE direto nas chamadas ao Ollama; use settings.get_keep_alive().
#
# CUIDADO com o tipo: o Ollama aceita duração como STRING ("30m", "1h") mas o valor
# "para sempre" tem que ser o NÚMERO -1 — mandar a string "-1" devolve HTTP 400 e
# derruba toda resposta do agente (bug real já cometido aqui). Por isso a conversão
# explícita abaixo em vez de deixar o valor de env cru.
def _parse_keep_alive(raw: str):
    """-1/números viram int (segundos, ou -1 = infinito); o resto continua string de
    duração ("30m", "1h"), que o Ollama aceita normalmente."""
    try:
        return int(raw)
    except ValueError:
        return raw


OLLAMA_KEEP_ALIVE = _parse_keep_alive(os.environ.get("AGENT_OLLAMA_KEEP_ALIVE", "30m"))

# Opções oferecidas na tela "Modelos de IA". O valor é o que vai pro Ollama (int -1 =
# nunca descarregar; string = duração). Manter em sincronia com o <select> do frontend.
KEEP_ALIVE_CHOICES = {
    "5m": "5 minutos (libera a memória rápido)",
    "30m": "30 minutos (recomendado)",
    "2h": "2 horas",
    "-1": "Sempre carregado (exige memória sobrando)",
}

# Pré-carregar o modelo na memória assim que o Ambar abre, em vez de esperar a primeira
# pergunta do usuário. DESLIGADO por padrão de propósito: em máquina fraca, ocupar vários
# GB só porque o app foi aberto (talvez só pra ler o histórico) é pior que esperar o
# carregamento na primeira pergunta. Quem tem folga liga na tela de Modelos de IA.
PRELOAD_MODEL_DEFAULT = os.environ.get("AGENT_PRELOAD_MODEL", "0") == "1"

# Quantas mensagens mais recentes de HISTORY são enviadas ao modelo a cada chamada
# (além do system prompt). Limita o crescimento do prompt em conversas longas — a
# conversa inteira continua salva em disco (conversations.json), só não vai toda pro
# modelo a cada mensagem. Número ímpar não importa aqui; só um teto razoável de turnos
# recentes de contexto.
MAX_HISTORY_MESSAGES = int(os.environ.get("AGENT_MAX_HISTORY_MESSAGES", "40"))

# Imagens custam muito mais tokens/VRAM que texto equivalente (cada imagem em
# qwen2.5vl consome uma fatia grande do context window sozinha). Só as mensagens com
# imagem mais recentes (contando de trás pra frente dentro de MAX_HISTORY_MESSAGES)
# mandam a imagem de verdade ao modelo; imagens mais antigas na mesma janela viram só
# um marcador textual — a imagem original continua salva e visível normalmente na UI,
# só para de ser reenviada em todo turno seguinte da conversa.
MAX_IMAGE_MESSAGES = int(os.environ.get("AGENT_MAX_IMAGE_MESSAGES", "2"))

# Modelo de embedding usado pela busca semântica da base de conhecimento
# (agent/knowledge.py). Separado de MODEL_NAME porque é um modelo especializado em
# vetorizar texto, não em conversar — nunca aparece na tela "Modelos de IA" nem é
# trocado pelo usuário. Precisa estar instalado no Ollama (`ollama pull bge-m3`); se
# não estiver, knowledge.py cai de volta pra busca por palavra-chave automaticamente
# (ver knowledge.py::search). bge-m3 (multilíngue) escolhido depois de testado
# empiricamente contra nomic-embed-text em textos curtos/português: nomic-embed-text
# tinha baixa discriminação (pares não relacionados já ficavam em ~0.40-0.55 de
# similaridade de cosseno, quase colado nos relacionados 0.55-0.71); bge-m3 separa bem
# melhor (relacionados 0.50-0.76, não relacionados 0.16-0.37).
EMBEDDING_MODEL = os.environ.get("AGENT_EMBEDDING_MODEL", "bge-m3")

# Intervalo entre verificações de tarefas agendadas vencidas (agent/tasks.py::scheduler_loop).
# 30s é granularidade suficiente pra "daqui 2 horas"/"às 9h" sem gerar overhead perceptível —
# não precisa ser exato ao segundo. Baixado via AGENT_SCHEDULER_POLL_SECONDS em testes manuais.
SCHEDULER_POLL_SECONDS = int(os.environ.get("AGENT_SCHEDULER_POLL_SECONDS", "30"))