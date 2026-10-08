@echo off
chcp 65001 >nul
setlocal
rem 파일 위치를 기준으로 실행하여 한글과 공백이 있는 폴더에서도 동작합니다.
title My Civil 3D MCP - 설치 / 업데이트
echo.
echo My Civil 3D MCP 설치 / 업데이트
echo 작업을 준비하고 있습니다.
echo.
if not exist "%~dp0install.ps1" (
  echo [오류] install.ps1 파일이 없습니다. ZIP 전체를 압축 해제해 주세요.
  pause
  exit /b 1
)
rem ZIP 전체가 같은 폴더에 있어야 사용자가 개발 경로 없이 실행할 수 있습니다.
if not exist "%~dp0package-common.ps1" (
  echo [오류] 설치 파일이 빠져 있습니다. ZIP 전체를 새 폴더에 압축 해제해 주세요.
  pause
  exit /b 1
)
if not exist "%~dp0MyCivil3DMcp.bundle\Contents\manifest.json" if not exist "%~dp0MyCivil3DMcp.bundle.zip" (
  echo [오류] 설치 파일(MyCivil3DMcp.bundle.zip)이 없습니다. ZIP 전체를 새 폴더에 압축 해제해 주세요.
  pause
  exit /b 1
)
rem 설치 창은 기존 install.ps1을 실행합니다. UI가 없는 구버전은 콘솔로 실행합니다.
if exist "%~dp0installer-ui.ps1" (
  start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0installer-ui.ps1"
  exit /b 0
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "result=%errorlevel%"
echo.
if "%result%"=="0" (
  echo 설치 / 업데이트 작업이 완료되었습니다.
) else (
  echo [오류] 작업을 완료하지 못했습니다. 위 오류 내용을 확인해 주세요.
)
echo.
pause
exit /b %result%
