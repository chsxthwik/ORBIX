# Builds the native desktop host: bin\ORBIX.exe
# Needs nothing but Windows: it uses the C# compiler that ships with .NET Framework 4,
# and downloads the (small) Microsoft WebView2 .NET wrapper once from nuget.org.
#   npm run build
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin'
$sdkVersion = '1.0.4314.35'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$core = Join-Path $bin 'Microsoft.Web.WebView2.Core.dll'
$wf = Join-Path $bin 'Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $bin 'WebView2Loader.dll'
if (-not ((Test-Path $core) -and (Test-Path $wf) -and (Test-Path $loader))) {
  Write-Host "Downloading Microsoft.Web.WebView2 $sdkVersion from nuget.org ..."
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("orbix-webview2-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'pkg.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
    $x = Join-Path $tmp 'x'
    Copy-Item (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.Core.dll') $core -Force
    Copy-Item (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') $wf -Force
    Copy-Item (Join-Path $x 'runtimes\win-x64\native\WebView2Loader.dll') $loader -Force
    $lic = Get-ChildItem -Path $x -Filter 'LICENSE*' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($lic) { Copy-Item $lic.FullName (Join-Path $bin 'WebView2-LICENSE.txt') -Force }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc" }
$icon = Join-Path $root 'assets\icon.ico'
if (-not (Test-Path $icon)) { throw "Missing $icon" }

$out = Join-Path $bin 'ORBIX.exe'
# If the app is running its exe is locked: build next to it as .new. ORBIX.vbs swaps it in on the next start.
$target = $out
try { if (Test-Path $out) { [IO.File]::Open($out, 'Open', 'ReadWrite', 'None').Close() } } catch { $target = "$out.new"; Write-Host 'The app is running, so the new build is staged as ORBIX.exe.new and installs on the next start.' }
$tmpOut = if ($target -like '*.new') { Join-Path $bin 'ORBIX.staged.exe' } else { $target }
# The file version comes from package.json, so the exe and the app always agree.
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$versionCs = Join-Path $bin 'Version.g.cs'
Set-Content -Path $versionCs -Encoding UTF8 -Value "[assembly: System.Reflection.AssemblyVersion(`"$version.0`")]`r`n[assembly: System.Reflection.AssemblyFileVersion(`"$version.0`")]"
try {
  & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$tmpOut" "/win32icon:$icon" `
    "/reference:$core" "/reference:$wf" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    (Join-Path $root 'host\Program.cs') $versionCs
  if ($LASTEXITCODE -ne 0) { throw "Compilation failed (exit $LASTEXITCODE)" }
} finally { Remove-Item -Force $versionCs -ErrorAction SilentlyContinue }
if ($tmpOut -ne $target) { Move-Item -Force $tmpOut $target }
Write-Host "Built $target ($([math]::Round((Get-Item $target).Length / 1KB)) KB)"
