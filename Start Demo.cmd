@echo off
title Secure Tenant Portal - demo
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\demo.ps1" %*
if errorlevel 1 pause
