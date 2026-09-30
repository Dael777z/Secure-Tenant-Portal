@echo off
title Summit - reset
echo.
echo   This deletes the local demo database and loads fresh demo data.
echo   Nothing outside this PC is affected.
echo.
choice /c YN /m "  Continue"
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\portal.ps1" -Reset %*
if errorlevel 1 pause
