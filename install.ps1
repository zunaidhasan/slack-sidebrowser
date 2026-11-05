<#
  Slack Sidebrowser - install / update

  1) downloads slack-browser-install.zip from the latest GitHub Release
  2) refreshes the payload in %USERPROFILE%\.slack-browser; your PIN, logs and
     backups are left alone, so the same command works as the updater
  3) runs apply-store-patch.ps1 elevated -> patches Store Slack and restarts it
#>
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo    = 'zunaidhasan/slack-sidebrowser'
$zipUrl  = "https://github.com/$repo/releases/latest/download/slack-browser-install.zip"
$sumsUrl = "https://github.com/$repo/releases/latest/download/SHA256SUMS.txt"
$mod     = Join-Path $env:USERPROFILE '.slack-browser'
$work    = Join-Path $env:TEMP ('sb-install-' + [Guid]::NewGuid().ToString('N'))
$zip     = Join-Path $work 'slack-browser-install.zip'
$payload = @('apply-store-patch.ps1','apply-msix-patch.ps1','sb_main.js','sb_update.cjs','sb_store.cjs','sb_lock.cjs','sb_tabs.cjs','sb_blocker.cjs','sb_search.cjs','sb_easylist.txt','sb_preload.cjs','sb_content_preload.cjs','sb_toolbar.html','sb_toolbar_preload.cjs','sb_unlock.html','sb_settings.html','sb_phrase.html','sb_onboarding.html','uninstall.ps1')

function Say($m) { Write-Host "[sb] $m" }

try {
  if (Get-Process -Name 'slack' -ErrorAction SilentlyContinue) {
    Say 'Slack is running. Close Slack before installing to avoid file-locking problems.'
    [void](Read-Host 'Press Enter after closing Slack, or Ctrl+C to cancel')
    if (Get-Process -Name 'slack' -ErrorAction SilentlyContinue) {
      throw 'Slack is still running. Close all Slack windows and rerun the installer.'
    }
  }

  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Say 'downloading package from GitHub Releases...'
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
    if ((Get-Item $zip).Length -lt 1KB) { throw 'release package is empty' }
  } catch {
    throw "Release download failed. Check your network or proxy configuration. Details: $($_.Exception.Message)"
  }
  try {
    $sums = Join-Path $work 'SHA256SUMS.txt'
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sums -UseBasicParsing
    $expectedHash = $null
    foreach ($line in (Get-Content $sums)) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?slack-browser-install\.zip$') {
        if ($expectedHash) { throw 'checksum file contains duplicate package entries' }
        $expectedHash = $Matches[1]
      }
    }
    if (-not $expectedHash) { throw 'checksum file has no slack-browser-install.zip entry' }
    $actualHash = (Get-FileHash $zip -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) { throw 'package SHA-256 does not match the release checksum' }
    Say 'release package checksum verified'
  } catch {
    throw "Release package checksum verification failed: $($_.Exception.Message)"
  }
  Say ('package ok: ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB')

  Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force
  $src = Join-Path $work 'x'
  # The codeload fallback wraps the repository in a project-sha folder.
  if (-not (Test-Path (Join-Path $src 'apply-store-patch.ps1'))) {
    $inner = Get-ChildItem $src -Filter 'slack-browser-install.zip' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($inner) {
      Expand-Archive -Path $inner.FullName -DestinationPath (Join-Path $work 'x2') -Force
      $src = Join-Path $work 'x2'
    }
  }
  if (-not (Test-Path (Join-Path $src 'apply-store-patch.ps1'))) {
    $dir = Get-ChildItem $src -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'apply-store-patch.ps1') -ErrorAction SilentlyContinue } | Select-Object -First 1
    if ($dir) { $src = $dir.FullName }
  }
  foreach ($f in ($payload + 'work\app.new.asar')) {
    if (-not (Test-Path (Join-Path $src $f))) { throw "package is incomplete: missing $f" }
  }

  $fresh = -not (Test-Path (Join-Path $mod 'sb_main.js'))
  foreach ($d in @($mod, (Join-Path $mod 'work'), (Join-Path $mod 'distribute'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

  $changed = 0
  foreach ($f in $payload) {
    $from = Join-Path $src $f
    $to   = Join-Path $mod $f
    $same = (Test-Path $to) -and ((Get-FileHash $from).Hash -eq (Get-FileHash $to).Hash)
    Copy-Item $from $to -Force
    Copy-Item $from (Join-Path $mod ('distribute\' + $f)) -Force
    if (-not $same) { $changed++; Say ('  wrote ' + $f) }
  }
  Copy-Item (Join-Path $src 'work\app.new.asar') (Join-Path $mod 'work\app.new.asar') -Force
  Say ($(if ($fresh) { 'fresh install' } else { 'update' }) + ": $changed file(s) changed")
  Say 'left untouched: sb_pin.json, sb_bookmarks.json, sb_ui.json, sb.log, store\*.bak, app.asar.bak, SlackApp\'

  try {
    $pkg = Get-AppxPackage -Name '*slack*' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'slackdesktop|Slack' } | Select-Object -First 1
    $ver = $pkg.Version
    if ($ver) {
      Say ("installed Slack: $ver")
    }
  } catch {}

  $patch = Join-Path $mod 'apply-store-patch.ps1'
  Say 'requesting admin to patch Slack - accept the UAC prompt...'
  $patchProcess = $null
  try {
    $patchProcess = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$patch`" -HomeDir `"$mod`""
  } catch {
    throw "Could not start the elevated patcher (UAC may have been cancelled). Payload files are staged; rerun apply-store-patch.ps1 manually when ready. Details: $($_.Exception.Message)"
  }
  if (-not $patchProcess -or $patchProcess.ExitCode -ne 0) {
    $code = if ($patchProcess) { $patchProcess.ExitCode } else { 'unknown' }
    throw "Elevated patcher failed with exit code $code. Check $mod\patch-result.txt before retrying."
  }

  $res = Join-Path $mod 'patch-result.txt'
  if (-not (Test-Path $res)) { throw "Patcher exited successfully but did not write its result file: $res" }
  $patchResult = Get-Content $res -Raw
  Get-Content $res | ForEach-Object { Say $_ }
  if ($patchResult -match 'ROLLBACK' -or $patchResult -notmatch 'PATCH OK\b') {
    throw "Slack patch was not confirmed successful. Review $res and the recovery steps before launching Slack."
  }
  if ($patchResult -match ' \(classic\)') {
    Say 'note: Store Slack is ACL-locked, so the patched copy is CLASSIC Slack - open Slack from the Start Menu/desktop shortcut (not the Store tile); first run may ask to log in again.'
  }
  Say 'done. Open Slack -> your own DM -> type the secret phrase -> set your PIN.'
} catch {
  Say ('FAILED: ' + $_.Exception.Message)
  throw
} finally {
  try { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
