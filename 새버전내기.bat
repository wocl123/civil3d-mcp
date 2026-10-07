@echo off
chcp 65001 >nul
rem 새 버전 내기: 버전 올리기 → 커밋 → 태그 → GitHub에 올리기 (운영_매뉴얼 2장)
rem 버전을 바로 주려면: 새버전내기.bat 0.3.0
title My Civil 3D MCP - 새 버전 내기
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\new-version.ps1" %*
echo.
pause
