@echo off
rem Creates Desktop and Start-menu shortcuts for ORBIX. Remove them with:  Create-Shortcuts.cmd -Remove
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcut.ps1" %*
