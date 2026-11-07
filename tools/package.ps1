# Creates a portable release: release\ORBIX-<version>-win-x64.zip
# Unzip anywhere and run ORBIX.exe (or ORBIX.vbs). Nothing is installed outside that folder.
# The zip carries its own Node.js runtime (official build, SHA-256 checked), so users install nothing.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

& (Join-Path $PSScriptRoot 'build-host.ps1')
$exe = Join-Path $root 'bin\ORBIX.exe'
if (Test-Path "$exe.new") { $exe = "$exe.new" }   # a staged (newer) build wins

$stage = Join-Path $root 'release\stage\ORBIX'
if (Test-Path (Join-Path $root 'release\stage')) { Remove-Item -Recurse -Force (Join-Path $root 'release\stage') }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($d in 'src', 'web', 'assets') { Copy-Item (Join-Path $root $d) (Join-Path $stage $d) -Recurse -Force }
# Ship only app files: no temp/backup/editor files, logs, source maps or tests that may sit in the source folders.
Get-ChildItem $stage -Recurse -Force -File -Include '*.tmp', '*.log', '*.bak', '*.orig', '*.map', '*.test.mjs', '.DS_Store', 'Thumbs.db', 'desktop.ini' | Remove-Item -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'tools') | Out-Null
foreach ($f in 'install.ps1', 'uninstall.ps1', 'doctor.mjs') { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $stage "tools\$f") -Force }

# Bundled Node.js: newest v24 LTS build for win-x64, verified against nodejs.org's SHASUMS256.txt, cached in %TEMP%\orbix-build-cache (outside the project).
$cache = Join-Path ([IO.Path]::GetTempPath()) 'orbix-build-cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$base = 'https://nodejs.org/dist/latest-v24.x'
$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
$line = ($sums -split "`n") | Where-Object { $_ -match '\snode-v[\d.]+-win-x64\.zip$' } | Select-Object -First 1
if (-not $line) { throw 'Could not find the Node.js win-x64 build in SHASUMS256.txt' }
$hash, $name = ($line.Trim() -split '\s+')
$nodeZip = Join-Path $cache $name
if (-not (Test-Path $nodeZip) -or (Get-FileHash $nodeZip -Algorithm SHA256).Hash -ne $hash.ToUpper()) {
  Write-Host "Downloading $name"
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $nodeZip
}
if ((Get-FileHash $nodeZip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { Remove-Item -Force $nodeZip; throw "Checksum mismatch for $name" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$rt = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
$za = [IO.Compression.ZipFile]::OpenRead($nodeZip)
try {
  foreach ($e in $za.Entries) {
    if ($e.Name -eq 'node.exe' -or $e.Name -eq 'LICENSE') { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $rt $e.Name), $true) }
  }
} finally { $za.Dispose() }
if (-not (Test-Path (Join-Path $rt 'node.exe'))) { throw 'node.exe missing from the Node.js archive' }
Rename-Item (Join-Path $rt 'LICENSE') 'NODE-LICENSE.txt'
Write-Host "Bundled $name"

New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null
Copy-Item $exe (Join-Path $stage 'bin\ORBIX.exe') -Force
foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt') { Copy-Item (Join-Path $root "bin\$f") (Join-Path $stage "bin\$f") -Force }
foreach ($f in 'ORBIX.vbs', 'README.md', 'LICENSE', 'NOTICE.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json') { Copy-Item (Join-Path $root $f) (Join-Path $stage $f) -Force }

$zip = Join-Path $root "release\ORBIX-$version-win-x64.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# Write the zip by hand so entry names use '/' (Compress-Archive in Windows PowerShell writes '\', which other unzip tools reject).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$base = Split-Path -Parent $stage
$fs = [IO.File]::Open($zip, 'CreateNew')
$za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in Get-ChildItem -Path $stage -Recurse -File) {
    $name = $f.FullName.Substring($base.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $za.Dispose(); $fs.Dispose() }
Remove-Item -Recurse -Force (Join-Path $root 'release\stage')

# Refuse to publish a zip that carries user data, tests, logs, caches or machine-specific files.
$za = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $bad = $za.Entries | Where-Object { $_.FullName -match '^ORBIX/(data|test|release|site|host|node_modules)/|\.(log|tmp|bak|jsonl)$|/cache/|instance\.json$|engine\.json$|mcp(-trust)?\.json$' } | Select-Object -ExpandProperty FullName
} finally { $za.Dispose() }
if ($bad) { Remove-Item -Force $zip; throw "The zip would contain files that must not ship:`n$($bad -join "`n")" }
Write-Host ("Created {0} ({1} KB)" -f $zip, [math]::Round((Get-Item $zip).Length / 1KB))

# Stamp the release version, size and SHA-256 into site\index.html (the zip itself is published as a GitHub release asset).
$site = Join-Path $root 'site'
if (Test-Path (Join-Path $site 'index.html')) {
  $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  $mb = [math]::Round((Get-Item $zip).Length / 1MB)
  $page = Join-Path $site 'index.html'
  $html = [IO.File]::ReadAllText($page)
  $html = [regex]::Replace($html, 'releases/download/v\d+\.\d+\.\d+/', "releases/download/v$version/")
  $html = [regex]::Replace($html, 'ORBIX-\d+\.\d+\.\d+-win-x64\.zip', "ORBIX-$version-win-x64.zip")
  $html = [regex]::Replace($html, 'v\d+\.\d+\.\d+ for Windows', "v$version for Windows")
  $html = [regex]::Replace($html, 'Get ORBIX \d+\.\d+\.\d+', "Get ORBIX $version")
  $html = [regex]::Replace($html, '\b\d+ MB\b', "$mb MB")
  $shaPattern = '(id="sha">)[0-9a-f]{64}(</code>)'
  if (-not [regex]::IsMatch($html, $shaPattern)) { throw 'site\index.html has no SHA-256 element (id="sha") to stamp' }
  $html = [regex]::Replace($html, $shaPattern, "`${1}$sha`${2}")
  [IO.File]::WriteAllText($page, $html, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Website updated for ORBIX-$version-win-x64.zip  SHA-256 $sha"
}
