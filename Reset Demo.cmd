@echo off
title Secure Tenant Portal - reset
echo.
echo   This deletes the demo database on this PC and loads the sample data again.
echo.
choice /c YN /m "  Continue"
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\demo.ps1" -Reset %*
if errorlevel 1 pause
