# ORBIX installer: installs the app like a normal program.
#   tools\install.ps1                 install to %LOCALAPPDATA%\Programs\ORBIX + shortcuts
#   tools\install.ps1 -Remove         uninstall (keeps chat history unless -Force)
#   tools\install.ps1 -InstallDir D   custom install folder
#   tools\install.ps1 -NoShortcut     files only: no Desktop/Start-menu shortcuts, no Apps entry
#   tools\install.ps1 -Force          stop a running ORBIX / skip prompts
#
# Works two ways: from a built release zip (release\ORBIX-*-win-x64.zip, built on demand)
# or straight from an extracted ORBIX folder / the repo (needs Node.js on PATH then).
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\ORBIX'),
  [string]$Zip,
  [switch]$Remove,
  [switch]$NoShortcut,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lnkTargets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ORBIX.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ORBIX.lnk')
)
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ORBIX'

function Remove-Shortcuts {
  foreach ($t in $lnkTargets) { if (Test-Path $t) { Remove-Item $t -Force } }
  if (Test-Path $uninstallKey) { Remove-Item $uninstallKey -Recurse -Force }
}

if ($Remove) {
  $running = Get-Process -Name ORBIX -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
  if ($running) {
    if (-not $Force) { throw "ORBIX is running from $InstallDir. Close it first (or rerun with -Force)." }
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
  }
  Remove-Shortcuts
  $data = Join-Path $InstallDir 'data'
  $hasData = (Test-Path $data) -and (Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($hasData -and -not $Force) {
    $backup = Join-Path $env:LOCALAPPDATA 'ORBIX-data-backup'
    if (Test-Path $backup) { $backup = "$backup-$(Get-Date -Format yyyyMMdd-HHmmss)" }
    Move-Item $data $backup
    Write-Host "Chat history and settings kept at $backup"
  }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Write-Host "ORBIX uninstalled."
  exit 0
}

# --- pick the payload: zip first (carries its own Node.js), then a folder ---
$src = $null; $tmp = $null
if ($Zip) {
  if (-not (Test-Path $Zip)) { throw "Zip not found: $Zip" }
} else {
  $zips = Get-ChildItem (Join-Path $root 'release') -Filter 'ORBIX-*-win-x64.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if ($zips) { $Zip = $zips[0].FullName }
}
if ($Zip) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("orbix-install-" + [Guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $Zip -DestinationPath $tmp -Force
  $src = Join-Path $tmp 'ORBIX'
  if (-not (Test-Path (Join-Path $src 'bin\ORBIX.exe'))) { Remove-Item -Recurse -Force $tmp; throw "The zip does not contain bin\ORBIX.exe." }
} elseif ((Test-Path (Join-Path $root 'bin\ORBIX.exe')) -and (Test-Path (Join-Path $root 'src\main.mjs'))) {
  $src = $root
  if (-not (Test-Path (Join-Path $src 'runtime\node.exe'))) {
    Write-Host 'Note: no bundled Node.js in this folder; the installed app will use Node.js from PATH.'
  }
} else {
  Write-Host 'No release zip found - building one first (this takes a few minutes)...'
  & (Join-Path $PSScriptRoot 'package.ps1')
  $zips = Get-ChildItem (Join-Path $root 'release') -Filter 'ORBIX-*-win-x64.zip' | Sort-Object LastWriteTime -Descending
  if (-not $zips) { throw 'package.ps1 finished but no zip was produced.' }
  $Zip = $zips[0].FullName
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("orbix-install-" + [Guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $Zip -DestinationPath $tmp -Force
  $src = Join-Path $tmp 'ORBIX'
}

# --- install ---
$running = Get-Process -Name ORBIX -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
if ($running) {
  if (-not $Force) { if ($tmp) { Remove-Item -Recurse -Force $tmp }; throw "ORBIX is running from $InstallDir. Close it first (or rerun with -Force)." }
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# robocopy /E without /PURGE: upgrades overwrite app files but never delete user data (data\).
$xd = @('.git', 'node_modules', 'test', 'site', 'docs', 'host', 'release', 'data') | ForEach-Object { Join-Path $src $_ }
$xf = @('*.log', '*.tmp', '*.bak', '*.orig', '*.map', '*.new', '*.test.mjs', 'Thumbs.db', '.DS_Store', 'desktop.ini')
robocopy $src $InstallDir /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE)" }
if ($tmp) { Remove-Item -Recurse -Force $tmp }

# Uninstaller inside the install dir + Apps & Features entry.
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') (Join-Path $InstallDir 'Uninstall-ORBIX.ps1') -Force
$version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version

if (-not $NoShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($t in $lnkTargets) {
    $lnk = $shell.CreateShortcut($t)
    $lnk.TargetPath = Join-Path $InstallDir 'bin\ORBIX.exe'
    $lnk.WorkingDirectory = $InstallDir
    $lnk.IconLocation = Join-Path $InstallDir 'bin\ORBIX.exe'
    $lnk.Description = 'ORBIX - Unified ADE'
    $lnk.Save()
  }
  New-Item -Path $uninstallKey -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name DisplayName -Value 'ORBIX' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value $version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name Publisher -Value 'chsxthwik' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $InstallDir -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name DisplayIcon -Value (Join-Path $InstallDir 'bin\ORBIX.exe') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}\Uninstall-ORBIX.ps1"' -f $InstallDir) -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
}

Write-Host ''
Write-Host "ORBIX $version installed to $InstallDir"
if (-not $NoShortcut) { Write-Host 'Shortcuts: Desktop and Start menu. Uninstall: Settings > Apps, or Uninstall-ORBIX.ps1 in the install folder.' }
Write-Host 'Launch it from the Desktop shortcut or bin\ORBIX.exe.'
