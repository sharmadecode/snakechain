@echo off
cd /d "%~dp0"
if not exist "%TEMP%\opencode" mkdir "%TEMP%\opencode"
set PORT=8787
node node_modules\tsx\dist\cli.mjs src\server.ts > "%TEMP%\opencode\snakechain8787.log" 2> "%TEMP%\opencode\snakechain8787err.log"
