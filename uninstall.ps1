param(
  [string]$HomeDir,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$mod = if ($HomeDir) { $HomeDir } else { Join-Path $env:USERPROFILE '.slack-browser' }
$result = Join-Path $mod 'patch-result.txt'

function Say($message) { Write-Host "[sb-uninstall] $message" }

if (Get-Process -Name slack -ErrorAction SilentlyContinue) {
  throw 'Close Slack completely before restoring the original files.'
}
if (-not (Test-Path -LiteralPath $result)) {
  throw "Patch result not found: $result"
}

$log = Get-Content -LiteralPath $result -Raw
$target = [regex]::Match($log, '(?im)^target:\s+(.+?)\s+\((store|classic)\)\s*$')
$developerPackage = Get-AppxPackage -Name '*slack*' -ErrorAction SilentlyContinue |
  Where-Object { $_.SignatureKind -eq 'Developer' } | Select-Object -First 1

if (-not $Elevated) {
  $startInfo = @{
    FilePath = 'powershell.exe'
    Verb = 'RunAs'
    Wait = $true
    PassThru = $true
    ArgumentList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -HomeDir `"$mod`" -Elevated"
  }
  $child = Start-Process @startInfo
  if ($child.ExitCode -ne 0) { throw "Uninstall restore failed with exit code $($child.ExitCode)." }
  exit 0
}

if ($developerPackage) {
  $packageDir = Join-Path $mod 'work\msix'
  $originalPackage = Get-ChildItem -LiteralPath $packageDir -Filter 'Slack.*.msix' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'sb-*' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $originalPackage) {
    throw "Original Slack MSIX not found under $packageDir; the modified package was left installed."
  }
  Say "removing modified Slack package $($developerPackage.PackageFullName)"
  Remove-AppxPackage -Package $developerPackage.PackageFullName -ErrorAction Stop
  Say "restoring original Slack from $($originalPackage.Name)"
  Add-AppxPackage -Path $originalPackage.FullName -ErrorAction Stop
  Say 'original Slack package restored'
  exit 0
}

if (-not $target.Success) {
  throw 'Could not identify the patched Slack executable in patch-result.txt.'
}

$exe = $target.Groups[1].Value.Trim()
$kind = $target.Groups[2].Value.ToLowerInvariant()
$tag = if ($kind -eq 'classic') { 'classic' } else { 'store' }
$exeBackup = Join-Path $mod "store\Slack.exe.$tag.bak"
$asarBackup = Join-Path $mod "store\app.asar.$tag.bak"
$asar = Join-Path (Split-Path -Parent $exe) 'resources\app.asar'

foreach ($file in @($exe, $asar, $exeBackup, $asarBackup)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Required restore file not found: $file" }
}

Copy-Item -LiteralPath $exeBackup -Destination $exe -Force
Copy-Item -LiteralPath $asarBackup -Destination $asar -Force
Say "restored original Slack executable and app.asar ($kind)"
Say 'user data and .slack-browser data were left untouched'
