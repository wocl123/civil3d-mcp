@echo off
rem Fake Codex CLI: "login status" fails until "login" has run once.
if /i "%1"=="login" if /i "%2"=="status" (
  if exist "%~dp0codex-logged-in" (echo Logged in using ChatGPT & exit /b 0)
  echo Not logged in & exit /b 1
)
if /i "%1"=="login" (
  echo [fake codex] browser sign-in completed
  type nul > "%~dp0codex-logged-in"
  exit /b 0
)
echo [fake codex] %*
