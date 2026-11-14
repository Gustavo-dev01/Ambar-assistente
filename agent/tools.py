import re
import shutil
import subprocess
from pathlib import Path

from pypdf import PdfReader

from . import config

CREATE_NO_WINDOW = 0x08000000  # só existe no Windows; app é Windows-only.

# Caminho absoluto Windows: letra de unidade + ":\" ou ":/", seguido de qualquer coisa
# que não seja um caractere que claramente encerra um path no shell (redirecionamento,
# pipe, aspas, quebra de linha). Precisa aceitar espaço no meio — o nome de usuário do
# Windows pode ter espaço (ex: "C:\Users\Gustavo Almeida\..."), e cortar no primeiro
# espaço faria um path DENTRO da própria workspace ser incorretamente marcado como
# "fora" só por causa do espaço no nome da pasta do usuário.
_ABS_WINDOWS_PATH = re.compile(r"[a-zA-Z]:[\\/][^\"'<>|\r\n]*")

# Qualquer token que contenha ".." como componente de caminho — "..", "../x", "..\\x",
# "a/../../b". Não casa nomes legítimos que só contêm dois pontos no meio da palavra
# (ex: "arquivo..txt" não é escape, mas "..\\arquivo" é).
_DOTDOT_TOKEN = re.compile(r"(?:^|[\s\"'=(])((?:[^\s\"'<>|]*[\\/])?\.\.(?:[\\/][^\s\"'<>|]*)?)")

# `cd ..` (ou `cd /d ..`, `chdir ..`) muda o diretório de trabalho pra fora da workspace
# antes do resto do comando rodar — o cwd=WORKSPACE_ROOT do subprocess deixa de valer.
_CD_ESCAPE = re.compile(r"\b(?:cd|chdir|pushd|set-location|sl)\b[^&|;\r\n]*\.\.", re.IGNORECASE)


def _escapes_via_relative_path(command: str) -> bool:
    """True se algum token do comando usa ".." pra sair da workspace.

    Não basta procurar ".." literal: "subpasta/../outra" continua DENTRO da workspace e
    seria um falso positivo. Por isso cada token com ".." é resolvido contra
    WORKSPACE_ROOT e só é recusado se o resultado cair fora dela — mesma regra do
    safe_path(), aplicada ao texto do comando.

    Vulnerabilidade real que motivou isso: `del ..\\documento.txt` apagava arquivo fora
    do sandbox de verdade (a checagem antiga só olhava caminho absoluto e variáveis de
    ambiente, então caminho relativo passava direto)."""
    if _CD_ESCAPE.search(command):
        return True

    workspace = config.WORKSPACE_ROOT.resolve()
    for match in _DOTDOT_TOKEN.finditer(command):
        token = match.group(1).strip().strip("\"'")
        try:
            resolved = (workspace / token).resolve()
        except (OSError, ValueError):
            # Caminho malformado pro SO: trata como suspeito em vez de deixar passar.
            return True
        if resolved != workspace and workspace not in resolved.parents:
            return True
    return False


def _references_outside_workspace(command: str) -> bool:
    """True se o comando parece referenciar um caminho fora de WORKSPACE_ROOT — atalhos
    de perfil (OUT_OF_WORKSPACE_PATTERNS), um caminho absoluto tipo "C:\\..." que não
    aponte pra dentro da própria workspace, ou um caminho relativo com ".." que escape
    dela. Melhor esforço (não faz parsing de shell de verdade), mas cobre os casos reais
    que motivaram isso: agent-run sendo usado pra escrever fora do sandbox depois de
    agent-write falhar, e `del ..\\arquivo` apagando fora da workspace."""
    lowered = command.lower()
    if any(pattern in lowered for pattern in config.OUT_OF_WORKSPACE_PATTERNS):
        return True
    workspace = str(config.WORKSPACE_ROOT).lower()
    for match in _ABS_WINDOWS_PATH.finditer(command):
        candidate = match.group(0).strip().rstrip("\\/").lower()
        if candidate == workspace or candidate.startswith(workspace + "\\") or candidate.startswith(workspace + "/"):
            continue
        return True
    return _escapes_via_relative_path(command)


class UnsafePathError(Exception):
    pass


def safe_path(relative_path: str) -> Path:
    relative_path = relative_path or "."
    candidate = (config.WORKSPACE_ROOT / relative_path).resolve()
    try:
        candidate.relative_to(config.WORKSPACE_ROOT)
    except ValueError:
        raise UnsafePathError(f"Caminho fora da workspace: {relative_path}")
    return candidate


