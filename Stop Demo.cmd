@echo off
title Secure Tenant Portal - stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\demo.ps1" -Stop
timeout /t 4 >nul
