import asyncio

import httpx

from . import config


async def _capabilities(client: httpx.AsyncClient, model: str) -> list[str]:
    try:
        response = await client.post(f"{config.OLLAMA_HOST}/api/show", json={"model": model})
        response.raise_for_status()
        return response.json().get("capabilities", [])
    except (httpx.HTTPError, ValueError):
        return []


def _category(capabilities: list[str]) -> str:
    """Classifica o modelo pra agrupar na UI (view 'Modelos de IA'). Baseado nas
    capabilities reais que o Ollama reporta via /api/show, não no nome do modelo —
    mesmo critério de confiabilidade já usado em supports_vision()."""
    if "embedding" in capabilities:
        return "embedding"
    if "vision" in capabilities:
        return "vision"
    return "text"


async def list_installed() -> list[dict]:
    """Lista os modelos instalados no Ollama local, já classificados por categoria
    (texto/visão/embedding) pra UI conseguir agrupar. Retorna [] se o Ollama não
    responder.

    Timeout de 15s (não 5s): além do /api/tags, isso dispara um /api/show por modelo
    instalado em paralelo (ver _category) pra descobrir a categoria de cada um — com
    vários modelos instalados, ou logo no boot do app enquanto o Ollama ainda está
    subindo, 5s pode não ser suficiente e a lista inteira falhava silenciosamente
    (retornava [], sem re-tentar), deixando a tela "Modelos de IA" presa no erro até
    o usuário reabrir o app."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{config.OLLAMA_HOST}/api/tags")
            response.raise_for_status()
            data = response.json()

            names = [item.get("name") or item.get("model") for item in data.get("models", [])]
            capabilities_list = await asyncio.gather(*(_capabilities(client, name) for name in names))
    except (httpx.HTTPError, ValueError):
        return []

    models = []
    for item, capabilities in zip(data.get("models", []), capabilities_list):
        details = item.get("details", {})
        models.append(
            {
                "name": item.get("name") or item.get("model"),
                "parameter_size": details.get("parameter_size", ""),
                "quantization": details.get("quantization_level", ""),
                "category": _category(capabilities),
            }
        )
    return models


async def delete(model: str) -> bool:
    """Remove um modelo instalado do Ollama (libera espaço em disco). Retorna False se
    o Ollama recusar (ex: nome inexistente) ou não responder — quem chama decide o
    status HTTP apropriado."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(
                "DELETE", f"{config.OLLAMA_HOST}/api/delete", json={"model": model}
            )
            response.raise_for_status()
    except httpx.HTTPError:
        return False
    return True


async def is_loaded(model: str) -> bool:
    """True se o modelo já está na memória (VRAM/RAM), pronto pra responder rápido.

    Consulta /api/ps do Ollama, que lista só os modelos carregados no momento. É a
    diferença entre uma resposta em ~1s e uma espera de minutos: quando o modelo não
    está carregado, a primeira mensagem precisa ler vários GB do disco antes de gerar
    o primeiro token — disco a 100%, GPU parada, e nenhum sinal na tela de que algo
    está acontecendo (foi exatamente assim que o problema apareceu pro usuário).

    Falha (Ollama fora do ar) devolve False: quem chama trata como "não está pronto",
    que é a leitura correta — sem Ollama não há resposta rápida nenhuma."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{config.OLLAMA_HOST}/api/ps")
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError):
        return False
    return any((item.get("name") or item.get("model")) == model for item in data.get("models", []))


async def is_running() -> bool:
    """True se o servidor do Ollama está no ar (independente de ter modelo carregado).
    Separado de is_loaded() porque as duas situações pedem mensagens diferentes na UI:
    'instale o Ollama' é um problema; 'carregando o modelo' é só espera."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{config.OLLAMA_HOST}/api/tags")
            response.raise_for_status()
    except httpx.HTTPError:
        return False
    return True


async def preload(model: str, keep_alive) -> bool:
    """Manda o Ollama carregar o modelo na memória sem gerar nenhum token.

    O truque é o prompt vazio: /api/generate sem "prompt" só carrega e devolve — é a
    forma documentada de aquecer um modelo, e evita gastar GPU gerando texto que seria
    descartado. O timeout é generoso (10min) porque é exatamente o caso lento que isso
    existe pra resolver: modelo grande em disco lento leva minutos na primeira vez.

    Nunca propaga exceção — pré-carregar é conforto, não pode impedir o app de abrir."""
    try:
        async with httpx.AsyncClient(timeout=600) as client:
            response = await client.post(
                f"{config.OLLAMA_HOST}/api/generate",
                json={"model": model, "keep_alive": keep_alive},
            )
            response.raise_for_status()
    except (httpx.HTTPError, ValueError):
        return False
    return True


async def supports_vision(model: str) -> bool:
    """Consulta /api/show pra saber se o modelo tem a capability 'vision' de verdade,
    em vez de adivinhar pelo nome (mais confiável — modelos de visão nem sempre têm
    "vision"/"vl" no nome, ex: llava)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(f"{config.OLLAMA_HOST}/api/show", json={"model": model})
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError):
        return False
    return "vision" in data.get("capabilities", [])


async def find_vision_model() -> str | None:
    """Nome de um modelo de visão instalado, ou None se não houver nenhum.

    Usado pra descrever a imagem anexada mesmo quando o modelo ATIVO é de texto — é o
    ponto da ficha (agent/image_cards.py): o modelo de visão vê, o de código usa. Se o
    modelo ativo já for de visão, ele é o escolhido, evitando carregar um segundo modelo
    na VRAM à toa."""
    modelos = await list_installed()
    if not modelos:
        return None
    from . import settings
    ativo = settings.get_model()
    for m in modelos:
        if m.get("name") == ativo and m.get("category") == "vision":
            return ativo
    for m in modelos:
        if m.get("category") == "vision":
            return m.get("name")
    return None


# Formato pedido ao modelo de visão. Só a descrição: cor sai do Pillow, que mede em vez
# de estimar (o modelo devolveu #FFA500 pra um #E87A2A real — ver image_cards.py).
_PROMPT_DESCRICAO = (
    "Descreva o que aparece nesta imagem em até 15 palavras, em português. "
    "Escreva apenas a descrição, sem preâmbulo e sem falar de cores."
)


async def describe_image(model: str, image_b64: str, keep_alive) -> str:
    """Descrição curta da imagem, pelo modelo de visão. String vazia em qualquer falha.

    Timeout alto de propósito: se o modelo de visão estiver frio, a primeira chamada leva
    minutos (medido: 95s numa imagem pequena). Como isto roda em segundo plano, esperar
    não bloqueia ninguém — e desistir cedo desperdiçaria justamente o carregamento."""
    try:
        async with httpx.AsyncClient(timeout=600) as client:
            response = await client.post(
                f"{config.OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": _PROMPT_DESCRICAO,
                                  "images": [image_b64]}],
                    "stream": False,
                    "keep_alive": keep_alive,
                },
            )
            response.raise_for_status()
            return (response.json().get("message", {}).get("content") or "").strip()
    except (httpx.HTTPError, ValueError, KeyError):
        return ""