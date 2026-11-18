; NXBeam for Windows - installer (Inno Setup 6)
; Built by CI: iscc /DAppVersion=1.2.3 /DSourceDir=..\dist\NXBeam /DOutDir=..\dist NXBeam.iss
;
; Installs for the current user (no administrator needed), in
; %LOCALAPPDATA%\Programs\NXBeam, so NXBeam can update itself online.
; The USB driver for the Switch is the one step that asks Windows for
; permission (UAC), and it works before the Switch was ever plugged in.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\NXBeam"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{6D3E1C52-8B0A-4F7E-9C1D-4E2B7A5F9A11}
AppName=NXBeam
AppVersion={#AppVersion}
AppVerName=NXBeam {#AppVersion}
AppPublisher=Haris DevLab
AppPublisherURL=https://github.com/harisratnopambudi/nxbeam
AppSupportURL=https://github.com/harisratnopambudi/nxbeam/issues
AppUpdatesURL=https://github.com/harisratnopambudi/nxbeam/releases/latest
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Haris DevLab
VersionInfoDescription=NXBeam installer
DefaultDirName={localappdata}\Programs\NXBeam
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=NXBeam-Setup
SetupIconFile=nxbeam.ico
UninstallDisplayIcon={app}\NXBeam.exe
UninstallDisplayName=NXBeam
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
CloseApplications=force
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
en.TaskDriver=Install the USB driver for the Switch now (WinUSB, asks Windows for permission once; the Switch does not need to be plugged in)
en.TaskDesktop=Create a desktop shortcut
en.TaskAutostart=Start NXBeam with Windows (in the tray)
en.RunDriver=Installing the USB driver...
en.RunWebView=Installing Microsoft Edge WebView2 Runtime...
en.Launch=Open NXBeam
en.DriverShortcut=NXBeam - Install USB driver

[Tasks]
Name: "driver"; Description: "{cm:TaskDriver}"
Name: "desktopicon"; Description: "{cm:TaskDesktop}"
Name: "autostart"; Description: "{cm:TaskAutostart}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{autoprograms}\NXBeam"; Filename: "{app}\NXBeam.exe"
Name: "{autoprograms}\{cm:DriverShortcut}"; Filename: "{app}\NXBeam.exe"; Parameters: "--install-driver"
Name: "{autodesktop}\NXBeam"; Filename: "{app}\NXBeam.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NXBeam"; ValueData: """{app}\NXBeam.exe"" --minimized"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "{cm:RunWebView}"; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\NXBeam.exe"; Parameters: "--install-driver --quiet"; StatusMsg: "{cm:RunDriver}"; Flags: waituntilterminated; Tasks: driver
Filename: "{app}\NXBeam.exe"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.update"
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{app}\*.old"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im NXBeam.exe"; Flags: runhidden; RunOnceId: "StopNXBeam"

[Code]
{ the WebView2 runtime is in Windows 11 and in Windows 10 with a current Edge }
function NeedsWebView2: Boolean;
var
  v: String;
begin
  Result := not (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0'))
        and not (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0'));
end;
