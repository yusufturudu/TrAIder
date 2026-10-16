@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TrAIder - Durdur

echo.
echo  [1/2] TrAIder sunucusu kapatiliyor...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Write-Host \"  Sunucu kapatildi.\" } else { Write-Host \"  Sunucu zaten kapali.\" }"

echo.
echo  [2/2] Docker: PostgreSQL ve n8n durduruluyor (veriler silinmez)...
docker compose stop

echo.
echo  Hepsi durduruldu. Tekrar acmak icin baslat.bat
pause