def _read_pdf(target: Path) -> str:
    """PDF é binário — read_text(encoding="utf-8") nele produziria lixo ilegível, não o
    conteúdo real do documento. Extrai o texto de cada página via pypdf em vez disso.
    PDFs de imagem escaneada (sem camada de texto) retornam string vazia por página —
    pypdf não faz OCR, e isso não é tratado como erro (o modelo só vê pouco/nenhum texto)."""
    reader = PdfReader(str(target))
    if reader.is_encrypted:
        raise ValueError(f"PDF protegido por senha, não é possível extrair o texto: {target.name}")
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(pages).strip()
    if not text:
        raise ValueError(
            f"Não foi possível extrair texto de {target.name} — provavelmente é um PDF "
            "escaneado (imagem sem camada de texto), que não é suportado."
        )
    return text


def read_file(path: str) -> str:
    target = safe_path(path)
    if not target.is_file():
        raise FileNotFoundError(f"Arquivo não encontrado: {path}")
    if target.suffix.lower() == ".pdf":
        return _read_pdf(target)
    return target.read_text(encoding="utf-8", errors="replace")


def list_files(path: str = ".") -> str:
    target = safe_path(path)
    if not target.is_dir():
        raise NotADirectoryError(f"Não é uma pasta: {path}")
    entries = []
    for item in sorted(target.iterdir()):
        kind = "dir" if item.is_dir() else "file"
        entries.append(f"{kind}\t{item.relative_to(config.WORKSPACE_ROOT)}")
    return "\n".join(entries) if entries else "(pasta vazia)"


_FENCE_OPEN = re.compile(r"^\s*```[a-zA-Z0-9+-]*[ \t]*\r?\n")
_FENCE_CLOSE = re.compile(r"\r?\n[ \t]*```\s*$")


def _strip_markdown_fence(content: str) -> str:
    """Remove a cerca de markdown que o modelo às vezes grava DENTRO do arquivo.

    Modelos locais tendem a envolver código em ```html ... ```, e quando isso vai pro
    conteúdo de <agent-write> o arquivo nasce quebrado: num HTML, o ```html vira texto
    visível no topo da página (bug real relatado em 2026-08-11).

    Só remove quando a cerca ABRE na primeira linha E FECHA na última — ou seja, quando
    ela envolve o arquivo inteiro. Um .md legítimo com blocos de código no MEIO não é
    tocado, e um arquivo que só começa com crase (sem fechar no fim) também não."""
    if not _FENCE_OPEN.search(content) or not _FENCE_CLOSE.search(content):
        return content
    return _FENCE_CLOSE.sub("", _FENCE_OPEN.sub("", content, count=1))


# <link href="..."> e <script src="..."> apontando pro MESMO arquivo, repetidos no HTML.
_DUP_LINK = re.compile(
    r'^[ \t]*<link\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>[ \t]*\r?\n?', re.IGNORECASE | re.MULTILINE
)
_DUP_SCRIPT = re.compile(
    r'^[ \t]*<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>\s*</script>[ \t]*\r?\n?',
    re.IGNORECASE | re.MULTILINE,
)


def _dedupe_html_refs(content: str) -> str:
    """Remove <link href> / <script src> repetidos pro mesmo arquivo, mantendo o primeiro.

    Modelos locais editam por acréscimo: a cada ajuste no HTML eles acrescentam de novo a
    linha do CSS em vez de reaproveitar a existente. Numa conversa real o mesmo
    <link rel="stylesheet" href="style.css"> chegou a aparecer 4 vezes (2026-08-12). Não
    quebra a página, mas cresce a cada edição e é sujeira que o cliente vê no arquivo.

    Só remove quando o alvo (href/src) é EXATAMENTE igual a um já visto — dois CSS
    diferentes, ou o mesmo nome com query diferente (`a.css` vs `a.css?v=2`), são
    preservados: podem ser intencionais."""
    vistos: set[str] = set()

    def _filtra(match: re.Match) -> str:
        alvo = match.group(1).strip()
        chave = (match.group(0).strip().split()[0].lower(), alvo)  # ("<link"|"<script", alvo)
        if chave in vistos:
            return ""
        vistos.add(chave)
        return match.group(0)

    return _DUP_SCRIPT.sub(_filtra, _DUP_LINK.sub(_filtra, content))


