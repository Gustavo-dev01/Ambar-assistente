"""Ficha de imagem: o que uma imagem anexada É, em texto, pra QUALQUER modelo usar.

O problema que isto resolve (relatado pelo usuário em 2026-08-11): o modelo de visão vê
a figura, o de código cria os arquivos, e os dois nunca são o mesmo modelo. O histórico
já é compartilhado (decisão #49), mas nada ROTULAVA a descrição como sendo "daquele
arquivo" — então o modelo de código não sabia que aquele parágrafo no meio da conversa
descrevia a imagem que ele deveria usar num <img src="...">.

DIVISÃO DE TRABALHO (medida em 2026-08-13, não estimada):

  - **Cores e dimensões: Python.** O qwen2.5vl NOMEIA a cor certo ("laranja") mas INVENTA
    o hexadecimal — devolveu #FFA500 pra um #E87A2A real (distância RGB 64, outra cor pro
    olho). O Pillow acerta com distância 0-3 em 0,013s. Cor é medição, não percepção.
  - **Descrição: modelo de visão.** Aqui não há alternativa em Python, e ele vai bem
    ("círculo laranja sobre fundo azul escuro"), 1,2s com o modelo quente.

Sem modelo de visão instalado a ficha continua existindo, só sem a linha de descrição —
cores, tamanho e orientação são sempre reais. Isso é deliberado: anexar imagem não pode
depender de ter baixado um modelo específico.
"""

import json
import threading
from collections import Counter
from datetime import datetime, timezone

from . import config

_LOCK = threading.Lock()

# Quantas cores dominantes entram na ficha. Acima disso vira ruído: o modelo copia as
# primeiras e as últimas costumam ser variações escuras da mesma região.
MAX_CORES = 4

# A imagem é reduzida antes de quantizar. Não muda as cores dominantes (proporção de
# área se mantém) e deixa o cálculo em milissegundos mesmo com foto de celular.
_AMOSTRA = (160, 160)


def _load() -> dict:
    if not config.IMAGE_CARDS_FILE.exists():
        return {}
    try:
        data = json.loads(config.IMAGE_CARDS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _save(cards: dict) -> None:
    config.IMAGE_CARDS_FILE.write_text(
        json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _orientacao(largura: int, altura: int) -> str:
    if largura > altura * 1.05:
        return "paisagem"
    if altura > largura * 1.05:
        return "retrato"
    return "quadrada"


def analisar_pixels(caminho) -> dict | None:
    """Cores dominantes + dimensões, direto dos pixels. Sem modelo, sem rede.

    Devolve None em qualquer falha (arquivo corrompido, formato exótico, Pillow ausente):
    a ficha é um ganho de contexto, nunca pode derrubar o anexo de uma imagem.
    """
    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        with Image.open(caminho) as im:
            largura, altura = im.size
            amostra = im.convert("RGB")
            amostra.thumbnail(_AMOSTRA)
            # FASTOCTREE agrupa tons vizinhos em vez de devolver um pixel exato qualquer —
            # sem isso, um degradê viraria N cores quase idênticas.
            q = amostra.quantize(colors=6, method=Image.Quantize.FASTOCTREE)
            paleta = q.getpalette() or []
            contagem = Counter(q.getdata())
            cores = []
            for indice, _ in contagem.most_common(MAX_CORES):
                rgb = paleta[indice * 3:indice * 3 + 3]
                if len(rgb) == 3:
                    cores.append("#%02X%02X%02X" % tuple(rgb))
    except Exception:
        return None

    return {
        "largura": largura,
        "altura": altura,
        "orientacao": _orientacao(largura, altura),
        "cores": cores,
    }


def registrar(arquivo: str, caminho) -> dict:
    """Cria (ou atualiza) a ficha de um arquivo já gravado na workspace.

    Só a parte instantânea — a descrição chega depois, por `set_descricao`, quando/se o
    modelo de visão responder.
    """
    ficha = {
        "arquivo": arquivo,
        "descricao": "",
        "criada_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    dados = analisar_pixels(caminho)
    if dados:
        ficha.update(dados)

    with _LOCK:
        cards = _load()
        # Regravar o mesmo nome preserva a descrição já obtida: o custo dela é uma
        # chamada ao modelo, não vale jogar fora porque o arquivo foi reenviado.
        anterior = cards.get(arquivo) or {}
        if anterior.get("descricao") and not ficha["descricao"]:
            ficha["descricao"] = anterior["descricao"]
        cards[arquivo] = ficha
        _save(cards)
    return ficha


def set_descricao(arquivo: str, descricao: str) -> None:
    """Grava a descrição vinda do modelo de visão. Ignora ficha inexistente."""
    descricao = (descricao or "").strip()
    if not descricao:
        return
    with _LOCK:
        cards = _load()
        if arquivo in cards:
            cards[arquivo]["descricao"] = descricao
            _save(cards)


def get(arquivo: str) -> dict | None:
    with _LOCK:
        return _load().get(arquivo)


def all_cards() -> dict:
    with _LOCK:
        return _load()


def remove(arquivo: str) -> bool:
    with _LOCK:
        cards = _load()
        if arquivo not in cards:
            return False
        del cards[arquivo]
        _save(cards)
        return True


def formatar(ficha: dict) -> str:
    """Uma linha por imagem, começando pelo nome do arquivo entre colchetes.

    O nome vem PRIMEIRO de propósito: é a chave que liga a descrição ao `<img src="...">`
    que o modelo vai escrever. Uma descrição solta no meio da conversa não tem essa liga —
    era exatamente o que faltava (ver o topo deste arquivo).
    """
    partes = []
    if ficha.get("descricao"):
        partes.append(ficha["descricao"].rstrip("."))
    if ficha.get("largura") and ficha.get("altura"):
        partes.append("%dx%d px (%s)" % (ficha["largura"], ficha["altura"],
                                         ficha.get("orientacao", "")))
    if ficha.get("cores"):
        partes.append("cores dominantes: " + ", ".join(ficha["cores"]))
    return "[%s] %s" % (ficha.get("arquivo", "?"), " — ".join(partes) if partes else
                        "imagem anexada")


def as_prompt_block(arquivos: list[str]) -> str:
    """Bloco pro system prompt com as fichas dos arquivos citados. Vazio se não houver."""
    linhas = []
    with _LOCK:
        cards = _load()
        for nome in arquivos:
            ficha = cards.get(nome)
            if ficha:
                linhas.append(formatar(ficha))
    if not linhas:
        return ""
    return (
        "IMAGENS ANEXADAS NESTA CONVERSA (use estes dados ao criar HTML/CSS que as "
        "referencie; o caminho no src é exatamente o nome entre colchetes):\n"
        + "\n".join("- " + l for l in linhas)
    )