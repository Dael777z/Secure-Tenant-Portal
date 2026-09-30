@echo off
title Summit - stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\portal.ps1" -Stop
timeout /t 4 >nul
