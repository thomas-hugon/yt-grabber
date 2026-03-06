[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName=YT Grabber
AppVersion=1.0
DefaultDirName={autopf}\YTGrabber
OutputBaseFilename=YTGrabber-Setup
OutputDir=..\dist
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
MinVersion=10.0

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\YTGrabber-Server.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs
Source: "install-extension.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "download-yt-dlp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "download-ffmpeg.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Guide d'installation de l'extension Chrome"; Filename: "{app}\install-extension.html"
Name: "{group}\Désinstaller YT Grabber"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\download-yt-dlp.ps1"" -AppDir ""{app}"""; StatusMsg: "Téléchargement de yt-dlp..."; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\download-ffmpeg.ps1"" -AppDir ""{app}"""; StatusMsg: "Téléchargement de ffmpeg..."; Flags: runhidden waituntilterminated
Filename: "schtasks.exe"; Parameters: "/Create /TN ""YTGrabber"" /TR ""{app}\YTGrabber-Server.exe"" /SC ONLOGON /DELAY 0001:00 /RL HIGHEST /F"; Flags: runhidden waituntilterminated
Filename: "{app}\YTGrabber-Server.exe"; Flags: nowait postinstall runhidden
Filename: "{app}\install-extension.html"; Flags: shellexec postinstall skipifsilent; Description: "Ouvrir le guide d'installation de l'extension Chrome"

[UninstallRun]
Filename: "schtasks.exe"; Parameters: "/End /TN ""YTGrabber"""; Flags: runhidden
Filename: "schtasks.exe"; Parameters: "/Delete /TN ""YTGrabber"" /F"; Flags: runhidden
Filename: "taskkill.exe"; Parameters: "/IM YTGrabber-Server.exe /F"; Flags: runhidden

[UninstallDelete]
Type: files; Name: "{app}\yt-dlp.exe"
Type: files; Name: "{app}\ffmpeg.exe"
Type: files; Name: "{app}\ytgrabber.token"
Type: files; Name: "{app}\ytgrabber.log"
Type: filesandordirs; Name: "{app}"

[Code]
var
  ApiToken: string;

function NewTokenChunk(): string;
var
  G: TGUID;
begin
  if CreateGUID(G) = 0 then
    Result := Lowercase(Copy(GUIDToString(G), 2, 36))
  else
    Result := Lowercase(IntToHex(GetTickCount64, 16));
  StringChangeEx(Result, '-', '', True);
end;

function ResolveApiToken(): string;
begin
  Result := Trim(ExpandConstant('{param:APITOKEN|}'));
  if Result = '' then
    Result := NewTokenChunk() + NewTokenChunk();
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    ApiToken := ResolveApiToken();
    SaveStringToFile(ExpandConstant('{app}\ytgrabber.token'), ApiToken + #13#10, False);
  end;

  if CurStep = ssPostInstall then
  begin
    if not FileExists(ExpandConstant('{app}\yt-dlp.exe')) then
      MsgBox('yt-dlp.exe est introuvable. Téléchargez-le manuellement depuis https://github.com/yt-dlp/yt-dlp/releases et copiez-le dans le dossier d''installation.', mbError, MB_OK);
  end;
end;
