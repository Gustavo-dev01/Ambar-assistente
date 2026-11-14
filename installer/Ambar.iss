; Instalador do Ambar (Inno Setup). Compilar com:
;   "CAMINHO\PARA\ISCC.exe" installer\Ambar.iss
; Gera installer\output\AmbarSetup.exe.
;
; Instala em %LOCALAPPDATA%\Ambar (não em Program Files) de propósito: não exige
; privilégio de administrador e permite que data/ e workspace/ sejam criados e
; escritos livremente ao lado do .exe em tempo de execução (Program Files é
; read-only por padrão para usuários comuns, o que quebraria agent/config.py).

#define MyAppName "Ambar"
#define MyAppVersion "1.0"
#define MyAppPublisher "Ambar Systems"
#define MyAppExeName "Ambar.exe"

[Setup]
AppId={{B3F1D8B0-6E1F-4C7A-9B0A-3A6E2C1F9A10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=AmbarSetup
SetupIconFile=..\web\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
VersionInfoCompany={#MyAppPublisher}
VersionInfoProductName={#MyAppName}
VersionInfoVersion={#MyAppVersion}

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "..\dist\Ambar.exe"; DestDir: "{app}"; Flags: ignoreversion
; Guia de instalação do Ollama/modelos. Precisa existir FORA do app, porque o cliente
; que ainda não instalou o Ollama não consegue usar o Ambar pra ler o tutorial de dentro
; dele — o mesmo conteúdo está na view "Primeiros passos" pra quem já conseguiu abrir.
Source: "COMECE-AQUI.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Comece aqui (instalação do Ollama)"; Filename: "{app}\COMECE-AQUI.txt"

[Run]
; O guia abre depois de instalar, antes do app: sem Ollama o Ambar não responde, e é
; melhor o cliente ler os 3 passos do que abrir o chat e achar que está quebrado.
Filename: "{app}\COMECE-AQUI.txt"; Description: "Abrir o guia de instalação (recomendado)"; Flags: shellexec nowait postinstall skipifsilent
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir o {#MyAppName} agora"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Sem essa entrada, data/ e workspace/ (criados em runtime, fora do [Files]) ficariam
; órfãos após desinstalar. O instalador avisa o usuário antes (ver [Code] abaixo).
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\workspace"

[Code]
function InitializeUninstall(): Boolean;
begin
  if UninstallSilent then begin
    Result := True;
    exit;
  end;
  Result := MsgBox('Isso também vai apagar suas conversas, memória, projetos e base de conhecimento salvos no Ambar (pasta "data" e "workspace"). Deseja continuar?',
    mbConfirmation, MB_YESNO) = IDYES;
end;