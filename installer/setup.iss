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
Source: "installer-common.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "download-yt-dlp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "download-ffmpeg.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "write-token.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "configure-ytdlp-runtime.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "register-startup-task.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Guide d'installation de l'extension Chrome"; Filename: "{app}\install-extension.html"
Name: "{group}\Désinstaller YT Grabber"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register-startup-task.ps1"" -AppDir ""{app}"" -RemoveOnly ""1"""; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\configure-ytdlp-runtime.ps1"" -AppDir ""{app}"" -RemoveOnly ""1"""; Flags: runhidden waituntilterminated
Filename: "taskkill.exe"; Parameters: "/IM YTGrabber-Server.exe /F"; Flags: runhidden

[UninstallDelete]
Type: files; Name: "{app}\yt-dlp.exe"
Type: files; Name: "{app}\ffmpeg.exe"
Type: files; Name: "{app}\ffprobe.exe"
Type: files; Name: "{app}\ytg-nodejs.exe"
Type: files; Name: "{app}\ytgrabber-installer-state.json"
Type: files; Name: "{app}\ytgrabber.token"
Type: files; Name: "{app}\ytgrabber.log"
Type: filesandordirs; Name: "{app}"

[Code]
var
  InstallMode: string;
  InstallSummary: string;
  InstallHasWarnings: Boolean;

procedure ResetInstallSummary;
begin
  InstallSummary := '';
  InstallHasWarnings := False;
end;

procedure AppendSummaryLine(const Line: string);
begin
  if InstallSummary <> '' then
    InstallSummary := InstallSummary + #13#10;
  InstallSummary := InstallSummary + Line;
end;

function BuildResultPath(const Component: string): string;
begin
  Result := AddBackslash(ExpandConstant('{tmp}')) + 'ytg-' + Component + '-result.ini';
end;

procedure AppendResultSummary(const DefaultComponent, ResultPath: string; Executed: Boolean; ExitCode: Integer);
var
  Component: string;
  StatusText: string;
  MessageText: string;
  WarningText: string;
  Line: string;
begin
  if FileExists(ResultPath) then
  begin
    Component := GetIniString('Result', 'component', DefaultComponent, ResultPath);
    StatusText := GetIniString('Result', 'status', 'warning', ResultPath);
    MessageText := GetIniString('Result', 'message', '', ResultPath);
    WarningText := GetIniString('Result', 'warning', '0', ResultPath);

    if WarningText <> '0' then
      InstallHasWarnings := True;

    Line := '- ' + Component + ': ' + StatusText + '.';
    if MessageText <> '' then
      Line := Line + ' ' + MessageText;
    AppendSummaryLine(Line);

    DeleteFile(ResultPath);
    exit;
  end;

  InstallHasWarnings := True;
  if Executed then
    AppendSummaryLine('- ' + DefaultComponent + ': warning. The installer helper did not report a result (exit code ' + IntToStr(ExitCode) + ').')
  else
    AppendSummaryLine('- ' + DefaultComponent + ': warning. The installer helper could not be launched.');
end;

function RunPowerShellStep(const Component, ScriptName, ExtraArgs: string): Boolean;
var
  ResultPath: string;
  Params: string;
  ExitCode: Integer;
begin
  ResultPath := BuildResultPath(Component);
  if FileExists(ResultPath) then
    DeleteFile(ResultPath);

  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(ExpandConstant('{app}\' + ScriptName)) +
    ' -AppDir ' + AddQuotes(ExpandConstant('{app}')) +
    ' -InstallMode ' + AddQuotes(InstallMode) +
    ' -ResultPath ' + AddQuotes(ResultPath);

  if ExtraArgs <> '' then
    Params := Params + ' ' + ExtraArgs;

  Log('Running installer step "' + Component + '": ' + Params);
  Result := Exec('powershell.exe', Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if not Result then
    ExitCode := -1;

  AppendResultSummary(Component, ResultPath, Result, ExitCode);
end;

procedure AppendServerInstallSummary;
begin
  if FileExists(ExpandConstant('{app}\YTGrabber-Server.exe')) then
  begin
    if InstallMode = 'update' then
      AppendSummaryLine('- server: updated. Updated the local YT Grabber server files.')
    else
      AppendSummaryLine('- server: installed. Installed the local YT Grabber server files.');
  end
  else
  begin
    InstallHasWarnings := True;
    AppendSummaryLine('- server: warning. The YT Grabber server executable is missing after installation.');
  end;
end;

procedure StartInstalledServer;
var
  ExitCode: Integer;
begin
  if not FileExists(ExpandConstant('{app}\YTGrabber-Server.exe')) then
  begin
    InstallHasWarnings := True;
    AppendSummaryLine('- server-launch: warning. The installed server executable is missing, so the server was not started.');
    exit;
  end;

  if Exec(ExpandConstant('{app}\YTGrabber-Server.exe'), '', ExpandConstant('{app}'), SW_HIDE, ewNoWait, ExitCode) then
    AppendSummaryLine('- server-launch: started. Attempted to start the local server immediately.')
  else
  begin
    InstallHasWarnings := True;
    AppendSummaryLine('- server-launch: warning. Failed to start the local server automatically at the end of the ' + InstallMode + '.');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  InstallMode := 'install';
  if FileExists(AddBackslash(WizardDirValue) + 'YTGrabber-Server.exe') then
    InstallMode := 'update';

  ResetInstallSummary;
  Result := '';

  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM YTGrabber-Server.exe /F >nul 2>&1 || exit /b 0', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SummaryTitle: string;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  ResetInstallSummary;
  AppendSummaryLine('Mode: ' + InstallMode + '.');
  AppendServerInstallSummary;

  RunPowerShellStep('token', 'write-token.ps1',
    ' -ApiToken ' + AddQuotes(ExpandConstant('{param:APITOKEN|}')) +
    ' -ApiTokenFile ' + AddQuotes(ExpandConstant('{param:APITOKENFILE|}')));
  RunPowerShellStep('yt-dlp', 'download-yt-dlp.ps1', '');
  RunPowerShellStep('ffmpeg', 'download-ffmpeg.ps1', '');
  RunPowerShellStep('node-runtime', 'configure-ytdlp-runtime.ps1',
    ' -JsRuntimePath ' + AddQuotes(ExpandConstant('{param:JSRUNTIMEPATH|}')) +
    ' -DownloadNodeJs ' + AddQuotes(ExpandConstant('{param:DOWNLOADNODEJS|}')));
  RunPowerShellStep('startup-task', 'register-startup-task.ps1', '');
  StartInstalledServer;

  if not WizardSilent then
  begin
    if InstallHasWarnings then
      SummaryTitle := 'YT Grabber a terminé avec avertissements.'
    else
      SummaryTitle := 'YT Grabber a terminé correctement.';

    MsgBox(SummaryTitle + #13#10#13#10 + InstallSummary, mbInformation, MB_OK);
  end;

  if (InstallMode = 'install') and not WizardSilent then
  begin
    if not ShellExec('open', ExpandConstant('{app}\install-extension.html'), '', ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, ResultCode) then
      Log('Failed to open install-extension.html after a fresh install.');
  end;
end;
