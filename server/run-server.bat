@echo off
cd /d "%~dp0"
set PORT=8787
"C:\Program Files\nodejs\node.exe" "node_modules\tsx\dist\cli.mjs" src\server.ts > "C:\Users\ADITYA~1\AppData\Local\Temp\opencode\blocks8787.log" 2> "C:\Users\ADITYA~1\AppData\Local\Temp\opencode\blocks8787err.log"
