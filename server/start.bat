@echo off
setlocal
cd /d "%~dp0"
taskkill /FI "WINDOWTITLE eq BLOCKS-server-8787*" /F >nul 2>&1
start "BLOCKS-server-8787" /min cmd /c "set PORT=8787&& node node_modules\tsx\dist\cli.mjs src\server.ts > %TEMP%\opencode\blocks8787.log 2> %TEMP%\opencode\blocks8787err.log"
echo BLOCKS server starting on http://localhost:8787
timeout /t 2 >nul
endlocal
