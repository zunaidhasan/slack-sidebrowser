# Slack Browser-in-Slack patcher (Store MSIX + classic version)
# Universal one-command install: handles old and new Store publishers,
# falls back to a portable copy when WindowsApps ACLs cannot be written,
# and finally installs classic Slack when even the Store copy is unreadable
# (ACL-locked machines, fresh PCs without Slack entirely).
param([string]$HomeDir)
$ErrorActionPreference = 'Stop'

# elevated child can run under a different admin account - the invoker passes its
# own profile dir; otherwise scan for an existing .slack-browser with the payload
$mod = $HomeDir
if (-not ($mod -and (Test-Path "$mod\work\app.new.asar"))) {
  $mod = "$env:USERPROFILE\.slack-browser"
}
if (-not (Test-Path "$mod\work\app.new.asar")) {
  $alt = Get-ChildItem 'C:\Users\*\.slack-browser\work\app.new.asar' -Force -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($alt) { $mod = Split-Path (Split-Path $alt.FullName -Parent) -Parent }
}
$out = "$mod\patch-result.txt"
Remove-Item $out -ErrorAction SilentlyContinue
function Log($m){ Write-Host "[sb-patch] $m"; $m | Add-Content $out -Encoding UTF8 }

# kill every Slack.exe and wait until none is left (Slack can respawn or take a
# moment to die - a live Slack.exe file-locks the exe and breaks the patch write)
function Stop-SlackWait([int]$maxSec = 30) {
  for ($i = 0; $i -lt $maxSec; $i += 2) {
    cmd /c "taskkill /F /IM Slack.exe /T 2>nul" | Out-Null
    try { Get-Process -Name Slack -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 2
    $left = @(Get-CimInstance Win32_Process -Filter "Name='Slack.exe'" -ErrorAction SilentlyContinue)
    if (-not $left -or $left.Count -eq 0) { return $true }
  }
  return $false
}
try {
  # 0. copy payload check
  if (-not (Test-Path "$mod\work\app.new.asar")) { Log 'MISSING app.new.asar'; exit 1 }
  foreach ($f in 'sb_main.js','sb_update.cjs','sb_store.cjs','sb_lock.cjs','sb_tabs.cjs','sb_blocker.cjs','sb_search.cjs','sb_easylist.txt','sb_toolbar.html','sb_unlock.html','sb_preload.cjs','sb_toolbar_preload.cjs','sb_content_preload.cjs','sb_onboarding.html') {
    if (-not (Test-Path "$mod\$f")) { Log "MISSING $f"; exit 1 }
  }

  # fast path re-run: SB already integrated (our repack is Developer-signed, Store is 'Store').
  # Only trust it when the msix patcher actually reported success before.
  $pk0 = Get-AppxPackage -Name '*slack*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pk0 -and $pk0.SignatureKind -eq 'Developer' -and (Test-Path "$mod\msix-result.txt") -and ((Get-Content "$mod\msix-result.txt" -Raw) -match 'MSIX PATCH OK')) {
    Log 'Slack already SB-integrated - relaunching and verifying'
    cmd /c "taskkill /F /IM Slack.exe /T 2>nul"
    Start-Sleep -Seconds 2
    Start-Process explorer.exe ('shell:AppsFolder\' + $pk0.PackageFamilyName + '!Slack')
    $running = $false
    for ($w = 0; $w -lt 9; $w++) { Start-Sleep -Seconds 10; if (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'") { $running = $true; break } }
    $hasLog = $false
    if (Test-Path "$mod\sb.log") {
      $hasLog = ((Get-Item "$mod\sb.log").LastWriteTime -gt (Get-Date).AddSeconds(-150)) -and ((Get-Content "$mod\sb.log" -Tail 40 -ErrorAction SilentlyContinue) -match 'sb_main loaded')
    }
    Log ("running=$running loaded=$hasLog")
    if ($running -and $hasLog) { Log 'PATCH OK (msix) - already done, nothing to do' } else { Log 'verify incomplete - check the Slack window' }
    exit 0
  }

  # 1. find Slack package (broad match for any publisher)
  $kind = 'none'
  $exe = $null
  $cand = @()
  try {
    Get-AppxPackage -Name '*slack*' -AllUsers -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'slackdesktop|91750D7E\.Slack' } |
      ForEach-Object { $cand += (Join-Path $_.InstallLocation 'app\Slack.exe') }
  } catch {}
  Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'slack' } |
    ForEach-Object { $cand += (Join-Path $_.FullName 'app\Slack.exe') }
  $cand += (Join-Path $env:LOCALAPPDATA 'slack\slack.exe')
  $cand += (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $_.ExecutablePath })
  $cand = @($cand | Where-Object { $_ -and ($_ -is [string]) })
  # NOTE: on ACL-hardened Windows builds Test-Path inside WindowsApps can throw
  # UnauthorizedAccessException instead of returning $false (even elevated).
  # A throw means the path is *referenceable*, so treat it as existing and let
  # step 3 decide - crashing here skips the whole fallback chain.
  foreach ($c in $cand) {
    if (-not $c) { continue }
    $exists = $false
    try { $exists = (Test-Path -LiteralPath $c) } catch { $exists = $true }
    if ($exists) { $exe = $c; $kind = ($(if ($c -like '*WindowsApps*') { 'store' } else { 'classic' })); break }
  }
  if ($exe) {
    Log "target: $exe ($kind)"
    if ($kind -eq 'store') { $pkgDir = Split-Path $exe }   # app dir of the package; needed for the in-place asar patch
  } else {
    Log 'No existing Slack found - will auto-install classic Slack for you.'
  }

  # 2. stop Slack (skipped when there is nothing to stop)
  Log 'step2 kill'
  $dead = Stop-SlackWait 30
  Log ('step2 done (processes cleared=' + $dead + ')')

  # 3. ownership + write access (multi-attempt for universal one-command install)
  $rw = $false
  $portable = $false
  $storeVer = $null
  $storeFullName = $null
  if ($kind -eq 'store') {
    # remember the Store package full name: if the Store copy turns out to be
    # unpatchable, it gets replaced at the end so there is only ONE default Slack
    $storeFullName = Split-Path (Split-Path $exe) -Leaf
    # remember the Store version: the classic fallback installs the same build,
    # because the payload asar targets one specific Slack version
    if ($exe -match '_v?(\d+(?:\.\d+){2,3})_') { $storeVer = $Matches[1] }
    Log 'step3 perms'
    # takeown / icacls are native tools that report failures on stderr; with
    # $ErrorActionPreference='Stop' the 2>&1 redirect below turns that into a
    # terminating NativeCommandError and kills the whole patcher on ACL-locked
    # machines - run the permission attempts with failure-tolerant semantics
    $eapSave = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # attempt 1: file-level
    $a1 = @()
    foreach ($p in @((Split-Path $exe), $exe, (Join-Path (Split-Path $exe) 'resources\app.asar'))) {
      takeown /F "$p" /A 2>&1 | Out-Null; $tk = $LASTEXITCODE
      icacls "$p" /grant "*S-1-5-32-544:F" 2>&1 | Out-Null; $ic = $LASTEXITCODE
      $a1 += ((Split-Path $p -Leaf) + ':tk=' + $tk + ',ic=' + $ic)
    }
    Log ('attempt1 ' + ($a1 -join ' '))
    try { [IO.File]::Open($exe, 'Open', 'ReadWrite').Close(); $rw = $true } catch {}
    Log ('attempt1 writable=' + $rw)
    # attempt 2: recursive reset + grant on the whole package folder
    if (-not $rw) {
      Log 'file-level failed - resetting ACLs recursively'
      $pkgDirStore = Split-Path (Split-Path $exe)
      takeown /F "$pkgDirStore" /R /A /D Y 2>&1 | Out-Null; $tk = $LASTEXITCODE
      icacls "$pkgDirStore" /reset /T /C /Q 2>&1 | Out-Null; $rs = $LASTEXITCODE
      icacls "$pkgDirStore" /grant "*S-1-5-32-544:F" /T /C /Q 2>&1 | Out-Null; $ic = $LASTEXITCODE
      Log ('attempt2 takeown=' + $tk + ' reset=' + $rs + ' grant=' + $ic)
      try { [IO.File]::Open($exe, 'Open', 'ReadWrite').Close(); $rw = $true } catch {}
      Log ('attempt2 writable=' + $rw)
    }
    # attempt 3: portable copy (no ACL issues at all)
    if (-not $rw) {
      Log 'ACL still denied - switching to portable copy in .slack-browser\SlackApp'
      $portableDir = Join-Path $mod 'SlackApp'
      New-Item -ItemType Directory -Force $portableDir | Out-Null
      if (-not (Test-Path (Join-Path $portableDir 'Slack.exe'))) {
        $exeDir = Split-Path $exe
        Log ('portable copy started: ' + $exeDir)
        Log '   -> this copies thousands of files, takes minutes; the scrolling file list is normal. DO NOT close this window'
        # no redirection: per-file lines scroll so the window visibly progresses
        # and robocopy cannot look stuck; /R:1 /W:1 avoids endless lock retries
        cmd /c "robocopy `"$exeDir`" `"$portableDir`" /E /R:1 /W:1 /NDL /NJH /NP /MT:16"
        $rc = $LASTEXITCODE
        Log ('portable robocopy exit ' + $rc)
      } else {
        Log 'portable copy already present - reuse'
      }
      if (Test-Path (Join-Path $portableDir 'Slack.exe')) {
        $exe = Join-Path $portableDir 'Slack.exe'
        $pkgDir = $portableDir
        $kind = 'portable'
        $portable = $true
        try { [IO.File]::Open($exe, 'Open', 'ReadWrite').Close(); $rw = $true } catch { Log ('portable copy not writable: ' + $_.Exception.Message) }
      } else {
        Log 'portable copy failed - Store app dir is unreadable on this machine; trying classic Slack...'
        $kind = 'none'
      }
    }
    # restore strict error handling before the write probes
    try { $ErrorActionPreference = $eapSave } catch {}
    Log 'step3 done-store'
    # attempt 4: repackage the official MSIX with the installed Store identity -
    # the only route that works when the kernel locks registered packages (24H2+)
    $msixScript = Join-Path $mod 'apply-msix-patch.ps1'
    if (Test-Path $msixScript) {
      try { & $msixScript -HomeDir $mod } catch { Log ('msix attempt threw: ' + $_.Exception.Message) }
      if ((Test-Path "$mod\msix-result.txt") -and ((Get-Content "$mod\msix-result.txt" -Raw) -match 'MSIX PATCH OK')) {
        Log 'PATCH OK (msix) - SB integrated into your default Slack, shortcut and login kept'
        exit 0
      }
    }
  }

  # 4. classic Slack fallback / fresh-install fallback
  if (-not $rw) {
    if ($kind -eq 'classic') {
    # resolve the real Electron exe before anything else: the root slack.exe is
    # usually just a Squirrel launcher stub, the real target lives in app-<ver>\
    $root = Split-Path $exe
    $newest = Get-ChildItem $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($newest -and (Test-Path (Join-Path $newest.FullName 'Slack.exe'))) {
      $exe = Join-Path $newest.FullName 'Slack.exe'
      Log ('   resolved real exe: ' + $exe)
    }
    $pkgDir = Split-Path $exe
    $rw = $true
    Log 'step4 classic reuse'
  }
  else {
      $ver = '4.53.276'   # payload asar is built for this version
      if ($storeVer) { $ver = ($storeVer -replace '\.0$', '') }
      $setup = Join-Path $mod 'work\SlackSetup.exe'
      $url = "https://downloads.slack-edge.com/desktop-releases/windows/x64/$ver/SlackSetup.exe"
      Log "step4 classic Slack $ver"
      Log "   downloading $url"
      try {
        Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing -ErrorAction Stop
      } catch { Log ('classic download failed: ' + $_.Exception.Message); exit 1 }
      Log ('   downloaded ' + [math]::Round((Get-Item $setup).Length / 1MB) + ' MB - installing silently, this takes a couple of minutes...')
      cmd /c "taskkill /F /IM Slack.exe /T 2>nul"
      try {
        Start-Process -FilePath $setup -ArgumentList '--silent' -Wait -ErrorAction Stop
      } catch { Log ('classic installer failed: ' + $_.Exception.Message); exit 1 }
      Start-Sleep -Seconds 10
      cmd /c "taskkill /F /IM Slack.exe /T 2>nul"
      # resolve install: prefer the real Electron exe inside app-<ver>, not the root stub
      $classicRoot = Join-Path $env:LOCALAPPDATA 'slack'
      if (-not (Test-Path $classicRoot)) {
        $alt = Get-ChildItem 'C:\Users\*\AppData\Local\slack' -Directory -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($alt) { $classicRoot = $alt.FullName; Log ('   classic install found under: ' + $classicRoot) }
      }
      $classicExe = $null
      foreach ($ad in @(Get-ChildItem $classicRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
        $cc = Join-Path $ad.FullName 'Slack.exe'
        if (Test-Path $cc) { $classicExe = $cc; break }
      }
      if (-not $classicExe) {
        $cc = Join-Path $classicRoot 'slack.exe'
        if ((Test-Path $cc) -and -not ($cc -match 'app-')) {
          Log '   root slack.exe looks like a launcher stub - the real exe is inside app-<ver>; if none exists the install failed'
        }
        if (Test-Path $cc) { $classicExe = $cc }
      }
      if (-not $classicExe) { Log ('classic install did not produce an exe under ' + $classicRoot + ' - giving up'); exit 1 }
      # never patch the stub: walk from root to the newest app-<ver>\Slack.exe
      if ($classicExe -notmatch 'app-') {
        $newest = Get-ChildItem $classicRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if ($newest -and (Test-Path (Join-Path $newest.FullName 'Slack.exe'))) { $classicExe = Join-Path $newest.FullName 'Slack.exe' }
      }
      $exe = $classicExe
      $pkgDir = Split-Path $exe
      $kind = 'classic'
      Log ('   classic exe: ' + $exe)
      $rw = $true
      $portable = $false
    }
  }

  $asar = Join-Path $pkgDir 'resources\app.asar'
  if (-not $rw) { Log 'write access failed - giving up'; exit 1 }
  Log 'step3 done'

  # 5. backups (once; per target kind so Store and Classic never swap into each other)
  $bakTag = $(if ($kind -eq 'classic') { 'classic' } else { 'store' })
  $bakExe = "$mod\store\Slack.exe.$bakTag.bak"
  $asarBak = "$mod\store\app.asar.$bakTag.bak"
  New-Item -ItemType Directory -Force "$mod\store" | Out-Null
  if (-not (Test-Path $bakExe))  { Copy-Item $exe $bakExe -Force }
  if (-not (Test-Path $asarBak)) { Copy-Item $asar $asarBak -Force }
  # keep the legacy app.asar.bak for older updater scripts
  if (-not (Test-Path "$mod\app.asar.bak")) { Copy-Item $asar "$mod\app.asar.bak" -Force }

  # 6. locate fuse sentinel and flip fuses (NodeInspect on, EmbeddedAsarIntegrity off)
  Log 'step5 fuse scan'
  $sentS = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  $off = -1
  $CH = 4194304
  $buf = New-Object byte[] ($CH + $sentS.Length)
  $fsIn = [IO.File]::OpenRead($exe)
  $pos = 0; $carry = 0
  while ($true) {
    $n = $fsIn.Read($buf, $carry, $CH)
    if ($n -le 0) { break }
    $total = $n + $carry
    $s = [Text.Encoding]::ASCII.GetString($buf, 0, $total)
    $idx = $s.IndexOf($sentS, [StringComparison]::Ordinal)
    if ($idx -ge 0) { $off = $pos - $carry + $idx; break }
    $pos += $n
    for ($k = 0; $k -lt $sentS.Length; $k++) { $buf[$k] = $buf[$total - $sentS.Length + $k] }
    $carry = $sentS.Length
    if ($pos -gt 420000000) { break }
  }
  $fsIn.Close()
  if ($off -lt 0) { Log 'SENTINEL NOT FOUND'; exit 1 }
  Log ("sentinel @ " + $off)
  # Slack.exe may have respawned since step2 (autostart / update helper) - a live
  # process holds the exe locked. Re-kill and retry the open before giving up.
  $fs = $null
  for ($try = 1; $try -le 5; $try++) {
    try { $fs = [IO.File]::Open($exe, 'Open', 'ReadWrite'); break }
    catch {
      Log ("exe locked (try " + $try + ") - killing Slack again: " + $_.Exception.Message)
      Stop-SlackWait 30 | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  if (-not $fs) { Log 'exe still locked after retries - close Slack manually and re-run the command'; exit 1 }
  $base = $off + 34
  $fs.Position = $base + 3; $fs.Write([byte[]]@(0x31), 0, 1)
  $fs.Position = $base + 4; $fs.Write([byte[]]@(0x30), 0, 1)
  $fs.Close()
  Log 'fuse-patched'

  # 7. replace asar (retry with re-kill: a respawned Slack can lock app.asar too)
  $asarOk = $false
  for ($try = 1; $try -le 5 -and -not $asarOk; $try++) {
    try {
      Copy-Item "$mod\work\app.new.asar" $asar -Force -ErrorAction Stop
      $asarOk = $true
    } catch {
      Log ("asar copy failed (try " + $try + "): " + $_.Exception.Message)
      Stop-SlackWait 30 | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  if (-not $asarOk) { Log 'asar could not be replaced after retries - close Slack manually and re-run'; exit 1 }
  Log ("asar replaced size=" + (Get-Item $asar).Length)

  # 8. launch + verify - portable and classic launch the exe directly
  $ok = $false
  if ($portable -or ($kind -eq 'classic')) {
    cmd /c "taskkill /F /IM Slack.exe /T 2>nul"
    Start-Sleep -Seconds 2
    Start-Process $exe
    for ($w = 0; $w -lt 6; $w++) {
      Start-Sleep -Seconds 10
      if (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'") { break }
    }
    $running = [bool](Get-CimInstance Win32_Process -Filter "Name='Slack.exe'")
    $logFile = "$mod\sb.log"
    $hasLog = $false
    if (Test-Path $logFile) {
      $hasLog = ((Get-Item $logFile).LastWriteTime -gt (Get-Date).AddSeconds(-120)) -and ((Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue) -match 'sb_main loaded')
    }
    Log ("direct running=" + $running + " loaded=" + $hasLog)
    if ($running -and $hasLog) { $ok = $true }
  } else {
    $pkgName = Split-Path (Split-Path $exe) -Leaf
    $fam = $null
    if ($pkgName -match '^(.+)_\d+(\.\d+){3}_(x64|arm64|neutral)__(.+)$') { $fam = ($Matches[1] + '_' + $Matches[4]) }
    if (-not $fam) { $fam = 'com.tinyspeck.slackdesktop_8yrtsj140pw4g' }
    $appId = 'shell:AppsFolder\' + $fam + '!Slack'
    for ($try = 1; $try -le 3; $try++) {
      Start-Process explorer.exe $appId
      for ($w = 0; $w -lt 6; $w++) {
        Start-Sleep -Seconds 10
        if (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'") { break }
      }
      $running = [bool](Get-CimInstance Win32_Process -Filter "Name='Slack.exe'")
      $logFile = "$mod\sb.log"
      $hasLog = $false
      if (Test-Path $logFile) {
        $hasLog = ((Get-Item $logFile).LastWriteTime -gt (Get-Date).AddSeconds(-120)) -and ((Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue) -match 'sb_main loaded')
      }
      Log ("try" + $try + " running=" + $running + " loaded=" + $hasLog)
      if ($running -and $hasLog) { $ok = $true; break }
    }
  }
  if (-not $ok) {
    Log 'ROLLBACK'
    Copy-Item $bakExe $exe -Force
    Copy-Item $asarBak $asar -Force
  } else {
    Log ("PATCH OK ($kind)")
    # replace the default: if the Store package is still there while the patched
    # Slack is the classic one, remove the Store package so Start Menu has exactly
    # ONE "Slack" shortcut that opens the patched client
    if ($kind -eq 'classic' -and $storeFullName) {
      Log 'step9 replace default: removing the unpatchable Store Slack package'
      cmd /c "taskkill /F /IM Slack.exe /T 2>nul"
      Start-Sleep -Seconds 2
      try {
        $all = @(Get-AppxPackage -Name '*slack*' -AllUsers -ErrorAction Stop)
        $rp = $all | Where-Object { $_.PackageFullName -eq $storeFullName } | Select-Object -First 1
        if (-not $rp) { $rp = $all | Select-Object -First 1 }
        if ($rp) {
          Remove-AppxPackage -Package $rp.PackageFullName -AllUsers -ErrorAction Stop
          Log ('store package removed: ' + $rp.PackageFullName)
          Log 'the single default "Slack" shortcut now opens the patched desktop client (first run may ask to log in again)'
        } else {
          Log 'store package already gone - nothing to remove'
        }
      } catch {
        Log ('store removal failed (both copies remain; uninstall the Store one from Settings if you see two): ' + $_.Exception.Message)
      }
    }
  }
} catch {
  $ln = $_.InvocationInfo.ScriptLineNumber
  Log ('ERROR line ' + $ln + ': ' + $_.Exception.Message + ' | ' + $_.InvocationInfo.Line.Trim())
}
