@echo off
setlocal
title WizzCards Arcade Store

cd /d "%~dp0"

echo.
echo ==========================================
echo       WIZZCARDS ARCADE STORE
echo             HUNT THE RARE
echo ==========================================
echo.

if not exist "index.html" (
    echo ERROR: No se encontro index.html.
    echo.
    echo Descarga los archivos del repositorio y coloca este BAT
    echo en la misma carpeta que index.html y catalog.json.
    echo.
    pause
    exit /b 1
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8000
    py -m http.server 8000
    goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8000
    python -m http.server 8000
    goto :eof
)

echo No se encontro Python instalado.
echo Instala Python desde https://www.python.org/downloads/
echo y marca la opcion "Add Python to PATH".
echo.
pause
