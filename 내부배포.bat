@echo off
setlocal
chcp 65001 >nul
title My Civil 3D MCP - 내부 배포
pushd "%~dp0" || exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\internal-deploy.ps1" %*
set "internalDeployExitCode=%errorlevel%"
if not "%internalDeployExitCode%"=="0" echo 내부 배포 실패. 위 오류를 확인하세요.
popd
pause
exit /b %internalDeployExitCode%
