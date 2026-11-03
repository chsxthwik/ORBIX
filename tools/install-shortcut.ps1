# Creates "ORBIX" shortcuts on the Desktop and in the Start menu (they launch bin\ORBIX.exe).
# Usage: npm run shortcut          (remove them again with: npm run shortcut -- -Remove)
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'bin\ORBIX.exe'
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ORBIX.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ORBIX.lnk')
)

if ($Remove) {
  foreach ($t in $targets) { if (Test-Path $t) { Remove-Item $t -Force; Write-Host "Removed $t" } }
  exit 0
}

if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot 'build-host.ps1') }
if (-not (Test-Path $exe)) { throw 'bin\ORBIX.exe is missing and could not be built.' }

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'ORBIX - Unified ADE'
  $lnk.Save()
  Write-Host "Created $t"
}
