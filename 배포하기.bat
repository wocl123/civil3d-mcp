@echo off
chcp 65001 >nul
title My Civil 3D MCP - GitHub Release 배포
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1" %*
if errorlevel 1 echo 배포 실패. 위 오류를 확인하세요.
pause
