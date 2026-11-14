@echo off
title NXBeam
cd /d "%~dp0"
rem Portable build: Node.js and every dependency are already inside
if exist "runtime\node.exe" (
  "runtime\node.exe" src\index.js %*
  pause
  exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Unduh versi portable NXBeam dari GitHub Releases,
  echo atau pasang Node.js dari https://nodejs.org lalu jalankan file ini lagi.
  start https://github.com/harisratnopambudi/nxbeam/releases/latest
  pause
  exit /b 1
)
rem Pasang dependensi hanya saat pertama kali atau setelah NXBeam diperbarui
fc /b package.json node_modules\.nxbeam-package.json >nul 2>nul
if errorlevel 1 (
  echo Memasang dependensi, sekali saja...
  call npm install --omit=dev --no-fund --no-audit --loglevel=error
  if not errorlevel 1 copy /y package.json node_modules\.nxbeam-package.json >nul
)
node src\index.js %*
pause
