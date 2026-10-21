@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo   Starting DukaanAI Full Stack Ecosystem
echo ========================================================

:: 1. Check & Start Native Redis (port 6379)
echo [1/3] Checking Redis server on port 6379...
redis-win\redis-cli.exe ping >nul 2>&1
if %errorlevel% neq 0 (
    echo       Redis is not running. Launching native Redis on port 6379...
    start "DukaanAI Redis" /min cmd /c "redis-win\redis-server.exe --dir redis-win --dbfilename dump-win.rdb"
    timeout /t 1 /nobreak >nul
) else (
    echo       Redis is already up and running!
)

:: 2. Check if API is already compiled; if not, compile it once
if not exist "apps\api\dist\main.js" (
    echo       API build not found. Running initial build...
    cd /d "%~dp0apps\api"
    call npm run build
    cd /d "%~dp0"
)

:: 3. Check & Start NestJS API Backend (port 3002)
echo [2/3] Checking API backend on port 3002...
netstat -ano | findstr /R ":3002.*LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    echo       Launching API backend on http://localhost:3002...
    cd /d "%~dp0apps\api"
    start "DukaanAI API" cmd /k "npx cross-env NODE_ENV=development node dist/main.js"
    cd /d "%~dp0"
    
    echo       Waiting for API backend to initialize on port 3002...
    set /a waitApi=0
    :wait_for_api
    timeout /t 1 /nobreak >nul
    netstat -ano | findstr /R ":3002.*LISTENING" >nul 2>&1
    if !errorlevel! neq 0 (
        set /a waitApi+=1
        if !waitApi! lss 15 goto wait_for_api
        echo       [Note] API backend is still initializing...
    ) else (
        echo       API backend is ready on port 3002!
    )
) else (
    echo       API backend is already up and running on http://localhost:3002!
)

:: 4. Check & Start Next.js Web Frontend (port 3010)
echo [3/3] Checking Web frontend on port 3010...
netstat -ano | findstr /R ":3010.*LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    echo       Launching Web frontend on http://localhost:3010...
    cd /d "%~dp0apps\web"
    start "DukaanAI Web" cmd /k "npm run dev"
    cd /d "%~dp0"
    
    echo       Waiting for Web frontend to bind to port 3010...
    set /a waitWeb=0
    :wait_for_web
    timeout /t 1 /nobreak >nul
    netstat -ano | findstr /R ":3010.*LISTENING" >nul 2>&1
    if !errorlevel! neq 0 (
        set /a waitWeb+=1
        if !waitWeb! lss 25 goto wait_for_web
    )
) else (
    echo       Web frontend is already up and running on http://localhost:3010!
)

echo ========================================================
echo   All systems ready!
echo   - Web Frontend:  http://localhost:3010
echo   - API Backend:   http://localhost:3002
echo   - API Health:    http://localhost:3002/api/health
echo ========================================================

:: Open website automatically in your default browser
start http://localhost:3010

