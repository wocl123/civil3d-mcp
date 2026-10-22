@echo off
setlocal
chcp 65001 >nul
title My Civil 3D MCP - 내부 테스트 (버전 유지)
pushd "%~dp0" || exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\internal-test.ps1" %*
set "internalTestExitCode=%errorlevel%"
if not "%internalTestExitCode%"=="0" echo 내부 테스트 미완료. 위 오류를 확인하세요.
popd
pause
exit /b %internalTestExitCode%
