# Builds wdi-simple.exe from libwdi (LGPL-3.0, Pete Batard - the engine of Zadig)
# the way libwdi's own CI does, with the WinUSB files from the WDK redistributables.
# Output: windows\wdi\wdi-simple.exe
param([string]$Tag = "v1.5.1")
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "wdi"
New-Item -ItemType Directory -Force -Path $root | Out-Null
Push-Location $root
try {
  if (-not (Test-Path libwdi)) { git clone -q --depth 1 --branch $Tag https://github.com/pbatard/libwdi }
  if (-not (Test-Path wdk)) {
    curl.exe -sSL "https://go.microsoft.com/fwlink/p/?LinkID=253170" -o wdk-redist.msi
    Start-Process msiexec.exe -Wait -ArgumentList "/a wdk-redist.msi /qn TARGETDIR=$root\wdk"
  }
  $wdk = (Resolve-Path "wdk\Windows Kits\8.0").Path.Replace('\', '/')
  # WinUSB only: libusb0 / libusbK are not built in
  $cfg = "libwdi\msvc\config.h"
  $c = Get-Content $cfg -Raw
  $c = $c -replace '#define LIBUSB0_DIR "[^"]*"', '// no libusb0' -replace '#define LIBUSBK_DIR "[^"]*"', '// no libusbK'
  $c = $c -replace '#define WDK_DIR "[^"]*"', ('#define WDK_DIR "' + $wdk + '"')
  $c = $c -replace '(?m)^#define OPT_ARM\s*$', '// no ARM'
  Set-Content $cfg $c
  $msbuild = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
  & $msbuild libwdi\libwdi.sln /m /v:minimal /p:Configuration=Release /p:Platform=Win32
  if ($LASTEXITCODE -ne 0) { throw "libwdi build failed" }
  $exe = Get-ChildItem -Recurse -Filter wdi-simple.exe | Where-Object { $_.FullName -match 'Release' } | Select-Object -First 1
  if (-not $exe) { throw "wdi-simple.exe not found" }
  Copy-Item $exe.FullName (Join-Path $root "wdi-simple.exe") -Force
  Write-Host "wdi-simple.exe: $($exe.FullName)"
} finally { Pop-Location }
