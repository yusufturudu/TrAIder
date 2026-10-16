@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TrAIder

echo.
echo  [1/3] Docker: PostgreSQL ve n8n baslatiliyor...
docker compose up -d
if errorlevel 1 (
    echo.
    echo  HATA: Docker calismiyor. Docker Desktop'i acip tekrar dene.
    pause
    exit /b 1
)

echo.
echo  [2/3] Node paketleri kontrol ediliyor...
call npm install --no-audit --no-fund --loglevel=error

echo.
echo  [3/3] TrAIder sunucusu baslatiliyor...
echo  Site: http://localhost:3000     n8n: http://localhost:5678
echo  Kapatmak icin bu pencerede Ctrl + C
echo.
node server.js
pause
