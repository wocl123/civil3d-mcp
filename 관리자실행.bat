@echo off
chcp 65001 >nul
title My Civil 3D MCP - 관리자
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\admin.ps1" %*
if errorlevel 1 (
  echo 관리자 프로그램을 실행하지 못했습니다. 위 오류를 확인하세요.
  pause
  exit /b 1
)
exit /b 0
