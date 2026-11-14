import json
import re
import threading
from datetime import datetime, timezone

import httpx

from . import config, settings

_LOCK = threading.Lock()

# Quantos trechos relevantes entram no system prompt por mensagem.
MAX_RESULTS = 3
# Tamanho máximo (em caracteres) de cada trecho injetado, pra não estourar o contexto.
SNIPPET_MAX_LEN = 800
# Abaixo disso a similaridade de cosseno não é considerada relevante o bastante pra
# injetar no prompt. Calibrado empiricamente com bge-m3 em textos curtos/português:
# pares relacionados (pergunta parafraseada sobre um item salvo) ficam na faixa
# 0.50-0.76; pares não relacionados (pergunta aleatória sem relação nenhuma) ficam bem
# abaixo, 0.16-0.37 — 0.45 fica numa margem segura entre as duas faixas observadas.
MIN_SIMILARITY = 0.45

_STOPWORDS = {
    "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "ou", "em", "um", "uma",
    "para", "por", "com", "que", "se", "no", "na", "nos", "nas", "é", "ser", "está",
    "como", "mais", "mas", "ao", "aos", "à", "às", "eu", "você", "voce", "ele", "ela",
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "it",
}

_WORD_RE = re.compile(r"[a-zà-úA-ZÀ-Ú0-9_-]+")


def _load() -> list[dict]:
    if not config.KNOWLEDGE_FILE.exists():
        return []
    try:
        return json.loads(config.KNOWLEDGE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(items: list[dict]) -> None:
    config.KNOWLEDGE_FILE.write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _tokenize(text: str) -> set[str]:
    words = _WORD_RE.findall(text.lower())
    return {w for w in words if w not in _STOPWORDS and len(w) > 1}


async def create(title: str, content: str) -> dict:
    title = title.strip()
    content = content.strip()
    if not title:
        raise ValueError("Título não pode ser vazio.")
    if not content:
        raise ValueError("Conteúdo não pode ser vazio.")
    item = {
        "title": title,
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    # Calcula o embedding já na criação (não espera a próxima busca) — se o Ollama
    # estiver fora do ar agora, fica None e _ensure_embeddings() completa depois.
    item["embedding"] = await _embed(title + "\n" + content)
    with _LOCK:
        items = _load()
        items.append(item)
        _save(items)
    return _without_embedding(item)


def _without_embedding(item: dict) -> dict:
    """Remove o vetor de embedding antes de expor o item pra fora do módulo (API/UI) —
    é só um detalhe interno de busca, não tem uso no frontend e só infla a resposta
    (~768 floats por item)."""
    return {k: v for k, v in item.items() if k != "embedding"}


def all_items() -> list[dict]:
    with _LOCK:
        items = _load()
    return [_without_embedding(i) for i in items]


def remove(item_id: str) -> bool:
    with _LOCK:
        items = _load()
        remaining = [i for i in items if i["id"] != item_id]
        if len(remaining) == len(items):
            return False
        _save(remaining)
        return True


def _search_keyword(query: str, limit: int) -> list[dict]:
    """Busca por relevância simples (contagem de palavras em comum), sem embeddings.
    Fallback usado quando o Ollama ou o modelo de embedding não estão disponíveis —
    ver search()."""
    query_words = _tokenize(query)
    if not query_words:
        return []

    scored = []
    for item in all_items():
        item_words = _tokenize(item["title"] + " " + item["content"])
        overlap = query_words & item_words
        if overlap:
            scored.append((len(overlap), item))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:limit]]


async def _embed(text: str) -> list[float] | None:
    """Pede ao Ollama o vetor de embedding de um texto. None se o Ollama não responder
    ou o modelo de embedding não estiver instalado (ver config.EMBEDDING_MODEL) — quem
    chama trata isso como "cair pro modo palavra-chave", não como erro fatal."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{config.OLLAMA_HOST}/api/embed",
                json={"model": config.EMBEDDING_MODEL, "input": text, "keep_alive": settings.get_keep_alive()},
            )
            response.raise_for_status()
            data = response.json()
        return data["embeddings"][0]
    except (httpx.HTTPError, KeyError, IndexError, ValueError):
        return None


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


async def _ensure_embeddings() -> list[dict]:
    """Garante que todo item salvo tenha um embedding calculado, calculando e
    persistindo o que faltar (ex: itens criados antes dessa feature existir, ou
    criados enquanto o Ollama estava fora do ar). Idempotente e barato quando não há
    nada faltando — só volta a chamar o Ollama pros itens sem embedding."""
    with _LOCK:
        items = _load()

    missing = [item for item in items if not item.get("embedding")]
    if not missing:
        return items

    changed = False
    for item in missing:
        vector = await _embed(item["title"] + "\n" + item["content"])
        if vector is not None:
            item["embedding"] = vector
            changed = True

    if changed:
        with _LOCK:
            # Relê antes de salvar pra não perder itens criados/removidos nesse meio-tempo
            # (a chamada de embedding pode demorar; outra request pode ter mutado o arquivo).
            current = _load()
            by_id = {i["id"]: i for i in items}
            merged = [by_id.get(i["id"], i) for i in current]
            _save(merged)
            items = merged
    return items


async def search(query: str, limit: int = MAX_RESULTS) -> list[dict]:
    """Busca semântica via embeddings (similaridade de cosseno). Cai automaticamente
    pra busca por palavra-chave (_search_keyword) se o Ollama ou o modelo de embedding
    não estiverem disponíveis — nunca deixa a base de conhecimento inutilizável só
    porque o modelo de embedding não foi baixado."""
    # Saída antecipada com a base vazia: sem isso, _embed(query) chamava o Ollama a cada
    # mensagem só pra depois comparar o vetor com NADA. Medido em ~520ms por mensagem
    # com a base vazia — e como build_system_prompt roda dentro do laço de MAX_TOOL_LOOPS,
    # uma resposta com várias rodadas de tags pagava esse custo várias vezes seguidas.
    # A leitura do arquivo é barata (_load direto, sem embeddings) perto da chamada de rede.
    with _LOCK:
        if not _load():
            return []

    items = await _ensure_embeddings()
    query_vector = await _embed(query)

    if query_vector is None:
        return _search_keyword(query, limit)

    scored = []
    for item in items:
        vector = item.get("embedding")
        if not vector:
            continue
        similarity = _cosine_similarity(query_vector, vector)
        if similarity >= MIN_SIMILARITY:
            scored.append((similarity, item))

    if not scored:
        return []

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [_without_embedding(item) for _, item in scored[:limit]]


async def as_prompt_block(query: str) -> str:
    results = await search(query)
    if not results:
        return ""

    parts = []
    for item in results:
        snippet = item["content"]
        if len(snippet) > SNIPPET_MAX_LEN:
            snippet = snippet[:SNIPPET_MAX_LEN] + "…"
        parts.append(f"### {item['title']}\n{snippet}")

    return (
        "Trechos da base de conhecimento do usuário, relevantes para a mensagem atual "
        "(use como referência factual/técnica quando fizer sentido; não cite que é uma "
        "\"base de conhecimento\" pro usuário sem necessidade):\n\n" + "\n\n".join(parts)
    )