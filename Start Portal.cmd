@echo off
title Summit - Friday Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\portal.ps1" %*
if errorlevel 1 pause
