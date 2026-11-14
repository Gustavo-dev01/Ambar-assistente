# Ambar

Desenvolvido por **Ambar Systems**.

Assistente de IA local que roda no seu computador, sem depender de nuvem: conversa,
lê/escreve/apaga arquivos, executa comandos, sobe um preview ao vivo de projetos, e
mantém memória, conversas, projetos e base de conhecimento persistidos entre usos.

Todo o processamento de IA acontece localmente via [Ollama](https://ollama.com) — nenhuma
mensagem sai da sua máquina.

## Pré-requisitos

1. **Windows** (o app usa detecção de instância única e um instalador específicos de
   Windows — não roda em Mac/Linux sem adaptação).
2. **[Ollama](https://ollama.com/download)** instalado e com pelo menos um modelo baixado.
   Depois de instalar o Ollama, baixe o modelo padrão pelo terminal:
   ```
   ollama pull qwen2.5-coder:14b
   ```
   Isso baixa ~9 GB — só precisa fazer uma vez. Se sua máquina não tiver uma GPU forte,
   um modelo menor roda melhor:
   ```
   ollama pull qwen2.5:7b
   ```
   Depois de instalado, você pode trocar entre os modelos baixados a qualquer momento
   dentro do próprio app, na tela "Modelos de IA".
3. **(Opcional, recomendado) Modelo de embedding pra busca semântica** — usado pela
   base de conhecimento pra achar itens relevantes mesmo quando a pergunta usa palavras
   diferentes do texto salvo:
   ```
   ollama pull bge-m3
   ```
   Sem esse modelo, a base de conhecimento continua funcionando normalmente, só volta a
   buscar por palavra-chave (menos preciso com sinônimos/paráfrases).

Python **não** é necessário para usar o Ambar normalmente — só se você for mexer no
código-fonte (ver "Rodando/alterando o código-fonte" abaixo).

## Como instalar

Rode `installer\output\AmbarSetup.exe` e siga o assistente. Ele:
- Instala em `%LOCALAPPDATA%\Ambar` (pasta do seu usuário, não exige permissão de
  administrador).
- Cria atalho na área de trabalho e no menu iniciar.
- Registra o Ambar em "Aplicativos instalados" do Windows (Configurações → Aplicativos),
  de onde dá pra desinstalar como qualquer outro programa.

## Como usar no dia a dia

Clique no atalho "Ambar" na área de trabalho ou no menu iniciar. O app cuida sozinho de:
- Verificar se já tem uma instância aberta (não deixa abrir duas vezes).
- Iniciar o Ollama automaticamente em segundo plano, se ele não estiver rodando.

## Onde ficam os seus dados

Dentro de `%LOCALAPPDATA%\Ambar` (ao lado do `Ambar.exe` instalado):
- `data\` — conversas, memória, projetos, biblioteca, base de conhecimento, perfil e
  configurações (todos em JSON simples, legíveis/editáveis à mão se precisar).
- `workspace\` — pasta "sandbox" onde o agente lê e escreve arquivos quando você pede
  para ele criar/editar algo. Cada "Projeto" criado na UI vira uma subpasta aqui.

Essas duas pastas nunca são apagadas por uma atualização (rodar o instalador de novo por
cima de uma instalação existente preserva os dados). Fazer backup de
`%LOCALAPPDATA%\Ambar\data` e `%LOCALAPPDATA%\Ambar\workspace` preserva todo o seu
histórico e trabalho.

Ao desinstalar pelo Painel de Controle/Configurações, o desinstalador pergunta se você
quer apagar `data\`/`workspace\` junto — se responder que não (ou desinstalar em modo
silencioso), essas pastas continuam em `%LOCALAPPDATA%\Ambar` mesmo depois de remover o
programa.

## Se algo der errado

- **O app não abre / fecha sozinho**: veja `%LOCALAPPDATA%\Ambar\data\crash.log` —
  qualquer erro na inicialização é salvo ali com o detalhe do que aconteceu.
- **O chat não responde / erro de conexão**: confirme que o Ollama está rodando
  (`ollama list` no terminal deve listar os modelos baixados). Se não estiver, rode
  `ollama serve` manualmente numa janela de terminal e tente abrir o app de novo.
- **Resposta muito lenta**: normal em modelos grandes (14B) sem GPU dedicada. Troque para
  `qwen2.5:7b` (ou outro modelo menor) na tela "Modelos de IA" dentro do app.

## Sobre distribuir para outra máquina

`AmbarSetup.exe` empacota só o código do agente — **não** inclui o Ollama nem os modelos
baixados (que sozinhos já passam de vários GB). Isso significa que, pra rodar em outra
máquina, quem for instalar o Ambar ainda precisa instalar o Ollama e baixar o(s)
modelo(s) separadamente, como descrito em "Pré-requisitos" acima. Basta copiar
`installer\output\AmbarSetup.exe` para a outra máquina e rodar — não carrega histórico
junto (cada instalação começa com `data\`/`workspace\` vazios).

## Rodando/alterando o código-fonte (dev)

Crie o ambiente virtual e instale as dependências na primeira vez:

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Para testar direto do código, sem gerar um novo `.exe`:

```
.venv\Scripts\python.exe app.py
```

Isso usa `data\`/`workspace\` na raiz do projeto — uma cópia separada da instalação real
em `%LOCALAPPDATA%\Ambar`, pra não misturar dados de teste com o uso normal.

Depois de alterar o código, para gerar um novo `.exe`:

```
.venv\Scripts\pyinstaller.exe Ambar.spec --noconfirm
```

Isso gera `dist\Ambar.exe`. Para atualizar a instalação real (e o instalador
distribuível) a partir desse novo `.exe`:

```
"C:\Users\<seu-usuário>\AppData\Local\Programs\Inno Setup 6\ISCC.exe" installer\Ambar.iss
```

Isso gera `installer\output\AmbarSetup.exe`. Rodar esse instalador de novo (mesmo sobre
uma instalação já existente) atualiza o `Ambar.exe` em `%LOCALAPPDATA%\Ambar` sem apagar
`data\`/`workspace\` já salvos ali. Requer o [Inno Setup 6](https://jrsoftware.org/isinfo.php)
instalado (`winget install JRSoftware.InnoSetup`).