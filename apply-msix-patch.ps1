# Slack Browser - MSIX repackage patcher for kernel-locked Store Slack (Windows 24H2+)
# On patched Windows, registered MSIX package dirs are read-only at kernel level,
# so the classic in-place patch can never write. This script instead:
#   1. downloads the official Slack.msix of the installed Store version
#   2. patches fuse bits in Slack.exe and swaps app.asar with the SB payload
#   3. repacks with the EXACT identity of the installed Store package
#      (same Name + Publisher string - family, Start tile and app data are kept)
#   4. self-signs it and installs it as an upgrade over the Store Slack
# Build phase runs non-elevated; deploy phase re-runs itself elevated once.
# Log: %USERPROFILE%\.slack-browser\msix-result.txt   Success marker: MSIX PATCH OK
param(
  [switch]$DeployPhase,
  [string]$Msix,
  [string]$PfxPath,
  [string]$HomeDir
)
$ErrorActionPreference = 'Stop'

$mod = if ($HomeDir -and (Test-Path "$HomeDir\work\app.new.asar")) { $HomeDir } else { "$env:USERPROFILE\.slack-browser" }
$out = "$mod\msix-result.txt"

function Log($m){ try { Write-Host "[sb-msix] $m" } catch {}; $m | Add-Content $out -Encoding UTF8 }

