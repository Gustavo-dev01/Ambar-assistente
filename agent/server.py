import asyncio
import base64
import json
import re
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import (
    memory, ollama_models, profile, projects, settings, standing_orders, tasks, tools,
)
from .prompt import build_system_prompt
from .tags import ToolCall, parse_edit_block, parse_tags

app = FastAPI()

# HISTORY é sempre a lista de mensagens da conversa ativa (ACTIVE_ID). Toda mutação
# em HISTORY precisa ser seguida de conversations.set_messages/append_message pra
# persistir em data/conversations.json. ACTIVE_PROJECT_ID acompanha o project_id da
# conversa ativa (ou None) e é usado só pra montar o system prompt.
HISTORY: list[dict] = []
ACTIVE_ID: str | None = None
ACTIVE_PROJECT_ID: str | None = None
# Cada valor é (call, tags_restantes_da_mesma_resposta, conversation_id_de_origem) —
# quando uma resposta do modelo tem várias tags sensíveis (ex: agent-write +
# agent-preview), as que vêm depois da primeira ficam guardadas aqui em vez de
# descartadas, pra serem processadas em sequência após a confirmação atual, sem
# depender do modelo "lembrar" de re-emitir a tag numa resposta seguinte (ver bug
# ao vivo (conversa ATIVA, comportamento de sempre); é o id da conversa de automação
# quando veio de uma tarefa agendada disparando sozinha (ver tasks.py/_run_task_loop) —
# usado em /confirm pra saber em qual conversa gravar o resultado.
PENDING: dict[str, tuple[ToolCall, list[ToolCall], str | None]] = {}

# Resumo acumulado das mensagens antigas de HISTORY que já saíram da janela de contexto
# (ver _maybe_summarize_overflow). SUMMARIZED_COUNT é quantas mensagens de HISTORY já
# foram incorporadas em HISTORY_SUMMARY, pra saber a partir de onde resumir da próxima
# vez sem reprocessar o que já foi resumido. Ambos recarregados ao trocar de conversa
# (activate_conversation) e resetados em /reset.
HISTORY_SUMMARY: str = ""
SUMMARIZED_COUNT: int = 0

CONFIRM_MARK = "\x01"

# Se há um carregamento de modelo em andamento agora. Só pra UI poder dizer "carregando"
# em vez de deixar o usuário achando que travou, e pra não disparar dois carregamentos
# simultâneos do mesmo modelo. Dict (não bool solto) pra poder mutar de dentro de uma
# task sem `global`.
PRELOAD_STATE: dict = {"running": False}


async def _preload_in_background(model: str) -> None:
    """Carrega o modelo na memória sem segurar nenhuma requisição HTTP.

    Nunca propaga exceção: pré-carregar é conforto. Se falhar (Ollama fora do ar, modelo
    removido), o app continua funcionando normalmente — só volta a pagar o carregamento
    na primeira mensagem, que é o comportamento de sempre."""
    PRELOAD_STATE["running"] = True
    try:
        await ollama_models.preload(model, settings.get_keep_alive())
    except Exception:
        pass
    finally:
        PRELOAD_STATE["running"] = False


def _ensure_active_conversation() -> str:
    global ACTIVE_ID, ACTIVE_PROJECT_ID, HISTORY_SUMMARY, SUMMARIZED_COUNT
    if ACTIVE_ID is None:
        conv = conversations.create(project_id=ACTIVE_PROJECT_ID)
        ACTIVE_ID = conv["id"]
        HISTORY_SUMMARY = ""
        SUMMARIZED_COUNT = 0
    return ACTIVE_ID


async def _stream_model(messages: list[dict]):
    payload = {
        "model": settings.get_model(),
        "messages": messages,
        "stream": True,
        "options": {"num_ctx": config.OLLAMA_NUM_CTX},
        "keep_alive": settings.get_keep_alive(),
    }
    buffer = b""
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", f"{config.OLLAMA_HOST}/api/chat", json=payload) as response:
            response.raise_for_status()
            # Usamos bytes crus + json.loads (que sempre assume UTF-8, conforme a RFC do
            # JSON) em vez de aiter_lines(), porque o httpx tenta adivinhar o charset da
            # resposta e às vezes erra em streaming, corrompendo acentos.
            async for chunk in response.aiter_bytes():
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("done"):
                        return
                    content = data.get("message", {}).get("content", "")
                    if content:
                        yield content


def _format_messages_for_summary(messages: list[dict]) -> str:
    lines = []
    for m in messages:
        role = "Usuário" if m["role"] == "user" else "Ambar"
        text = m["content"]
        if m.get("images"):
            text = f"[mensagem com imagem anexada] {text}".strip()
        lines.append(f"{role}: {text}")
    return "\n".join(lines)


async def _summarize_block(previous_summary: str, block: list[dict]) -> str:
    """Chamada não-streaming e sem tags ao modelo, só pra condensar um trecho de
    HISTORY que está prestes a sair da janela de contexto enviada normalmente."""
    prior_section = f"Resumo do que já aconteceu antes disso:\n{previous_summary}\n\n" if previous_summary else ""
    prompt = (
        "Resuma a conversa abaixo em poucas frases objetivas, preservando decisões tomadas, "
        "fatos importantes e o que ficou pendente. Não invente nada que não esteja no texto. "
        "Responda só com o resumo, sem introdução.\n\n"
        f"{prior_section}Trecho a resumir:\n{_format_messages_for_summary(block)}"
    )
    payload = {
        "model": settings.get_model(),
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"num_ctx": config.OLLAMA_NUM_CTX},
        "keep_alive": settings.get_keep_alive(),
    }
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(f"{config.OLLAMA_HOST}/api/chat", json=payload)
        response.raise_for_status()
        return response.json().get("message", {}).get("content", "").strip()


