@echo off
rem Fake npm for cli-missing-scenario.mjs: "npm install -g @openai/codex" puts the fake codex in FAKE_CLI_BIN.
if /i "%1"=="install" (
  echo [fake npm] installing %3 ...
  if /i "%4"=="--prefix" (
    if not exist "%~5" mkdir "%~5"
    copy /y "%~dp0codex-template.cmd" "%~5\codex.cmd" >nul
  ) else (
    copy /y "%~dp0codex-template.cmd" "%FAKE_CLI_BIN%\codex.cmd" >nul
  )
  echo [fake npm] added 1 package
  exit /b 0
)
echo [fake npm] %*
