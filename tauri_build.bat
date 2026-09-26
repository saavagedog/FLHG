@echo off
setlocal
cd /d "%~dp0"

echo Building local MSI and setup EXE...
call npm run tauri -- build --bundles msi,nsis
if errorlevel 1 (
	echo.
	echo Installer build failed. See the output above for details.
	exit /b 1
)

echo.
echo Installers are in src-tauri\target\release\bundle
start "" "%~dp0src-tauri\target\release\bundle"