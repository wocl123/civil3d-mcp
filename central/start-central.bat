@echo off
rem Double-click: start the central server so other PCs can connect. Remove -AllowNetwork to serve this PC only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-central.ps1" -AllowNetwork %*
pause
