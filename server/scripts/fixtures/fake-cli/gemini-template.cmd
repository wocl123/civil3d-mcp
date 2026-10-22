@echo off
if not "%~1"=="" (
  if exist "%FAKE_CLI_BIN%\gemini-logged-in" (
    echo {"event":"result","result":{"status":"SUCCESS","response":"OK"}}
    exit /b 0
  )
  echo Authentication required. Please login. 1>&2
  exit /b 1
)
echo [fake gemini] Google sign-in completed
echo yes>"%FAKE_CLI_BIN%\gemini-logged-in"
exit /b 0
