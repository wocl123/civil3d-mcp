@echo off
if defined FAKE_AGY_INSTALL_FAIL exit /b 1
if not exist "%~1" mkdir "%~1"
copy /y "%~dp0gemini-template.cmd" "%~1\agy.cmd" >nul
exit /b %errorlevel%