async def _maybe_summarize_overflow() -> None:
    """Quando HISTORY cresce além de MAX_HISTORY_MESSAGES, condensa o bloco de
    mensagens mais antigas que está prestes a parar de ser enviado ao modelo, em vez
    de simplesmente descartá-lo. Idempotente: só resume o que ainda não foi resumido
    (rastreado por SUMMARIZED_COUNT), então conversas curtas nunca pagam o custo
    dessa chamada extra."""
    global HISTORY_SUMMARY, SUMMARIZED_COUNT
    overflow_end = len(HISTORY) - config.MAX_HISTORY_MESSAGES
    if overflow_end <= SUMMARIZED_COUNT:
        return
    block = HISTORY[SUMMARIZED_COUNT:overflow_end]
    if not block:
        return
    try:
        HISTORY_SUMMARY = await _summarize_block(HISTORY_SUMMARY, block)
    except Exception:
        # Resumo é um "nice to have" — se falhar (ex: Ollama ocupado), a conversa
        # continua funcionando normalmente, só sem o resumo dessa leva ainda.
        return
    SUMMARIZED_COUNT = overflow_end
    if ACTIVE_ID:
        conversations.set_summary(ACTIVE_ID, HISTORY_SUMMARY)


def _execute_tool(call: ToolCall) -> str:
    path = call.attrs.get("path", "")
    if call.tag == "agent-read":
        return tools.read_file(path)
    if call.tag == "agent-list":
        return tools.list_files(path or ".")
    if call.tag == "agent-write":
        result = tools.write_file(path, call.content)
        # Guarda o HTML como página de entrada do próximo preview: sem isso o servidor
        # abre a LISTAGEM da workspace e o usuário vê os próprios arquivos pessoais em
        # vez do que acabou de pedir (relatado em 2026-08-11).
        if path.lower().endswith((".html", ".htm")):
            dev_server.remember_html(path)
        return result
    if call.tag == "agent-edit":
        search, replace = parse_edit_block(call.content)
        return tools.edit_file(path, search, replace)
    if call.tag == "agent-delete":
        return tools.delete_file(path)
    if call.tag == "agent-run":
        return tools.run_command(call.content)
    if call.tag == "agent-preview":
        return dev_server.start(call.content)
    if call.tag == "agent-remember":
        return memory.add(call.content)["text"]
    if call.tag == "agent-schedule":
        schedule_type = call.attrs.get("type", "")
        schedule_value = _parse_schedule_attrs(call.attrs)
        task = tasks.create(call.content, schedule_type, schedule_value)
        return f"Tarefa agendada (id {task['id']}), próxima execução: {task['next_run_at']}"
    if call.tag == "agent-standing-order":
        return standing_orders.add(call.content)["text"]
    raise ValueError(f"Tag desconhecida: {call.tag}")


def _parse_schedule_attrs(attrs: dict) -> dict:
    schedule_type = attrs.get("type", "")
    if schedule_type == "once":
        return {"minutes_from_now": int(attrs.get("minutes", "0"))}
    if schedule_type in ("daily", "weekly"):
        hour, minute = (attrs.get("time", "00:00")).split(":")
        value = {"hour": int(hour), "minute": int(minute)}
        if schedule_type == "weekly":
            value["weekday"] = attrs.get("weekday", "mon")
        return value
    raise ValueError(f"type de agendamento inválido: {schedule_type!r} (use once/daily/weekly).")


def _append_to(conversation_id: str, role: str, content: str, images: list[str] | None = None) -> None:
    """Igual _append, mas grava só em disco via conversations.append_message — não toca
    em HISTORY (que só existe pra conversa ATIVA). Usado pelo scheduler, que roda numa
    conversa dedicada de automação, diferente da conversa que o usuário está olhando."""
    conversations.append_message(conversation_id, role, content, images=images)


def _append(role: str, content: str, images: list[str] | None = None) -> None:
    message = {"role": role, "content": content}
    if images:
        message["images"] = images
    HISTORY.append(message)
    _append_to(ACTIVE_ID, role, content, images=images)


def _record_tool_result(call: ToolCall, result: str, status: str, append_fn=None) -> None:
    append_fn = append_fn or _append
    if call.tag == "agent-remember":
        label = "(memória)"
    elif call.tag in ("agent-schedule", "agent-standing-order"):
        label = "(automação)"
    else:
        label = call.attrs.get("path", "") or "(comando)"
    append_fn("user", f"[Resultado de {call.tag} '{label}' ({status})]\n{result}")


def _last_user_message() -> str:
    for msg in reversed(HISTORY):
        if msg["role"] == "user":
            return msg["content"]
    return ""


