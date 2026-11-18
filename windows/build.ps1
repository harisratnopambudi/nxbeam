# Assembles NXBeam for Windows after `npm ci --omit=dev` and build-wdi.ps1:
#   dist\NXBeam\                 the app (NXBeam.exe, the server, Node.js, the driver tool)
#   dist\NXBeam-PC-Windows.zip   portable, and what online updates download
#   dist\NXBeam-Setup.exe        the installer
param([int]$Build = 0)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  $dst = "dist\NXBeam"
  if (Test-Path dist) { Remove-Item -Recurse -Force dist }
  New-Item -ItemType Directory -Force -Path "$dst\runtime", "$dst\driver" | Out-Null

  # the server, as in the portable build
  Copy-Item -Recurse src, public, tools, node_modules, package.json, LICENSE, "Start NXBeam.bat" $dst
  Copy-Item (Get-Command node).Source "$dst\runtime\node.exe"
  Copy-Item package.json "$dst\node_modules\.nxbeam-package.json"
  node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({version: require('./package.json').version, build: Number(process.argv[2])}))" "$dst\build.json" $Build
  if (-not (Test-Path "$dst\node_modules\ffmpeg-static\ffmpeg.exe")) { throw "ffmpeg.exe missing" }

  # the window (WebView2) and the tray
  dotnet build windows\NXBeam.csproj -c Release -nologo -v:minimal -p:NXBeamVersion=$version -o windows\out
  if ($LASTEXITCODE -ne 0) { throw "NXBeam.exe build failed" }
  Copy-Item windows\out\NXBeam.exe, windows\out\NXBeam.exe.config, windows\out\*.dll $dst
  if (-not (Test-Path "$dst\WebView2Loader.dll")) {
    $loader = Get-ChildItem -Recurse windows\out -Filter WebView2Loader.dll | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
    if (-not $loader) { $loader = Get-ChildItem -Recurse "$env:USERPROFILE\.nuget\packages\microsoft.web.webview2" -Filter WebView2Loader.dll | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1 }
    Copy-Item $loader.FullName $dst
  }

  # the USB driver tool (libwdi, LGPL-3.0) and its notice
  Copy-Item windows\wdi\wdi-simple.exe "$dst\driver\"
  Copy-Item windows\wdi\libwdi\COPYING "$dst\driver\libwdi-LGPL-3.0.txt"
  @"
wdi-simple.exe is built from libwdi $((Get-Content windows\build-wdi.ps1 | Select-String 'Tag = "(.*)"').Matches[0].Groups[1].Value)
by Pete Batard and the libwdi contributors (https://github.com/pbatard/libwdi),
licensed under the GNU LGPL 3.0 (libwdi-LGPL-3.0.txt). NXBeam runs it, unchanged,
to install the WinUSB driver for the Switch. Source: the link above.
"@ | Set-Content "$dst\driver\README.txt"

  # portable zip (also the online update)
  Compress-Archive -Path $dst -DestinationPath dist\NXBeam-PC-Windows.zip

  # installer
  if (-not (Test-Path windows\MicrosoftEdgeWebview2Setup.exe)) {
    curl.exe -sSL "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -o windows\MicrosoftEdgeWebview2Setup.exe
  }
  $iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) { choco install innosetup -y --no-progress | Out-Null; $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
  & $iscc /Q "/DAppVersion=$version" "/DSourceDir=$repo\$dst" "/DOutDir=$repo\dist" windows\NXBeam.iss
  if ($LASTEXITCODE -ne 0) { throw "installer build failed" }
  Get-ChildItem dist | Format-Table Name, Length
} finally { Pop-Location }
