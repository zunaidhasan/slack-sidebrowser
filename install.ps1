<#
  Slack Browser - one-line install / update
    irm https://raw.githubusercontent.com/Kryptoniannn/slack-browser/main/install.ps1 | iex

  1) downloads slack-browser-install.zip from this repo
  2) refreshes the payload in %USERPROFILE%\.slack-browser; your PIN, logs and
     backups are left alone, so the same command works as the updater
  3) runs apply-store-patch.ps1 elevated -> patches Store Slack and restarts it
#>
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo    = 'Kryptoniannn/slack-browser'
$branch  = 'main'
$zipUrl  = "https://raw.githubusercontent.com/$repo/$branch/slack-browser-install.zip"
$zipUrlcb = $zipUrl + '?cb=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$mod     = Join-Path $env:USERPROFILE '.slack-browser'
$work    = Join-Path $env:TEMP ('sb-install-' + [Guid]::NewGuid().ToString('N'))
$zip     = Join-Path $work 'slack-browser-install.zip'
$payload = @('apply-store-patch.ps1','apply-msix-patch.ps1','sb_main.js','sb_update.cjs','sb_store.cjs','sb_blocker.cjs','sb_search.cjs','sb_easylist.txt','sb_preload.cjs','sb_content_preload.cjs','sb_toolbar.html','sb_toolbar_preload.cjs','sb_unlock.html','sb_settings.html','sb_phrase.html')
$sbStart = Get-Date

# ---- installation telemetry ------------------------------------------------
# Every install (success AND failure) appends one anonymized line to
# telemetry/<yyyy-MM-dd>.jsonl in this repo, so errors seen on any user PC
# can be diagnosed later. The token below is a dedicated fine-grained GitHub
# token with ONLY Contents:read/write on this repository - if it leaks,
# damage is limited to this one repo (replace/rotate it any time).
$sbTkn = 'PASTE_TOKEN_HERE'   # optional: fine-grained PAT, only this repo, Contents:read/write
$sbHook = ''                  # alternative (no GitHub token): Discord webhook URL for #sb-telemetry
                              # https://discord.com/api/webhooks/<id>/<secret>
function Send-SbTelemetry([string]$result, [string]$route, [string]$errLines) {
  try {
    $mid = ($env:COMPUTERNAME + '|' + $env:USERNAME)
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($mid))
    $hid = (($sha[0..3] | ForEach-Object { $_.ToString('x2') }) -join '')
    $slackKind = ''; $slackVer = ''
    $resAll = ''
    try { $pr = Join-Path $mod 'patch-result.txt'; if (Test-Path $pr) { $resAll += (Get-Content $pr -Raw -ErrorAction SilentlyContinue) } } catch {}
    try { $mr = Join-Path $mod 'msix-result.txt'; if (Test-Path $mr) { $resAll += "`n" + (Get-Content $mr -Raw -ErrorAction SilentlyContinue) } } catch {}
    if (-not $route) {
      if ($resAll -match '\((msix|store|classic|portable|none)\)') { $route = $Matches[1] }
    }
    if ($resAll -match '_v?(\d+\.\d+\.\d+(?:\.\d+)?)_') { $slackVer = $Matches[1] }
    elseif ($resAll -match 'installed (\d+\.\d+\.\d+(?:\.\d+)?)') { $slackVer = $Matches[1] }
    if (-not $slackVer) {
      try { $pkgt = Get-AppxPackage -Name '*slack*' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($pkgt) { $slackVer = $pkgt.Version } } catch {}
    }
    $tail = ''
    if (-not $errLines) {
      $els = ($resAll -split "`r?`n") | Where-Object { $_ -match 'ERROR|ROLLBACK|FAILED|SENTINEL|still locked|failed|incomplete' } | Select-Object -Last 5
      $tail = ($els -join ' ; ')
    } else { $tail = $errLines }
    if ($tail.Length -gt 600) { $tail = $tail.Substring(($tail.Length - 600), 600) }
    $ev = [ordered]@{
      ts = [DateTime]::UtcNow.ToString('o')
      result = $result
      route = $route
      slack = $slackVer
      win = [Environment]::OSVersion.Version.ToString()
      ps = $PSVersionTable.PSVersion.ToString()
      machine = $hid
      dur = [int]((Get-Date) - $sbStart).TotalSeconds
      err = $tail
    }
    $line = $ev | ConvertTo-Json -Compress
    # Discord webhook route: no GitHub token involved; each event is a message
    # in a private channel, with the full JSON line readable/scrollable there
    if ($sbHook -and $sbHook -match '^https://(discord|discordapp)\.com/api/webhooks/') {
      $content = '```json' + [char]10 + $line + [char]10 + '```'
      $body = @{ content = $content } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri $sbHook -ContentType 'application/json' -Body $body -TimeoutSec 20 | Out-Null
      return
    }
    if (-not $sbTkn -or $sbTkn -match 'REPLACE|PASTE_') { return }
    $h = @{ Authorization = "Bearer $sbTkn"; 'User-Agent' = 'slack-browser-telemetry'; Accept = 'application/vnd.github+json' }
    $ref = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/git/ref/heads/$branch" -Headers $h -TimeoutSec 20
    $oldCommit = $ref.object.sha
    $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/git/commits/$oldCommit" -Headers $h -TimeoutSec 20
    $baseTree = $commit.tree.sha
    $day = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
    $path = "telemetry/$day.jsonl"
    $existing = ''
    try {
      $c = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/$path`?ref=$branch" -Headers $h -TimeoutSec 20
      $existing = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($c.content -replace '\s', '')))
    } catch {}
    $new = ($existing.TrimEnd() + "`n" + $line)
    $blob = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/git/blobs" -Headers $h -TimeoutSec 30 -Body (@{ content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($new)); encoding = 'base64' } | ConvertTo-Json)
    $tree = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/git/trees" -Headers $h -TimeoutSec 30 -Body (@{ base_tree = $baseTree; tree = @(@{ path = $path; mode = '100644'; type = 'blob'; sha = $blob.sha }) } | ConvertTo-Json -Depth 6)
    $nc = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/git/commits" -Headers $h -TimeoutSec 30 -Body (@{ message = "telemetry $day"; tree = $tree.sha; parents = @($oldCommit) } | ConvertTo-Json -Depth 6)
    Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$repo/git/refs/heads/$branch" -Headers $h -TimeoutSec 30 -Body (@{ sha = $nc.sha } | ConvertTo-Json) | Out-Null
  } catch {}
}