def _prune_old_images(messages: list[dict], model_sees_images: bool = True) -> list[dict]:
    """Mantém a imagem de verdade só nas MAX_IMAGE_MESSAGES mensagens com imagem mais
    recentes da janela enviada ao modelo; mensagens com imagem mais antigas viram só
    texto (a imagem original continua intacta em HISTORY/conversations.json, isso só
    afeta o que é mandado ao Ollama nesta chamada). Evita que conversas com várias
    imagens fiquem cada vez mais caras conforme crescem, do mesmo jeito que
    MAX_HISTORY_MESSAGES evita isso para texto.

    Com `model_sees_images=False`, NENHUMA imagem é enviada: o Ollama responde
    **HTTP 400** ("Multimodal data provided, but model does not support multimodal
    requests") se uma imagem chegar a um modelo só-texto, e isso travava a conversa
    inteira — toda mensagem seguinte falhava, mesmo sem imagem nova, porque a antiga
    continuava no histórico. Acontecia ao anexar uma imagem e depois trocar pra um
    modelo de texto na tela "Modelos de IA"."""
    image_indexes = [i for i, m in enumerate(messages) if m.get("images")]
    keep = set() if not model_sees_images else set(image_indexes[-config.MAX_IMAGE_MESSAGES:])
    pruned = []
    for i, m in enumerate(messages):
        if m.get("images") and i not in keep:
            aviso = (
                "[imagem anexada anteriormente — o modelo atual não analisa imagens]"
                if not model_sees_images
                else "[imagem anexada anteriormente, não reenviada]"
            )
            m = {"role": m["role"], "content": f"{m['content']} {aviso}".strip()}
        pruned.append(m)
    return pruned


# O frontend acrescenta esta marca ao texto MANDADO ao modelo quando uma imagem é
# anexada (decisão #50) — é o que liga a conversa ao arquivo gravado na workspace.
# Reaproveitada aqui pra saber de quais imagens buscar a ficha.
_IMAGEM_SALVA = re.compile(
    r"\[A imagem anexada está salva na workspace como:\s*([^\]]+)\]", re.IGNORECASE
)


def _imagens_citadas(messages: list[dict]) -> list[str]:
    """Nomes de arquivo de imagem mencionados na conversa, do mais recente pro mais antigo.

    Ordem importa: com várias imagens, a última anexada é quase sempre a que o usuário
    está falando — e é a primeira que o modelo lê no bloco de fichas."""
    nomes = []
    for m in reversed(messages):
        for achado in _IMAGEM_SALVA.findall(m.get("content") or ""):
            for nome in achado.split(","):
                nome = nome.strip()
                if nome and nome not in nomes:
                    nomes.append(nome)
    return nomes


def _drain_calls(calls: list[ToolCall], conversation_id: str | None = None, append_fn=None) -> str | None:
    """Processa uma lista de tags já extraídas de uma resposta do modelo, na ordem.
    Executa as não-sensíveis direto; na primeira sensível, enfileira o restante da
    lista junto no PENDING (ver comentário acima da declaração de PENDING) — o resto só
    é processado depois que essa confirmação for resolvida (ver _resume), sem precisar
    pedir uma resposta nova ao modelo pra "lembrar" da tag seguinte (bug documentado no
    narrava isso em texto). Retorna o marker de confirmação (\x01CONFIRM:<id>\x01) se
    parou numa pendência, ou None se processou a lista inteira.

    conversation_id/append_fn permitem reaproveitar esta função tanto no chat ao vivo
    (default: None/None, comportamento de sempre, grava na conversa ATIVA) quanto numa
    tarefa agendada disparando sozinha (ver _run_task_loop) — nesse segundo caso, uma
    tag sensível é enfileirada com a conversa de automação como origem, pra /confirm
    saber onde gravar o resultado quando o usuário aprovar depois."""
    append_fn = append_fn or _append
    for i, call in enumerate(calls):
        if call.tag in config.SENSITIVE_TAGS:
            PENDING[action_id] = (call, calls[i + 1 :], conversation_id)
            return f"{CONFIRM_MARK}CONFIRM:{action_id}{CONFIRM_MARK}"

        try:
            result = _execute_tool(call)
            status = "ok"
        except Exception as exc:
            result = str(exc)
            status = "erro"
        _record_tool_result(call, result, status, append_fn=append_fn)
    return None


