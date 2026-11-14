import re
from dataclasses import dataclass, field

# Duas alternativas separadas por design, não uma única com atributo opcional: ver
# comentário em parse_tags sobre por que o atributo precisa ser OBRIGATÓRIO no regex
# (não só filtrado depois) para as tags que levam path=.
# run/preview/remember/standing-order não têm atributo pra exigir no regex (o comando
# vai todo no conteúdo), então uma menção nua tipo "vou usar a tag <agent-run>" é
# indistinguível de uma abertura real só pela sintaxe da tag em si. Já tentamos barrar
# só com "não pode vir logo depois de crase" — não bastou, porque o modelo também
# menciona a tag em prosa corrida sem crase nenhuma (ex: "vou usar a tag <agent-run>
# para executar o comando"). O sinal que realmente distingue os dois casos na prática:
# a tag REAL emitida pelo modelo sempre começa sozinha no início da própria linha
# (normalmente dentro de um bloco de código ```), nunca no meio de uma frase. Por isso
# "(?:(?<=\n)|(?<!.))[ \t]*" exige que, olhando pra trás, ou tenha uma quebra de linha
# ou seja o próprio início do texto — e permite espaços/tabs de indentação antes da tag.
_TAG_PATTERN = re.compile(
    r'<agent-(read|list|write|edit|delete|schedule)(\s+\w+="[^"]*"(?:\s+\w+="[^"]*")*)\s*>(.*?)</agent-\1>'
    r'|'
    r'(?:(?<=\n)|(?<!.))[ \t]*<agent-(run|preview|remember|standing-order)()\s*>(.*?)</agent-\4>',
    re.DOTALL,
)
_ATTR_PATTERN = re.compile(r'(\w+)="([^"]*)"')
_EDIT_SPLIT_PATTERN = re.compile(
    r'^<{5,}\s*SEARCH\s*\n(.*?)\n={5,}\s*\n(.*?)\n>{5,}\s*REPLACE\s*$',
    re.DOTALL,
)


@dataclass
class ToolCall:
    tag: str
    attrs: dict = field(default_factory=dict)
    content: str = ""
    raw: str = ""


def _parse_attrs(attr_string: str) -> dict:
    return dict(_ATTR_PATTERN.findall(attr_string))


def parse_edit_block(content: str) -> tuple[str, str]:
    """Separa o conteúdo de um <agent-edit> nos trechos SEARCH e REPLACE."""
    match = _EDIT_SPLIT_PATTERN.match(content.strip())
    if not match:
        raise ValueError(
            "Formato de <agent-edit> inválido — use os marcadores <<<<<<< SEARCH / ======= / >>>>>>> REPLACE."
        )
    return match.group(1), match.group(2)


def parse_tags(text: str) -> list[ToolCall]:
    """Extrai as tags <agent-...> do texto do modelo, na ordem em que aparecem.

    Cuidado com um caso real que já quebrou isso em produção: o modelo às vezes
    menciona o nome da tag em prosa antes de usá-la de verdade, ex: "vou usar a tag
    `<agent-write>` agora" seguido, mais adiante, da tag real com path=. Se o regex
    aceitasse atributo opcional, essa menção nua bateria como abertura válida (um
    "<agent-write>" sem atributos) e, como o grupo de conteúdo é non-greedy, ela
    casaria com o PRÓXIMO </agent-write> que aparecesse — engolindo a tag real
    inteira (path incluído) como se fosse texto solto dentro da menção vazia. Isso já
    causou um path="" chegando em write_file(), que tentou escrever na própria pasta
    da workspace e explodiu com "Permission Denied" (é uma pasta, não um arquivo) —
    erro que o modelo então confundiu com falta de permissão do SO. Por isso o
    _TAG_PATTERN tem duas alternativas: uma exige pelo menos um atributo (tags que
    usam path= — read/list/write/edit/delete/schedule), outra não aceita atributo
    nenhum (run/preview/remember/standing-order, cujo comando/instrução vai todo no
    conteúdo) — nunca volte a tornar o atributo opcional numa alternativa só, isso
    reabre exatamente esse bug. Para a segunda alternativa, que não tem atributo pra
    exigir, o mesmo problema já se repetiu de outra forma: uma menção nua tipo "vou
    usar a tag <agent-run> para executar o comando", em prosa corrida e SEM crase
    nenhuma — a defesa antiga (só recusar depois de crase) não pegava isso. A defesa
    atual usa a posição na linha: a tag real emitida pelo modelo sempre abre sozinha no
    início da própria linha (normalmente dentro de um bloco de código), então o regex
    exige que, olhando pra trás a partir do "<", tenha uma quebra de linha (ou seja o
    início do texto), com no máximo espaços/tabs de indentação no meio — uma menção no
    meio de uma frase nunca satisfaz isso. Tags novas: entram no grupo 1/2/3 (primeira
    alternativa) se usarem path=-like attrs, ou no grupo 4/5/6 (segunda) se forem só
    conteúdo — nunca criam grupo novo, então a numeração dos grupos existentes não
    muda."""
    calls = []
    for match in _TAG_PATTERN.finditer(text):
        if match.group(1):
            tag = f"agent-{match.group(1)}"
            attrs = _parse_attrs(match.group(2))
            content = match.group(3).strip()
        else:
            tag = f"agent-{match.group(4)}"
            attrs = {}
            content = match.group(6).strip()
        calls.append(ToolCall(tag=tag, attrs=attrs, content=content, raw=match.group(0)))
    return calls