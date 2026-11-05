# ORBIX uninstaller. Installed as Uninstall-ORBIX.ps1 next to bin\ORBIX.exe.
#   Uninstall-ORBIX.ps1          remove shortcuts + app; chat history moves to a backup folder
#   Uninstall-ORBIX.ps1 -Force   remove everything including chat history
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSCommandPath

$lnkTargets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ORBIX.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ORBIX.lnk')
)
foreach ($t in $lnkTargets) { if (Test-Path $t) { Remove-Item $t -Force } }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ORBIX'
if (Test-Path $key) { Remove-Item $key -Recurse -Force }

$running = Get-Process -Name ORBIX -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
if ($running) {
  if (-not $Force) { throw "ORBIX is running. Close it first (or rerun with -Force)." }
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

$data = Join-Path $dir 'data'
$hasData = (Test-Path $data) -and (Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($hasData -and -not $Force) {
  $backup = Join-Path $env:LOCALAPPDATA 'ORBIX-data-backup'
  if (Test-Path $backup) { $backup = "$backup-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  Move-Item $data $backup
  Write-Host "Chat history and settings kept at $backup"
}
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
Write-Host 'ORBIX uninstalled.'
