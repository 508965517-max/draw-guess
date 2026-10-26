@echo off
cd /d "%~dp0"
echo 正在启动「你画我猜」...
start "" "C:\Users\5888\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
timeout /t 2 >nul
start http://localhost:3000