async def _run_loop(request: Request | None = None):
    """`request` só é usado pra detectar que o usuário apertou "parar" (o frontend aborta
    o fetch, o que derruba a conexão). Sem isso, abortar no navegador só esconderia o
    texto na tela enquanto o Ollama continuaria gerando a resposta inteira à toa, e
    a rodada seguinte de tags ainda executaria. Fica opcional porque `_resume()`
    (pós-confirmação) chama este loop sem ter um Request próprio em mãos."""
    await _maybe_summarize_overflow()

    # O system prompt é montado UMA vez por turno, não a cada rodada de tags. Dois motivos:
    # 1) custo — build_system_prompt chama o Ollama pra buscar na base de conhecimento
    #    (~0.5s), e repetir isso a cada rodada multiplicava o custo por MAX_TOOL_LOOPS;
    # 2) correção — _record_tool_result grava os resultados de ferramenta com role "user",
    #    então a partir da 2ª rodada _last_user_message() devolveria "[Resultado de
    #    agent-read ...]" em vez da pergunta real, e a busca de conhecimento passaria a
    #    procurar pelo texto do resultado em vez do que o usuário perguntou.
    # O que entra no system prompt (memória, standing orders, projeto, base de conhecimento)
    # não muda no meio de um turno, então reusar é seguro; o que muda entre rodadas é o
    # HISTORY, que continua sendo relido a cada iteração logo abaixo.
    system_prompt = await build_system_prompt(ACTIVE_PROJECT_ID, _last_user_message(), HISTORY_SUMMARY)

    # Fichas das imagens citadas nesta conversa (decisão #56). Vai DEPOIS do system prompt
    # montado porque depende do histórico, não das fontes fixas (memória, projeto, base de
    # conhecimento). É o que faz um modelo só-texto saber o que a figura é.
    ficha_block = image_cards.as_prompt_block(_imagens_citadas(HISTORY))
    if ficha_block:
        system_prompt = system_prompt + "\n\n" + ficha_block

    # Consultado uma vez por turno (não a cada rodada): se o modelo ativo não analisa
    # imagens, nenhuma imagem do histórico pode ir junto — o Ollama devolveria HTTP 400 e
    # travaria a conversa inteira. Só custa a consulta quando há imagem no histórico.
    model_sees_images = True
    if any(m.get("images") for m in HISTORY[-config.MAX_HISTORY_MESSAGES:]):
        model_sees_images = await ollama_models.supports_vision(settings.get_model())

    for _ in range(config.MAX_TOOL_LOOPS):
        recent_history = _prune_old_images(
            HISTORY[-config.MAX_HISTORY_MESSAGES:], model_sees_images
        )
        messages = [{"role": "system", "content": system_prompt}] + recent_history
        full_text = ""
        stopped = False
        try:
            async for chunk in _stream_model(messages):
                if request is not None and await request.is_disconnected():
                    stopped = True
                    break
                full_text += chunk
                yield chunk
        except asyncio.CancelledError:
            # Caminho normal da parada manual: quando o cliente some, o Starlette cancela
            # este gerador no próprio `yield`, então o `is_disconnected()` acima nem chega
            # a rodar de novo. Tratamos aqui pra ainda registrar o que já tinha sido gerado
            # (senão a conversa fica com a pergunta do usuário e NENHUMA resposta).
            stopped = True

        if stopped:
            # Grava o que já tinha saído antes da parada pra a conversa não ficar com uma
            # mensagem do usuário sem nenhuma resposta, e NÃO executa parse_tags/_drain_calls:
            # um texto cortado no meio pode conter uma tag pela metade, e o usuário acabou de
            # dizer explicitamente que não quer que isso continue.
            if full_text.strip():
                _append("assistant", full_text)
            _append("user", "[Geração interrompida pelo usuário.]")
            return

        _append("assistant", full_text)

        calls = parse_tags(full_text)
        if not calls:
            return

        marker = _drain_calls(calls)
        if marker is not None:
            yield marker
            return

    _append(
        "user",
        "[Limite de ações automáticas atingido nesta rodada. Continue na próxima mensagem se precisar.]",
    )


async def _run_task_loop(conversation_id: str, project_id: str | None) -> str:
    """Versão não-streaming de _run_loop, pra uma conversa de automação específica —
    não toca em HISTORY/ACTIVE_ID/PENDING-implícito-da-conversa-ativa, já que o usuário
    pode estar no meio de outra conversa quando uma tarefa agendada dispara. Roda até
    MAX_TOOL_LOOPS ou até parar numa confirmação pendente. Retorna um resumo curto do
    desfecho, gravado por tasks.mark_run.

    Também é usado pra RETOMAR a tarefa depois que o usuário confirma uma ação sensível
    (ver `_resume_task_in_background`): como o loop sempre relê a conversa do disco e o
    resultado da ação já foi gravado lá antes da retomada, continuar é simplesmente
    rodar o loop de novo sobre a conversa atualizada — não é preciso guardar estado
    da execução anterior."""
    conv = conversations.get(conversation_id)
    if not conv:
        return "erro: conversa de automação não encontrada"
    history = conv["messages"]

    def append_fn(role, content, images=None):
        _append_to(conversation_id, role, content, images)

    # Montado uma vez só, pelo mesmo motivo de _run_loop (custo da busca na base de
    # conhecimento + resultados de ferramenta poluírem o "última mensagem do usuário").
    last_user = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    system_prompt = await build_system_prompt(project_id, last_user, "")

    # Mesmas fichas de imagem do chat ao vivo (decisão #56): uma tarefa agendada que mexa
    # numa página com imagem precisa do mesmo contexto.
    ficha_block = image_cards.as_prompt_block(_imagens_citadas(history))
    if ficha_block:
        system_prompt = system_prompt + "\n\n" + ficha_block

    for _ in range(config.MAX_TOOL_LOOPS):
        messages = [{"role": "system", "content": system_prompt}] + history[-config.MAX_HISTORY_MESSAGES:]

        full_text = ""
        async for chunk in _stream_model(messages):
            full_text += chunk
        append_fn("assistant", full_text)
        history = conversations.get(conversation_id)["messages"]

        calls = parse_tags(full_text)
        if not calls:
            return "ok"

        marker = _drain_calls(calls, conversation_id=conversation_id, append_fn=append_fn)
        if marker is not None:
            return "aguardando confirmação"
        history = conversations.get(conversation_id)["messages"]

    return "limite de ações automáticas atingido"


async def _resume_task_in_background(conversation_id: str) -> None:
    """Continua uma tarefa agendada depois que o usuário confirmou uma ação sensível.

    Roda como task solta (`asyncio.create_task`) pra a resposta do /confirm voltar na
    hora em vez de segurar a tela do usuário enquanto o modelo trabalha. O projeto vem
    da própria conversa (mesma fonte que `tasks.scheduler_loop` usa), não do
    ACTIVE_PROJECT_ID — a conversa que o usuário está olhando pode ser outra.

    Engole exceções pelo mesmo motivo de `scheduler_loop`: uma tarefa que falha não pode
    derrubar nada, já que ninguém está olhando pra ver o erro. O desfecho fica registrado
    na própria conversa de automação, visível na view Automação."""
    try:
        conv = conversations.get(conversation_id)
        if not conv:
            return
        await _run_task_loop(conversation_id, conv.get("project_id"))
    except Exception:
        pass


