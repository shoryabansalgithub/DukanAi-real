@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo   Stopping DukaanAI Full Stack (Ports 3010, 3002, 6379)
echo ========================================================

:: 1. Stop Web Frontend (Port 3010)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3010" ^| findstr "LISTENING"') do (
    echo Stopping Web frontend process %%a on port 3010...
    taskkill /f /pid %%a >nul 2>&1
)

:: 2. Stop API Backend (Port 3002)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3002" ^| findstr "LISTENING"') do (
    echo Stopping API backend process %%a on port 3002...
    taskkill /f /pid %%a >nul 2>&1
)

:: 3. Stop Redis Server (Port 6379)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6379" ^| findstr "LISTENING"') do (
    echo Stopping Redis process %%a on port 6379...
    taskkill /f /pid %%a >nul 2>&1
)

echo ========================================================
echo   All DukaanAI services have been stopped.
echo ========================================================
