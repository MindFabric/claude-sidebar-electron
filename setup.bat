@echo off
echo ================================
echo   Claude Sidebar - Windows Setup
echo ================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js not found. Please install from: https://nodejs.org
    pause
    exit /b 1
)
echo [✓] Node.js found

where wsl >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] WSL not found. Run: wsl --install
    echo     Then install Claude CLI inside WSL:
    echo     wsl bash -c "npm install -g @anthropic-ai/claude-code"
    pause
    exit /b 1
)
echo [✓] WSL found

wsl bash -c "command -v claude" >nul 2>&1
if %errorlevel% neq 0 (
    echo [+] Installing Claude CLI in WSL...
    wsl bash -c "npm install -g @anthropic-ai/claude-code"
) else (
    echo [✓] Claude CLI found in WSL
)

echo.
echo [*] Installing dependencies...
call npm install

echo.
echo ================================
echo   Setup complete!
echo   Run: npm start
echo ================================
pause
