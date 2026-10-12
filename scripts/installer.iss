; My Civil 3D MCP 설치 프로그램 (Inno Setup 6).
; build-installer.ps1이 컴파일한다: ISCC /DAppVersion=x.y.z /DBundleDir=<번들 폴더> [/DTeamFile=<team.json>]
;
; 설치 대상: %APPDATA%\Autodesk\ApplicationPlugins\MyCivil3DMcp.bundle (사용자별, 관리자 권한 불필요)
; 명령줄 옵션(자동 업데이트·시험용):
;   /VERYSILENT /SUPPRESSMSGBOXES /NORESTART   창 없이 설치
;   /DIR=<번들 폴더>                            설치 위치(시험용)
;   /DataDir=<폴더>                             team.json을 넣을 사용자 데이터 폴더
;   /Sandbox=1                                  시험용: Civil 3D 실행 확인과 "앱 및 기능" 등록을 건너뛴다

#ifndef AppVersion
  #error AppVersion을 지정하세요 (/DAppVersion=x.y.z)
#endif
#ifndef BundleDir
  #error BundleDir을 지정하세요 (/DBundleDir=<번들 폴더>)
#endif

[Setup]
; UpgradeCode(PackageContents.xml)와 같은 값: 버전이 바뀌어도 같은 프로그램으로 본다.
AppId={{E49DD37D-13B7-4DA8-A616-85109188D819}
AppName=My Civil 3D MCP
AppVersion={#AppVersion}
AppVerName=My Civil 3D MCP {#AppVersion}
AppPublisher=wocl123
AppPublisherURL=https://github.com/wocl123/civil3d-mcp
AppSupportURL=https://github.com/wocl123/civil3d-mcp/issues
VersionInfoVersion={#AppVersion}
VersionInfoCompany=wocl123
VersionInfoDescription=My Civil 3D MCP Setup
VersionInfoProductName=My Civil 3D MCP
VersionInfoCopyright=Copyright (c) 2026 wocl123

; Civil 3D가 읽는 플러그인 폴더에 사용자별로 설치한다. 위치는 고정이라 묻지 않는다.
PrivilegesRequired=lowest
DefaultDirName={userappdata}\Autodesk\ApplicationPlugins\MyCivil3DMcp.bundle
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; 제거 프로그램은 번들 밖에 둔다: 번들 안의 파일은 manifest 목록과 정확히 같아야 한다.
UninstallFilesDir={app}.uninstall
UninstallDisplayName=My Civil 3D MCP
CreateUninstallRegKey=not IsSandbox

; Civil 3D 실행 여부는 아래 [Code]에서 직접 확인한다(재시작 관리자가 node.exe를 끄지 않게).
CloseApplications=no
RestartApplications=no

Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
OutputBaseFilename=MyCivil3DMcp-{#AppVersion}-win-x64

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Messages]
FinishedLabel=설치가 끝났습니다.%n%nCivil 3D 2025를 실행하고, 처음 질문할 때 사용할 AI를 선택해 로그인하세요.

[InstallDelete]
; 이전 버전의 파일을 남기지 않는다(없어진 파일이 남아 manifest와 달라지지 않게).
Type: filesandordirs; Name: "{app}\Contents"
Type: files; Name: "{app}\PackageContents.xml"
; 예전 설치 프로그램(0.1.7 이하)이 남긴 작업 폴더와 백업.
Type: filesandordirs; Name: "{app}.backup-*"

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
#ifdef TeamFile
; 팀 정보(관리자 메일, 배포 저장소, 자동 수신 주소). 비밀이 아니다. 제거해도 남긴다.
Source: "{#TeamFile}"; DestDir: "{param:DataDir|{localappdata}\MyCivil3DMcp\data}"; DestName: "team.json"; \
  Flags: ignoreversion uninsneveruninstall
#endif

[UninstallDelete]
; 실행 중에 생긴 파일까지 지운다. 사용자 데이터(%LOCALAPPDATA%\MyCivil3DMcp)는 건드리지 않는다.
Type: filesandordirs; Name: "{app}"

[Code]
function IsSandbox: Boolean;
begin
  Result := ExpandConstant('{param:Sandbox|0}') = '1';
end;

// 예전 설치 프로그램 형식(--extract)으로 불리면 바로 끝낸다.
// 0.1.7 이하의 자동 업데이트가 이 방식으로 부르는데, 창 없이 띄워서 기다리므로 마법사를 열면 멈춘다.
function IsLegacyExtractCall: Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
  begin
    if ParamStr(Index) = '--extract' then
    begin
      Result := True;
    end;
  end;
end;

function CountProcesses(Where: String): Integer;
var
  Locator, Service, Found: Variant;
begin
  Result := 0;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Found := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE ' + Where);
    Result := Found.Count;
  except
    Log('프로세스 확인 실패: ' + GetExceptionMessage);
  end;
end;

function WqlText(Text: String): String;
begin
  Result := Text;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '''', '\''', True);
end;

// 설치를 막는 실행 중인 프로그램. 없으면 빈 문자열.
function BlockingProgram: String;
var
  Node: String;
begin
  Result := '';
  if CountProcesses('Name = ''acad.exe''') > 0 then
  begin
    Result := 'Civil 3D/AutoCAD가 실행 중입니다. 모두 종료한 뒤 다시 시도하세요.';
    Exit;
  end;

  Node := ExpandConstant('{app}\Contents\node\node.exe');
  if CountProcesses('Name = ''node.exe'' AND ExecutablePath = ''' + WqlText(Node) + '''') > 0 then
  begin
    Result := 'My Civil 3D MCP 서비스가 아직 실행 중입니다. 잠시 후 다시 시도하세요.';
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := not IsLegacyExtractCall;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not IsSandbox then
  begin
    Result := BlockingProgram;
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  if UninstallSilent then
  begin
    Exit;
  end;

  while CountProcesses('Name = ''acad.exe''') > 0 do
  begin
    if MsgBox('Civil 3D/AutoCAD를 모두 종료한 뒤 [다시 시도]를 누르세요.', mbError, MB_RETRYCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  end;
end;