def _unique_workspace_name(filename: str) -> str:
    """Evita sobrescrever um arquivo existente silenciosamente ao subir um PDF com o
    mesmo nome de um já presente na workspace — mesma ideia de projects._unique_dir_name,
    aplicada a nome de arquivo em vez de pasta."""
    base = tools.safe_path(".")
    stem, suffix = filename.rsplit(".", 1) if "." in filename else (filename, "")
    suffix = f".{suffix}" if suffix else ""
    candidate = filename
    n = 1
    while (base / candidate).exists():
        n += 1
        candidate = f"{stem} ({n}){suffix}"
    return candidate


@app.post("/workspace/upload")
async def upload_to_workspace(file: UploadFile = File(...)):
    """Copia um anexo do chat pra dentro da workspace.

    PDF: é o único jeito de o modelo ler o conteúdo (via <agent-read> — o Ollama não
    entende PDF bruto, ver decisão #24).

    Imagem: continua indo em base64 direto pro modelo em /chat (é assim que ele a VÊ),
    mas passou a ser gravada aqui TAMBÉM, porque ver não basta — quando o usuário pede
    "crie um card com essa imagem", o HTML gerado precisa de um arquivo real pra
    referenciar em <img src="...">. Sem isso o modelo escrevia o nome de alguma imagem
    antiga que existisse na pasta, e o preview mostrava a figura errada (relatado em
    2026-08-12)."""
    permitidas = (".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
    if not file.filename or not file.filename.lower().endswith(permitidas):
        return JSONResponse(
            {"error": "Tipo de arquivo não aceito. Envie PDF ou imagem."}, status_code=400
        )
    name = _unique_workspace_name(file.filename)
    try:
        target = tools.safe_path(name)
    except tools.UnsafePathError:
        # Nome de arquivo com "../" (o navegador não manda, mas um cliente HTTP qualquer
        # pode): o sandbox já barra a escrita — aqui só evitamos devolver um 500 opaco.
        return JSONResponse({"error": "Nome de arquivo inválido."}, status_code=400)
    content = await file.read()
    target.write_bytes(content)

    if name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")):
        # Ficha da imagem (decisão #56): cores e dimensões saem dos pixels agora, em
        # milissegundos. A descrição depende do modelo de visão e pode levar minutos com
        # ele frio, então vai pra segundo plano — o anexo nunca espera por ela.
        image_cards.registrar(name, target)
        asyncio.create_task(_descrever_imagem_em_segundo_plano(name, content))

    return {"filename": name}


async def _descrever_imagem_em_segundo_plano(nome: str, conteudo: bytes) -> None:
    """Pede a descrição ao modelo de visão e completa a ficha quando ela chegar.

    Roda solto (`create_task`), então ninguém está esperando o resultado: qualquer falha
    é engolida de propósito — sem modelo de visão instalado, ou com o Ollama fora do ar,
    a ficha simplesmente fica só com as cores/dimensões, que já são reais e úteis."""
    try:
        modelo = await ollama_models.find_vision_model()
        if not modelo:
            return
        descricao = await ollama_models.describe_image(
            modelo, base64.b64encode(conteudo).decode(), settings.get_keep_alive()
        )
        if descricao:
            image_cards.set_descricao(nome, descricao)
    except Exception:
        pass


@app.post("/chat")
async def chat(request: Request):
    global ACTIVE_ID
    body = await request.json()
    message = body.get("message", "")
    images = body.get("images") or None

    _ensure_active_conversation()
    _append("user", message, images=images)
    return StreamingResponse(_run_loop(request), media_type="text/plain")


def _risky_warning(call: ToolCall) -> str | None:
    """Sinaliza ações potencialmente destrutivas na tela de confirmação (não bloqueia —
    só chama atenção antes do usuário aprovar)."""
    # agent-delete numa PASTA é recursivo e não passa pela Lixeira: mostrar quantos itens
    # serão perdidos é o que evita o clique errado. Só um "tem certeza?" genérico não
    # diferencia apagar uma pasta vazia de apagar um projeto inteiro.
    if call.tag == "agent-delete":
        path = call.attrs.get("path", "").strip()
        if not path:
            return None
        try:
            target = tools.safe_path(path)
        except Exception:
            return None
        # A raiz é recusada por delete_file(); avisar "pasta vazia" aqui seria enganoso.
        if target.resolve() == config.WORKSPACE_ROOT.resolve():
            return "A pasta raiz da workspace não pode ser apagada."
        if target.is_dir():
            files, dirs = tools.count_tree(target)
            if files or dirs:
                return (
                    f"Esta pasta contém {files} arquivo(s) e {dirs} subpasta(s). "
                    "Tudo será apagado permanentemente (não vai para a Lixeira)."
                )
            return "A pasta está vazia e será apagada permanentemente."
        return None

    if call.tag not in ("agent-run", "agent-preview"):
        return None
    lowered = call.content.lower()
    for pattern in config.RISKY_COMMAND_PATTERNS:
        if pattern in lowered:
            return "Este comando tem um padrão potencialmente destrutivo ou sensível — revise com atenção antes de aprovar."
    return None


@app.get("/pending/{action_id}")
async def get_pending(action_id: str):
    entry = PENDING.get(action_id)
    if not entry:
        return JSONResponse({"error": "Ação não encontrada ou já resolvida"}, status_code=404)
    call, _remaining, _origin = entry
    return {"tag": call.tag, "attrs": call.attrs, "content": call.content, "warning": _risky_warning(call)}


@app.post("/confirm/{action_id}")
async def confirm(action_id: str, request: Request):
    body = await request.json()
    approved = bool(body.get("approved"))
    entry = PENDING.pop(action_id, None)
    if not entry:
        return JSONResponse({"error": "Ação não encontrada ou já resolvida"}, status_code=404)
    call, remaining, origin_conversation_id = entry

    # Origem é uma tarefa agendada (não a conversa ativa que o usuário está olhando
    # agora) quando origin_conversation_id foi setado E é diferente da conversa ativa
    # atual — nesse caso o resultado precisa ir pra conversa de automação, não pra
    # HISTORY em memória.
    is_automation_origin = origin_conversation_id is not None and origin_conversation_id != ACTIVE_ID
    if is_automation_origin:
        def append_fn(role, content, images=None):
            _append_to(origin_conversation_id, role, content, images)
    else:
        append_fn = _append

    async def _resume():
        if approved:
            try:
                result = _execute_tool(call)
                status = "aprovado e executado"
            except Exception as exc:
                result = str(exc)
                status = "aprovado, mas falhou"
        else:
            result = "(usuário recusou a ação)"
            status = "recusado"
        _record_tool_result(call, result, status, append_fn=append_fn)

        # Se essa resposta do modelo tinha mais tags sensíveis depois dessa (ex:
        # agent-write seguido de agent-preview), processa o restante da fila antes de
        # pedir uma resposta nova ao modelo — sem isso, a tag seguinte se perdia (ver
        # comentário em _drain_calls).
        if remaining:
            marker = _drain_calls(remaining, conversation_id=origin_conversation_id, append_fn=append_fn)
            if marker is not None:
                yield marker
                return

        if is_automation_origin:
            # Confirmação de uma ação vinda de tarefa agendada. NÃO chama _run_loop()
            # aqui: ele opera sobre HISTORY/ACTIVE_ID da conversa ATIVA, então pediria
            # uma resposta nova dentro da conversa que o usuário está olhando agora.
            # A continuação correta é _run_task_loop sobre a conversa de automação, em
            # segundo plano — a resposta HTTP volta na hora e a tarefa segue sozinha
            # (o badge da sidebar avisa se ela parar em outra confirmação).
            asyncio.create_task(_resume_task_in_background(origin_conversation_id))
            yield "Ação aprovada. A tarefa agendada continua em segundo plano."
            return

        async for chunk in _run_loop(request):
            yield chunk

    return StreamingResponse(_resume(), media_type="text/plain")


@app.get("/preview/status")
async def preview_status():
    return dev_server.status()


@app.post("/preview/stop")
async def preview_stop():
    # asyncio.to_thread: stop() usa taskkill + process.wait(), que podem levar até 10s
    # somados. Chamado direto aqui, isso BLOQUEIA o event loop inteiro do uvicorn — o app
    # parecia um congelamento total do Ambar (relatado em 2026-08-12).
    return {"result": await asyncio.to_thread(dev_server.stop)}


@app.get("/memory")
async def list_memory():
    return {"entries": memory.all_entries()}


@app.delete("/memory/{entry_id}")
async def delete_memory(entry_id: str):
    removed = memory.remove(entry_id)
    if not removed:
        return JSONResponse({"error": "Memória não encontrada"}, status_code=404)
    return {"ok": True}


@app.post("/memory/reset")
async def reset_memory():
    memory.clear()
    return {"ok": True}


@app.post("/reset")
async def reset():
    """Encerra a conversa ativa e prepara uma nova (criada sob demanda na próxima mensagem)."""
    global ACTIVE_ID, ACTIVE_PROJECT_ID, HISTORY_SUMMARY, SUMMARIZED_COUNT
    HISTORY.clear()
    PENDING.clear()
    ACTIVE_ID = None
    ACTIVE_PROJECT_ID = None
    HISTORY_SUMMARY = ""
    SUMMARIZED_COUNT = 0
    return {"ok": True}


@app.get("/history")
async def history():
    return {"history": HISTORY}


@app.get("/conversations")
async def list_conversations():
    items = conversations.all_conversations()
    items.sort(key=lambda c: c["updated_at"], reverse=True)
    return {"conversations": items, "active_id": ACTIVE_ID}


@app.get("/conversations/search")
async def search_conversations(q: str = ""):
    items = conversations.search(q)
    items.sort(key=lambda c: c["updated_at"], reverse=True)
    return {"conversations": items}


@app.post("/conversations/{conversation_id}/activate")
async def activate_conversation(conversation_id: str):
    global ACTIVE_ID, ACTIVE_PROJECT_ID, HISTORY, HISTORY_SUMMARY, SUMMARIZED_COUNT
    conv = conversations.get(conversation_id)
    if not conv:
        return JSONResponse({"error": "Conversa não encontrada"}, status_code=404)
    ACTIVE_ID = conversation_id
    ACTIVE_PROJECT_ID = conv.get("project_id")
    HISTORY = conv["messages"]
    HISTORY_SUMMARY = conv.get("summary", "")
    # O resumo salvo já cobre tudo que passou da janela até a última vez que essa
    # conversa foi usada — assume que esse trecho continua coberto, então marca como
    # "já resumido" pra não reprocessar do zero a cada ativação.
    SUMMARIZED_COUNT = max(0, len(HISTORY) - config.MAX_HISTORY_MESSAGES) if HISTORY_SUMMARY else 0
    PENDING.clear()
    return {
        "id": conv["id"],
        "title": conv["title"],
        "messages": conv["messages"],
        "project_id": conv.get("project_id"),
    }


@app.patch("/conversations/{conversation_id}")
async def update_conversation(conversation_id: str, request: Request):
    body = await request.json()
    if "title" in body:
        if not conversations.rename(conversation_id, body["title"]):
            return JSONResponse({"error": "Conversa não encontrada"}, status_code=404)
    if "pinned" in body:
        if not conversations.set_pinned(conversation_id, bool(body["pinned"])):
            return JSONResponse({"error": "Conversa não encontrada"}, status_code=404)
    return {"ok": True}


@app.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    global ACTIVE_ID, HISTORY, HISTORY_SUMMARY, SUMMARIZED_COUNT
    if not conversations.delete(conversation_id):
        return JSONResponse({"error": "Conversa não encontrada"}, status_code=404)
    if ACTIVE_ID == conversation_id:
        ACTIVE_ID = None
        HISTORY = []
        HISTORY_SUMMARY = ""
        SUMMARIZED_COUNT = 0
        PENDING.clear()
    return {"ok": True}


@app.get("/projects")
async def list_projects():
    items = projects.all_projects()
    items.sort(key=lambda p: p["updated_at"], reverse=True)
    return {"projects": items}


@app.post("/projects")
async def create_project(request: Request):
    body = await request.json()
    name = body.get("name", "")
    description = body.get("description", "")
    try:
        project = projects.create(name, description)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return project


@app.patch("/projects/{project_id}")
async def update_project(project_id: str, request: Request):
    body = await request.json()
    ok = projects.update(project_id, name=body.get("name"), description=body.get("description"))
    if not ok:
        return JSONResponse({"error": "Projeto não encontrado"}, status_code=404)
    return {"ok": True}


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    if not projects.delete(project_id):
        return JSONResponse({"error": "Projeto não encontrado"}, status_code=404)
    return {"ok": True}


@app.post("/projects/{project_id}/chat")
async def start_project_chat(project_id: str):
    """Cria e ativa uma nova conversa vinculada ao projeto (usado pelo botão 'Conversar' nos cards)."""
    global ACTIVE_ID, ACTIVE_PROJECT_ID, HISTORY, HISTORY_SUMMARY, SUMMARIZED_COUNT
    if not projects.get(project_id):
        return JSONResponse({"error": "Projeto não encontrado"}, status_code=404)
    conv = conversations.create(project_id=project_id)
    ACTIVE_ID = conv["id"]
    ACTIVE_PROJECT_ID = project_id
    HISTORY = conv["messages"]
    HISTORY_SUMMARY = ""
    SUMMARIZED_COUNT = 0
    PENDING.clear()
    return {"id": conv["id"], "title": conv["title"], "project_id": project_id}


@app.get("/library")
async def list_library():
    return {"items": library.all_items()}


@app.post("/library")
async def create_library_item(request: Request):
    body = await request.json()
    name = body.get("name", "")
    content = body.get("content", "")
    try:
        item = library.create(name, content)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return item


@app.delete("/library/{item_id}")
async def delete_library_item(item_id: str):
    if not library.remove(item_id):
        return JSONResponse({"error": "Item não encontrado"}, status_code=404)
    return {"ok": True}


@app.get("/knowledge")
async def list_knowledge():
    return {"items": knowledge.all_items()}


@app.post("/knowledge")
async def create_knowledge_item(request: Request):
    body = await request.json()
    title = body.get("title", "")
    content = body.get("content", "")
    try:
        item = await knowledge.create(title, content)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return item


@app.delete("/knowledge/{item_id}")
async def delete_knowledge_item(item_id: str):
    if not knowledge.remove(item_id):
        return JSONResponse({"error": "Item não encontrado"}, status_code=404)
    return {"ok": True}


@app.get("/tasks")
async def list_tasks():
    return {"tasks": tasks.all_tasks()}


@app.post("/tasks")
async def create_task(request: Request):
    """Criação manual via UI (sem passar pelo modelo/tag) — mesma validação de
    schedule_type/schedule_value que <agent-schedule> usa internamente (tasks.create
    chama _validate_schedule)."""
    body = await request.json()
    try:
        task = tasks.create(
            body.get("instruction", ""),
            body.get("schedule_type", ""),
            body.get("schedule_value", {}),
        )
    except (ValueError, KeyError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return task


@app.patch("/tasks/{task_id}")
async def update_task(task_id: str, request: Request):
    body = await request.json()
    if "enabled" in body:
        if not tasks.set_enabled(task_id, bool(body["enabled"])):
            return JSONResponse({"error": "Tarefa não encontrada"}, status_code=404)
    return {"ok": True}


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: str):
    if not tasks.remove(task_id):
        return JSONResponse({"error": "Tarefa não encontrada"}, status_code=404)
    return {"ok": True}


@app.get("/standing-orders")
async def list_standing_orders():
    return {"entries": standing_orders.all_entries()}


@app.post("/standing-orders")
async def create_standing_order(request: Request):
    body = await request.json()
    try:
        entry = standing_orders.add(body.get("text", ""))
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return entry


@app.delete("/standing-orders/{entry_id}")
async def delete_standing_order(entry_id: str):
    if not standing_orders.remove(entry_id):
        return JSONResponse({"error": "Ordem não encontrada"}, status_code=404)
    return {"ok": True}


@app.get("/automation/status")
async def automation_status():
    """Usado pelo badge da sidebar: compara updated_at da conversa de automação (se
    existir) com o último momento em que o usuário abriu a view Automação, e conta
    quantas confirmações pendentes vieram de uma tarefa agendada (não do chat ao vivo)."""
    automation_conv = next(
        (c for c in conversations.all_conversations() if c.get("is_automation")), None
    )
    last_seen = settings.get_last_seen_automation()
    has_unseen = bool(automation_conv) and automation_conv["updated_at"] > last_seen
    pending_count = sum(
        1 for _call, _remaining, origin in PENDING.values()
        if origin is not None and automation_conv and origin == automation_conv["id"]
    )
    return {"has_unseen": has_unseen or pending_count > 0, "pending_count": pending_count}


@app.post("/automation/seen")
async def automation_seen():
    settings.set_last_seen_automation(datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return {"ok": True}


@app.on_event("startup")
async def _start_scheduler():
    """Roda no mesmo event loop do uvicorn (ver app.py — uvicorn.run acontece dentro de
    uma thread daemon, mas o loop asyncio em si é único). Sem stop explícito: a task
    morre junto com o processo no fechamento (mesmo padrão de dev_server._watch_output),
    e como tasks.mark_run/_save gravam em disco a cada tick (write-through, nunca
    batched em memória), não há estado a perder num fechamento abrupto."""
    asyncio.create_task(tasks.scheduler_loop(_run_task_loop))

    # Pré-carregamento opcional (desligado por padrão — ver config.PRELOAD_MODEL_DEFAULT).
    # Como task em background, nunca bloqueando o startup: carregar um modelo grande leva
    # minutos, e segurar a abertura da janela por isso seria pior que o problema original.
    asyncio.create_task(_preload_in_background(settings.get_model()))


@app.get("/models")
async def list_models():
    installed = await ollama_models.list_installed()
    selected = settings.get_model()
    return {"models": installed, "selected": selected}


@app.get("/models/vision-status")
async def models_vision_status():
    """Usado pelo botão de anexar imagem no chat pra avisar antes de enviar,
    caso o modelo ativo não saiba interpretar imagens."""
    selected = settings.get_model()
    return {"model": selected, "supports_vision": await ollama_models.supports_vision(selected)}


@app.get("/models/runtime-status")
async def models_runtime_status():
    """Estado do motor de inferência, consultado pelo frontend antes de enviar uma
    mensagem (e por polling enquanto o modelo carrega).

    Existe pra resolver um problema concreto de experiência: quando o modelo não está
    na memória, a primeira mensagem leva minutos lendo o disco, e até então a tela
    mostrava exatamente o mesmo spinner de uma resposta rápida — indistinguível de um
    travamento. Com isto, a UI consegue dizer o que está acontecendo."""
    selected = settings.get_model()
    running = await ollama_models.is_running()
    loaded = await ollama_models.is_loaded(selected) if running else False
    return {
        "model": selected,
        "ollama_running": running,
        "model_loaded": loaded,
        "preloading": PRELOAD_STATE.get("running", False),
    }


@app.get("/models/preferences")
async def get_model_preferences():
    keep_alive = settings.get_keep_alive()
    return {
        # str() porque -1 é int e o <select> do frontend compara com string.
        "keep_alive": str(keep_alive),
        "keep_alive_choices": config.KEEP_ALIVE_CHOICES,
        "preload_model": settings.get_preload_model(),
    }


@app.patch("/models/preferences")
async def update_model_preferences(request: Request):
    body = await request.json()

    keep_alive = body.get("keep_alive")
    if keep_alive is not None:
        if str(keep_alive) not in config.KEEP_ALIVE_CHOICES:
            return JSONResponse(
                {"error": f"Valor inválido para keep_alive: {keep_alive}"}, status_code=400
            )
        settings.set_keep_alive(str(keep_alive))

    preload = body.get("preload_model")
    if preload is not None:
        settings.set_preload_model(bool(preload))

    return {
        "ok": True,
        "keep_alive": str(settings.get_keep_alive()),
        "preload_model": settings.get_preload_model(),
    }


@app.post("/models/preload")
async def preload_model_now():
    """Carrega o modelo na memória sob demanda (botão "Carregar agora" na tela de
    Modelos, e também disparado pela UI quando o usuário abre o chat com o modelo
    frio). Retorna imediatamente — o progresso é acompanhado por
    GET /models/runtime-status, não segurando esta requisição por minutos.

    que não vai poder responder (o /chat devolve 402 antes de chamá-lo). O cliente via a
    máquina trabalhar por minutos e só então descobria que precisava renovar — trabalho
    inútil que ainda parecia defeito do produto."""
    if PRELOAD_STATE.get("running"):
        return {"ok": True, "already_running": True}
    asyncio.create_task(_preload_in_background(settings.get_model()))
    return {"ok": True, "already_running": False}


@app.post("/models/select")
async def select_model(request: Request):
    body = await request.json()
    model = body.get("model", "")
    if not model:
        return JSONResponse({"error": "Nome do modelo não pode ser vazio"}, status_code=400)
    settings.set_model(model)
    return {"ok": True, "selected": model}


@app.delete("/models/{model:path}")
async def delete_model(model: str):
    ok = await ollama_models.delete(model)
    if not ok:
        return JSONResponse({"error": "Não foi possível remover o modelo."}, status_code=400)
    if settings.get_model() == model:
        settings.set_model(config.MODEL_NAME)
    return {"ok": True}


@app.get("/profile")
async def get_profile():
    return profile.get()


@app.patch("/profile")
async def update_profile(request: Request):
    body = await request.json()
    return profile.update(name=body.get("name"))


web_dir = config.BUNDLE_DIR / "web"
app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")