@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TrAIder - n8n is akislari

echo.
echo  [1/3] Is akislari n8n'e aktariliyor...
docker exec traider-n8n n8n import:workflow --separate --input=/workflows
if errorlevel 1 goto hata

echo.
echo  [2/3] Is akislari yayinlaniyor (publish)...
for %%i in (TrAIderFiyatKyt1 TrAIderAlarmKnt1 TrAIderGunlukRp1) do docker exec traider-n8n n8n publish:workflow --id=%%i

echo.
echo  [3/3] n8n yeniden baslatiliyor...
docker restart traider-n8n >nul

echo.
echo  Tamam! 20 saniye sonra http://localhost:5678 adresini yenile.
pause
exit /b 0

:hata
echo.
echo  HATA: n8n calismiyor olabilir. Once baslat.bat ile Docker'i baslat.
pause
exit /b 1
