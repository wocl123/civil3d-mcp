@echo off
rem Fake npm for cli-missing-scenario.mjs: "npm install -g @openai/codex" puts the fake codex in FAKE_CLI_BIN.
if defined FAKE_NPM_FAIL exit /b 1
if /i "%1"=="install" (
  echo [fake npm] installing %3 ...
  set "template=codex"
  if /i "%3"=="@google/gemini-cli" set "template=gemini"
  call :install %*
  exit /b %errorlevel%
)
echo [fake npm] %*
exit /b 0

:install
  if /i "%4"=="--prefix" (
    if not exist "%~5" mkdir "%~5"
    copy /y "%~dp0%template%-template.cmd" "%~5\%template%.cmd" >nul
  ) else (
    copy /y "%~dp0%template%-template.cmd" "%FAKE_CLI_BIN%\%template%.cmd" >nul
  )
  echo [fake npm] added 1 package
  exit /b 0
