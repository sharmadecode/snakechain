@echo off
setlocal
cd /d "%~dp0"
if not exist "%TEMP%\opencode" mkdir "%TEMP%\opencode"
taskkill /FI "WINDOWTITLE eq SNAKECHAIN-server-8787*" /F >nul 2>&1
start "SNAKECHAIN-server-8787" /min cmd /c "set PORT=8787&& node node_modules\tsx\dist\cli.mjs src\server.ts > %TEMP%\opencode\snakechain8787.log 2> %TEMP%\opencode\snakechain8787err.log"
echo SnakeChain server starting on http://localhost:8787
timeout /t 2 >nul
endlocal
