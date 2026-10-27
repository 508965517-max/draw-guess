@echo off
cd /d "%~dp0"
echo 正在启动本地服务器（端口 3000）...
start "draw-guess" /min "C:\Users\5888\.workbuddy\binaries\node\versions\22.22.2\node.exe" serve.js
timeout /t 2 >nul
start "" http://localhost:3000
echo 已在浏览器打开 http://localhost:3000
echo 单人模式可完全离线游玩；多人模式需要联网（PeerJS 信令服务器）。
pause
