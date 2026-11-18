@echo off
title NXBeam
cd /d "%~dp0"
rem NXBEAM_LAUNCHER=2: this launcher can apply an online update (exit code 75)
set NXBEAM_LAUNCHER=2
rem Portable build: Node.js and every dependency are already inside
if not exist "runtime\node.exe" goto system
:portable
if exist "runtime\node.next.exe" move /y "runtime\node.next.exe" "runtime\node.exe" >nul
"runtime\node.exe" src\index.js %*
if errorlevel 75 if not errorlevel 76 (
  "runtime\node.exe" tools\apply-update.js
  goto portable
)
pause
exit /b

:system
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Unduh versi portable NXBeam dari GitHub Releases,
  echo atau pasang Node.js dari https://nodejs.org lalu jalankan file ini lagi.
  start https://github.com/harisratnopambudi/nxbeam/releases/latest
  pause
  exit /b 1
)
:systemrun
rem Pasang dependensi hanya saat pertama kali atau setelah NXBeam diperbarui
fc /b package.json node_modules\.nxbeam-package.json >nul 2>nul
if errorlevel 1 (
  echo Memasang dependensi, sekali saja...
  call npm install --omit=dev --no-fund --no-audit --loglevel=error
  if not errorlevel 1 copy /y package.json node_modules\.nxbeam-package.json >nul
)
node src\index.js %*
if errorlevel 75 if not errorlevel 76 (
  node tools\apply-update.js
  goto systemrun
)
pause
