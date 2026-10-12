@echo off
chcp 65001 >nul
title My Civil 3D MCP - 관리자
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\admin.ps1" %*
pause