function Kill-Launch-Verify([string]$m, $p) {
  cmd /c "taskkill /F /IM Slack.exe /T 2>nul" | Out-Null
  Start-Sleep -Seconds 2
  $fam = $p.PackageFamilyName
  Start-Process explorer.exe ('shell:AppsFolder\' + $fam + '!Slack')
  $running = $false
  for ($w = 0; $w -lt 9; $w++) { Start-Sleep -Seconds 10; if (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'") { $running = $true; break } }
  $hasLog = $false
  $logFile = "$m\sb.log"
  if (Test-Path $logFile) {
    $hasLog = ((Get-Item $logFile).LastWriteTime -gt (Get-Date).AddSeconds(-150)) -and ((Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue) -match 'sb_main loaded')
  }
  Log ("already-patched: running=$running loaded=$hasLog")
  if ($running -and $hasLog) { Log 'MSIX PATCH OK' } else { Log 'MSIX PATCH INCOMPLETE' }
}

if ($DeployPhase) {
  # ---------------- elevated deploy ----------------
  try {
    "== sb-msix deploy $(Get-Date) | $(whoami) ==" | Set-Content $out -Encoding UTF8
    if (-not $Msix -or -not (Test-Path $Msix)) { Log 'MISSING msix file'; exit 1 }
    Log 'kill slack'
    cmd /c "taskkill /F /IM Slack.exe /T 2>nul" | Out-Null
    Start-Sleep -Seconds 2
    Log 'trusting repack signer (machine Root + TrustedPeople)'
    $pw = ConvertTo-SecureString -String 'sb' -Force -AsPlainText
    foreach ($store in 'Cert:\LocalMachine\Root','Cert:\LocalMachine\TrustedPeople') {
      try { $c = Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation $store -Password $pw -ErrorAction Stop; Log ("imported " + $store + " -> " + $c.Thumbprint) }
      catch { Log ('import ' + $store + ' failed: ' + $_.Exception.Message) }
    }
    Log 'install (attempt 1: direct upgrade, old package stays)'
    try {
      Add-AppxPackage -Path $Msix -ErrorAction Stop
      Log 'DIRECT UPGRADE OK - data container kept'
    } catch {
      Log ('direct add failed: ' + $_.Exception.Message)
      Log 'removing old store package and retrying'
      $old = Get-AppxPackage -Name '*slack*' -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'slack' } | Select-Object -First 1
      if ($old) {
        Log ('removing ' + $old.PackageFullName)
        try { Remove-AppxPackage -Package $old.PackageFullName -AllUsers -ErrorAction Stop } catch { Log ('remove failed: ' + $_.Exception.Message) }
      }
      try { Add-AppxPackage -Path $Msix -ErrorAction Stop; Log 'reinstall OK' }
      catch { Log ('FINAL install failed: ' + $_.Exception.Message); exit 1 }
    }
    $new = Get-AppxPackage -Name '*slack*' -ErrorAction SilentlyContinue | Select-Object -First 1
    Log ('now installed: ' + $new.PackageFullName)
    Log 'launching default Slack tile'
    $fam = $new.PackageFamilyName
    Start-Process explorer.exe ('shell:AppsFolder\' + $fam + '!Slack')
    $running = $false
    for ($w = 0; $w -lt 9; $w++) { Start-Sleep -Seconds 10; if (Get-CimInstance Win32_Process -Filter "Name='Slack.exe'") { $running = $true; break } }
    Log ('running=' + $running)
    $hasLog = $false
    $logFile = "$mod\sb.log"
    if (Test-Path $logFile) {
      $hasLog = ((Get-Item $logFile).LastWriteTime -gt (Get-Date).AddSeconds(-150)) -and ((Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue) -match 'sb_main loaded')
    }
    Log ('sb_main loaded=' + $hasLog)
    if ($running -and $hasLog) { Log 'MSIX PATCH OK' } else { Log 'MSIX PATCH INCOMPLETE - check the Slack window' }
  } catch {
    Log ('DEPLOY ERROR: ' + $_.Exception.Message)
  }
  exit
}

# ================= build phase (non-elevated) =================
try {
  "=== sb-msix build $(Get-Date) ===" | Set-Content $out -Encoding UTF8
  $base = Join-Path $mod 'work\msix'
  foreach ($d in @($base, "$base\src", "$base\tools")) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null } }

  $pkg = Get-AppxPackage -Name '*slack*' -ErrorAction Stop | Where-Object { $_.Name -match 'slack' } | Select-Object -First 1
  if (-not $pkg) { Log 'no registered Slack package found for repackage'; exit 1 }
  # ALREADY-PATCHED detection: our repack is Developer-signed; the Store one is 'Store'
  if ($pkg.SignatureKind -eq 'Developer') {
    Log 'Slack is already SB-repackaged (Developer-signed) - relaunching and verifying'
    Kill-Launch-Verify $mod $pkg
    exit
  }
  $pkgName = $pkg.Name
  $pubStr  = $pkg.Publisher
  $v = [version]$pkg.Version
  $newVersion = '{0}.{1}.{2}.{3}' -f $v.Major, $v.Minor, $v.Build, ($v.Revision + 1)
  Log ("identity: $pkgName @ $pubStr (installed $($pkg.Version) -> $newVersion)")

  # official Slack.msix for the installed version
  $arch = $(if ($env:PROCESSOR_ARCHITEW6432 -match 'ARM6' -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' })
  $ver3 = "$($v.Major).$($v.Minor).$($v.Build)"
  $msixUrl = "https://downloads.slack-edge.com/desktop-releases/windows/$arch/$ver3/Slack.msix"
  $msixFile = "$base\Slack.$ver3.$arch.msix"
  if (-not (Test-Path $msixFile)) {
    Log ("downloading $msixUrl (~170 MB)")
    Invoke-WebRequest -Uri $msixUrl -OutFile $msixFile -UseBasicParsing
    Log ('downloaded ' + [math]::Round((Get-Item $msixFile).Length / 1MB) + ' MB')
  }

  # SDK tools (makeappx + signtool) from NuGet; cached
  $toolDir = Get-ChildItem "$base\tools\bin" -Recurse -Filter 'makeappx.exe' -ErrorAction SilentlyContinue | Where-Object FullName -match ('\\' + $arch + '\\') | Select-Object -First 1
  if (-not $toolDir) {
    Log 'fetching SDK build tools from NuGet'
    $nupkg = "$base\tools\sdk.nupkg"
    Copy-Item $nupkg "$base\tools\sdk.zip" -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path "$base\tools\sdk.zip")) {
      Invoke-WebRequest -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.26100.1742/microsoft.windows.sdk.buildtools.10.0.26100.1742.nupkg' -OutFile "$base\tools\sdk.zip" -UseBasicParsing
    }
    Expand-Archive "$base\tools\sdk.zip" "$base\tools" -Force
    $toolDir = Get-ChildItem "$base\tools\bin" -Recurse -Filter 'makeappx.exe' | Where-Object FullName -match ('\\' + $arch + '\\') | Select-Object -First 1
  }
  $makeappx = $toolDir.FullName
  $signtool = (Get-ChildItem "$base\tools\bin" -Recurse -Filter 'signtool.exe' | Where-Object FullName -match ('\\' + $arch + '\\') | Select-Object -First 1).FullName
  Log ('tools: ' + $makeappx)

  # extract and patch
  $src = "$base\src"
  Remove-Item "$src\*" -Recurse -Force -ErrorAction SilentlyContinue
  $zcopy = "$base\src-msix.zip"
  Copy-Item $msixFile $zcopy -Force
  Expand-Archive $zcopy $src -Force
  $exe = "$src\app\Slack.exe"
  if (-not (Test-Path $exe)) { Log 'EXE missing in msix extraction'; exit 1 }
  $sentS = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  $CH = 4194304
  $buf = New-Object byte[] ($CH + $sentS.Length)
  $fsIn = [IO.File]::OpenRead($exe)
  $off = -1; $pos = 0; $carry = 0
  while ($true) {
    $n = $fsIn.Read($buf, $carry, $CH); if ($n -le 0) { break }
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
  Log ('sentinel @ ' + $off)
  $fs = [IO.File]::Open($exe, 'Open', 'ReadWrite')
  $b = $off + 34
  $fs.Position = $b + 3; $fs.Write([byte[]]@(0x31), 0, 1)
  $fs.Position = $b + 4; $fs.Write([byte[]]@(0x30), 0, 1)
  $fs.Close()
  Log 'fuse-patched'
  $asar = "$src\app\resources\app.asar"
  Copy-Item "$mod\work\app.new.asar" $asar -Force
  Log ('asar replaced size=' + (Get-Item $asar).Length)

  Remove-Item "$src\AppxBlockMap.xml", "$src\AppxSignature.p7x" -Force -ErrorAction SilentlyContinue
  $mani = [xml](Get-Content "$src\AppxManifest.xml" -Raw)
  $mani.Package.Identity.Name      = $pkgName
  $mani.Package.Identity.Publisher = $pubStr
  $mani.Package.Identity.Version   = $newVersion
  $mani.Save("$src\AppxManifest.xml")
  Log ("manifest -> $pkgName / $pubStr / $newVersion")

  $pOut = "$base\sb-mod.msix"
  if (Test-Path $pOut) { Remove-Item $pOut -Force }
  & $makeappx pack /d $src /p $pOut /o
  if ($LASTEXITCODE -ne 0) { Log "makeappx failed exit=$LASTEXITCODE"; exit 1 }
  Log ('packed ' + [math]::Round((Get-Item $pOut).Length / 1MB) + ' MB')

  $pfx = "$base\sb-repack.pfx"
  if (Test-Path $pfx) { Remove-Item $pfx -Force }
  $cert = New-SelfSignedCertificate -Subject $pubStr -Type Custom -KeyUsage DigitalSignature -KeyExportPolicy Exportable -HashAlgorithm SHA256 -FriendlyName 'slack-browser repack' -CertStoreLocation Cert:\CurrentUser\My
  $pw = ConvertTo-SecureString -String 'sb' -Force -AsPlainText
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
  & $signtool sign /fd SHA256 /f $pfx /p 'sb' $pOut
  if ($LASTEXITCODE -ne 0) { Log "signtool failed exit=$LASTEXITCODE"; exit 1 }
  Log 'signed'

  # deploy elevated (same script, deploy phase)
  $self = Join-Path $mod 'apply-msix-patch.ps1'
  Log 'requesting admin for install - accept the UAC prompt...'
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -DeployPhase -Msix `"$pOut`" -PfxPath `"$pfx`" -HomeDir `"$mod`""
  $res = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
  if ($res -match 'MSIX PATCH OK') { Log 'MSIX PATCH OK (parent confirm)' }
  elseif ($res -match 'MSIX PATCH INCOMPLETE') { Log 'MSIX PATCH INCOMPLETE (parent confirm) - Slack installed, runs, may need one Slack restart' }
  else { Log 'deploy failed (parent confirm) - see msix-result.txt' }
} catch {
  Log ('BUILD ERROR: ' + $_.Exception.Message)
}