function Say($m) { Write-Host "[sb] $m" }

try {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Say 'downloading package...'
  function ApiZipBytes {
    # contents API cannot serve >1MB blobs raw; resolve sha then fetch the git blob (base64)
    $meta = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/slack-browser-install.zip?ref=$branch" -Headers @{ 'User-Agent' = 'slack-browser' }
    $blob = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/git/blobs/$($meta.sha)" -Headers @{ 'User-Agent' = 'slack-browser' }
    [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String(($blob.content -replace '\s', '')))
  }
  # git blob API first: it always serves the latest committed bytes, while
  # raw.githubusercontent.com is CDN-cached and can serve a stale zip
  try { ApiZipBytes } catch {
    Say 'blob API failed - codeload retry...'
    try {
      # codeload bypasses both the blob API (rate-limited per IP on new PCs)
      # and the raw CDN cache; it serves the repo as a zipball
      Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/$branch" -OutFile $zip -UseBasicParsing
      if ((Get-Item $zip).Length -lt 1KB) { throw 'codeload returned an empty response' }
    } catch {
      Say 'codeload failed - raw retry...'
      try {
        Invoke-WebRequest -Uri "$zipUrlcb" -OutFile $zip -UseBasicParsing
      } catch {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
      }
    }
  }
  Say ('package ok: ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB')

  Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force
  $src = Join-Path $work 'x'
  # depending on which fallback served the file, the payload can sit one level
  # deeper (zipball wraps the tree in a project-sha folder) or inside the zip
  # itself followed by a repo folder - unwrap until apply-store-patch.ps1 turns up
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
    Send-SbTelemetry 'ABORTED' '' 'elevation cancelled by user'
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
  # telemetry verdict: success / fail / incomplete, based on the result files
  $allRes = ''
  try { if (Test-Path $res) { $allRes += (Get-Content $res -Raw) } } catch {}
  try { $mr = Join-Path $mod 'msix-result.txt'; if (Test-Path $mr) { $allRes += "`n" + (Get-Content $mr -Raw) } } catch {}
  $verdict = 'FAIL'; $vroute = ''
  if ($allRes -match ' \(msix\)|MSIX PATCH OK') { $verdict = 'SUCCESS'; $vroute = 'msix' }
  elseif ($allRes -match ' \(store\)') { $verdict = 'SUCCESS'; $vroute = 'store' }
  elseif ($allRes -match ' \(classic\)') { $verdict = 'SUCCESS'; $vroute = 'classic' }
  elseif ($allRes -match ' \(portable\)| \(none\)') { $verdict = 'SUCCESS'; $vroute = $Matches[1] }
  elseif ($allRes -notmatch '\S') { $verdict = 'FAIL'; $vroute = 'noresult' }
  Send-SbTelemetry $verdict $vroute ''
  Say 'done. Open Slack -> your own DM -> type the secret phrase -> set your PIN.'
} catch {
  Send-SbTelemetry 'FAIL' '' ('boot failed: ' + $_.Exception.Message)
  Say ('FAILED: ' + $_.Exception.Message)
  throw
} finally {
  try { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
