Set-Location "C:\Users\RAVI\Downloads\HUNT\PROJECTS\ORBIX-WT"
$repo = "C:\Users\RAVI\Downloads\HUNT\PROJECTS\ORBIX-AGENT"
$wt = "C:\Users\RAVI\Downloads\HUNT\PROJECTS\ORBIX-WT"
$out = "$wt\patches"
foreach ($n in "rules-hooks","multi-folder","schedule","partial-accept") {
  git -C "$wt\$n" diff --binary --output="$out\$n.patch" f1d09d0 -- . ':!node_modules'
}
if (-not (Test-Path "$wt\integrate\node_modules")) { cmd /c mklink /J "$wt\integrate\node_modules" "$repo\node_modules" | Out-Null }
foreach ($n in "rules-hooks","multi-folder","schedule","partial-accept") {
  "=== apply $n"
  git -C "$wt\integrate" apply --3way --whitespace=nowarn "$out\$n.patch" 2>&1 | ForEach-Object { "$_" }
}
"=== status"
git -C "$wt\integrate" status --short
