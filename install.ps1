<#
  Slack Sidebrowser - install / update

  1) downloads slack-browser-install.zip from this repo
  2) refreshes the payload in %USERPROFILE%\.slack-browser; your PIN, logs and
     backups are left alone, so the same command works as the updater
  3) runs apply-store-patch.ps1 elevated -> patches Store Slack and restarts it
#>
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo    = 'zunaidhasan/slack-sidebrowser'
$branch  = 'main'
$releaseZipUrl = "https://github.com/$repo/releases/latest/download/slack-browser-install.zip"
$zipUrl  = "https://raw.githubusercontent.com/$repo/$branch/slack-browser-install.zip"
$zipUrlcb = $zipUrl + '?cb=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$mod     = Join-Path $env:USERPROFILE '.slack-browser'
$work    = Join-Path $env:TEMP ('sb-install-' + [Guid]::NewGuid().ToString('N'))
$zip     = Join-Path $work 'slack-browser-install.zip'
$payload = @('apply-store-patch.ps1','apply-msix-patch.ps1','sb_main.js','sb_update.cjs','sb_store.cjs','sb_blocker.cjs','sb_search.cjs','sb_easylist.txt','sb_preload.cjs','sb_content_preload.cjs','sb_toolbar.html','sb_toolbar_preload.cjs','sb_unlock.html','sb_settings.html','sb_phrase.html')

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
  Say 'downloading package...'
  function ApiZipBytes {
    # contents API cannot serve >1MB blobs raw; resolve sha then fetch the git blob (base64)
    $meta = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/slack-browser-install.zip?ref=$branch" -Headers @{ 'User-Agent' = 'slack-sidebrowser' } -ProxyUseDefaultCredentials
    $blob = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/git/blobs/$($meta.sha)" -Headers @{ 'User-Agent' = 'slack-sidebrowser' } -ProxyUseDefaultCredentials
    [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String(($blob.content -replace '\s', '')))
  }
  # Prefer versioned release assets; use the repository copy until the first release exists.
  try {
    Invoke-WebRequest -Uri $releaseZipUrl -OutFile $zip -UseBasicParsing -ProxyUseDefaultCredentials
    if ((Get-Item $zip).Length -lt 1KB) { throw 'release package is empty' }
  } catch {
    Say 'release package unavailable - repository package retry...'
    try { ApiZipBytes } catch {
      Say 'blob API failed - codeload retry...'
      try {
        Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/$branch" -OutFile $zip -UseBasicParsing -ProxyUseDefaultCredentials
        if ((Get-Item $zip).Length -lt 1KB) { throw 'codeload returned an empty response' }
      } catch {
        Say 'codeload failed - raw retry...'
        try {
          Invoke-WebRequest -Uri "$zipUrlcb" -OutFile $zip -UseBasicParsing -ProxyUseDefaultCredentials
        } catch {
          try {
            Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -ProxyUseDefaultCredentials
          } catch {
            throw "Download failed. This is usually caused by a strict network firewall or proxy configuration. Details: $($_.Exception.Message)"
          }
        }
      }
    }
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
      Say ("installed Slack: $ver (this package is built for 4.53.276)")
      if ([string]$ver -notlike '4.53.276*') { Say 'note: version differs - the patcher rolls back automatically if Slack fails to start' }
    }
  } catch {}

  $patch = Join-Path $mod 'apply-store-patch.ps1'
  Say 'requesting admin to patch Slack - accept the UAC prompt...'
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$patch`" -HomeDir `"$mod`""
  } catch {
    Say 'elevation cancelled - files are in place, run apply-store-patch.ps1 manually when ready'
    return
  }
  $res = Join-Path $mod 'patch-result.txt'
  if (Test-Path $res) { Get-Content $res | ForEach-Object { Say $_ } }
  if ((Test-Path $res) -and ((Get-Content $res -Raw) -match ' \(classic\)')) {
    Say 'note: Store Slack is ACL-locked, so the patched copy is CLASSIC Slack - open Slack from the Start Menu/desktop shortcut (not the Store tile); first run may ask to log in again.'
  }
  if ((Test-Path $res) -and ((Get-Content $res -Raw) -match 'ROLLBACK')) {
    Say 'note: the patcher rolled back - Slack would not load the payload; check %USERPROFILE%\.slack-browser\patch-result.txt'
  }
  Say 'done. Open Slack -> your own DM -> type the secret phrase -> set your PIN.'
} catch {
  Say ('FAILED: ' + $_.Exception.Message)
  throw
} finally {
  try { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