def write_file(path: str, content: str) -> str:
    content = _strip_markdown_fence(content)
    if path.lower().endswith((".html", ".htm")):
        content = _dedupe_html_refs(content)
    if not path or not path.strip():
        raise ValueError(
            "path vazio em <agent-write> — provavelmente uma tag mal formada (ver parse_tags). "
            "Reemita a tag com um path de arquivo válido."
        )
    target = safe_path(path)
    if target.is_dir():
        raise IsADirectoryError(f"'{path}' é uma pasta, não um arquivo — não é possível escrever nela.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Arquivo escrito: {path} ({len(content)} caracteres)"


def edit_file(path: str, search: str, replace: str) -> str:
    target = safe_path(path)
    if not target.is_file():
        raise FileNotFoundError(f"Arquivo não encontrado: {path}")
    original = target.read_text(encoding="utf-8", errors="replace")
    count = original.count(search)
    if count == 0:
        raise ValueError("Trecho de busca não encontrado no arquivo (confira espaços/indentação).")
    if count > 1:
        raise ValueError(f"Trecho de busca encontrado {count} vezes — inclua mais contexto para torná-lo único.")
    novo = original.replace(search, replace, 1)
    aviso = ""
    if path.lower().endswith((".html", ".htm")):
        # É por aqui que a duplicata entra: o modelo "edita" acrescentando outra vez a
        # linha do CSS. Limpar na escrita não bastaria — a edição incremental é o
        # caminho mais usado pra ajustes pequenos.
        limpo = _dedupe_html_refs(novo)
        if limpo != novo:
            aviso = " (removi referências <link>/<script> duplicadas)"
            novo = limpo
    target.write_text(novo, encoding="utf-8")
    return f"Arquivo editado: {path} ({len(search)} → {len(replace)} caracteres no trecho){aviso}"


def count_tree(target: Path) -> tuple[int, int]:
    """(arquivos, subpastas) dentro de target. Usado pra mostrar o tamanho do estrago na
    tela de confirmação ANTES do usuário aprovar — apagar pasta é recursivo e não passa
    pela Lixeira, então "vai apagar 143 arquivos" é a informação que evita o clique errado."""
    files = dirs = 0
    for item in target.rglob("*"):
        if item.is_dir():
            dirs += 1
        else:
            files += 1
    return files, dirs


def delete_file(path: str) -> str:
    """Apaga arquivo OU pasta (recursivo), sempre dentro da workspace.

    safe_path() já garante o sandbox (recusa "../" e caminho absoluto). Além dele, a
    própria RAIZ da workspace é protegida: um único comando não pode levar tudo. O
    usuário ainda pode apagar cada item de dentro individualmente — o que fica barrado é
    a pasta-contêiner, cuja remoção quebraria o agente (é o cwd de todo agent-run e o
    alvo de todo safe_path)."""
    target = safe_path(path)
    if not target.exists():
        raise FileNotFoundError(f"Arquivo ou pasta não encontrado: {path}")

    if target.resolve() == config.WORKSPACE_ROOT.resolve():
        raise PermissionError(
            "Não é possível apagar a própria pasta da workspace. Para limpar tudo, "
            "apague os itens de dentro dela individualmente."
        )

    if target.is_dir():
        files, dirs = count_tree(target)
        shutil.rmtree(target)
        if files or dirs:
            return f"Pasta apagada: {path} (com {files} arquivo(s) e {dirs} subpasta(s))"
        return f"Pasta vazia apagada: {path}"

    target.unlink()
    return f"Arquivo apagado: {path}"


def run_command(command: str) -> str:
    lowered = command.lower()
    for token in config.BLOCKED_TOKENS:
        if token.lower() in lowered:
            raise PermissionError(f"Comando bloqueado por segurança (contém: '{token}')")
    if _references_outside_workspace(command):
        raise PermissionError(
            "Comando bloqueado: referencia um caminho fora da workspace "
            f"({config.WORKSPACE_ROOT}). Todo arquivo criado/lido deve ficar dentro dela."
        )

    result = subprocess.run(
        command,
        shell=True,
        cwd=config.WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        timeout=config.COMMAND_TIMEOUT_SECONDS,
        # Sem CREATE_NO_WINDOW um console preto pisca a cada agent-run aprovado. A saída
        # já é capturada e mostrada no chat, então a janela não tem função nenhuma além
        # de assustar o usuário (ver mesmo flag em dev_server.py e app.py).
        creationflags=CREATE_NO_WINDOW,
    )
    output = (result.stdout + result.stderr).strip()
    return output or f"(comando executado, código de saída {result.returncode}, sem saída)"