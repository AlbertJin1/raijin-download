@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Raijin Download Manager - Build

echo ============================================================
echo  Raijin Download Manager - Windows x64 build
echo  by Jessie Albert Regualos (Yotsuchi)
echo ============================================================

where node >nul 2>nul || (echo ERROR: Node.js was not found. Install Node.js 22.12+ from https://nodejs.org & goto :fail)
where npm  >nul 2>nul || (echo ERROR: npm was not found on PATH. & goto :fail)

node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0]>22||(v[0]===22&&v[1]>=12)?0:1)"
if errorlevel 1 (echo ERROR: Node.js 22.12 or newer is required. & goto :fail)

if not exist "public\icons\raijin.ico" (echo ERROR: Missing public\icons\raijin.ico & goto :fail)

echo.
echo [1/4] Installing dependencies...
if exist "package-lock.json" (call npm ci --no-audit --no-fund) else (call npm install --no-audit --no-fund)
if errorlevel 1 goto :fail

echo.
echo [2/4] Running tests...
call npm test
if errorlevel 1 goto :fail

echo.
echo [3/4] Checking sources and building the interface...
call npm run check
if errorlevel 1 goto :fail

echo.
echo [4/4] Packaging installer and portable app...
if exist "release" rmdir /s /q "release"
call npx electron-builder --win nsis portable --x64 --publish never
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Installer : %~dp0release\Raijin-Setup-2.0.0.exe
echo  Portable  : %~dp0release\Raijin-Portable-2.0.0.exe
echo ============================================================
pause
exit /b 0

:fail
echo.
echo BUILD FAILED - review the messages above.
pause
exit /b 1
