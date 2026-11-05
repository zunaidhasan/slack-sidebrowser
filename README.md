# Slack Sidebrowser

> A full Chromium browser embedded **inside** the Slack desktop app (Windows Store / MSIX).

No extra window. No separate process.  
Just open your own DM, unlock with a PIN, and a powerful multi-profile browser appears on the right side of Slack.

---

## Why this exists

Slack is where work happens, but research, docs, tickets, and tools live in the browser.  
Constantly alt-tabbing kills focus. Slack Sidebrowser keeps everything in one place.

---

## Features

### Core
- **Embedded browser panel** — back / forward / reload / home / multi-tab / DevTools
- **Own-DM gate** — only appears in your personal DM so other conversations stay clean
- **PIN protection** + auto-lock (configurable: off / 10s / 30s / 1m / 5m / 1h)
- **Transparency slider** — see your Slack conversation behind the browser
- **Self-updating** — check for updates from the ⋮ menu
- **Health check and re-patch** — check the last patch result and re-apply it from Settings
- **Re-patch after Slack updates** — rerun the installer; Settings repair is available while Sidebrowser is loaded

### Profiles / Workspaces
Three built-in isolated profiles + unlimited custom ones:

| Profile   | Color  | Use case                    |
|-----------|--------|-----------------------------|
| Work      | Blue   | Client work, tickets, tools |
| Personal  | Green  | Personal browsing           |
| Research  | Amber  | Deep research & reading     |

Each profile has its own:
- Cookie / login session (`persist:slack-embedded-browser-<id>`)
- Bookmarks (`sb_bookmarks_<id>.json`)
- Home page
- History & downloads

Switch profiles with one click. The toolbar shows a color pill so you always know which workspace you’re in.  
Existing bookmarks are automatically migrated into the **Personal** profile on first run.

PIN, phrase, autolock, and transparency remain global — they gate the overlay, not individual website sessions.

### Command Palette (`Ctrl+K` / `Ctrl+Shift+P`)
Fast, fuzzy-search overlay that works across:

1. **Actions**
   - Open in system browser
   - Copy URL
   - Add to Slack message (injects into your own DM composer)
   - New tab
   - Switch profile
2. **Open tabs**
3. **Bookmarks** (current profile)
4. **Recent history** (last ~50 URLs of current profile)

### Browser features
- **Per-profile history and downloads** — the most recent 50 URLs and 80 download records are retained
- **Download progress** in the toolbar, with files saved in the selected profile's download folder
- **EasyList-style ad/tracker blocking** — toggle the built-in network filter from Settings
- **Split view** with a draggable divider and saved Slack/browser ratio
- **Focus mode** to dim the Slack conversation while keeping the browser visible
- **Picture-in-Picture** for supported video elements
- **Optional “Open here” link actions** in your own DM (off by default)
- **Theme matching** for Slack's current appearance
- **First-run onboarding** for profile selection and shortcuts
- **Settings recovery** — health check, repair, and Slack re-patch actions

---

## Install / Update

Download the installer to a local file so you can inspect it before running:

```powershell
$installer = Join-Path $PWD 'install.ps1'
Invoke-WebRequest `
  -Uri 'https://raw.githubusercontent.com/zunaidhasan/slack-sidebrowser/main/install.ps1' `
  -OutFile $installer
Get-FileHash $installer -Algorithm SHA256
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer checks for a running Slack process before downloading. It prompts
for UAC elevation only when patching Slack; do not run the whole PowerShell
session as Administrator. Downloads use PowerShell's configured default proxy.
The patcher also detects classic Win32 Slack under `%LOCALAPPDATA%\slack` and
has portable/classic fallbacks when Store package files cannot be patched.

Pushing a `v*` tag runs the Windows release workflow, which overlays the
tracked source onto the previous release package, validates its contents,
Authenticode-signs the installer and bundled PowerShell scripts, and publishes
the signed installer, package, checksums, and changelog. Configure the GitHub
repository secrets `SIGNING_CERTIFICATE_PFX_BASE64` (base64-encoded
Code-Signing PFX) and `SIGNING_CERTIFICATE_PASSWORD` before tagging a release;
the workflow fails closed if they are missing or signing is invalid. The release
notes come from the `## Unreleased` section of [CHANGELOG.md](./CHANGELOG.md).

This repository does not contain the source build needed to regenerate
`work/app.new.asar`; the prebuilt package is distributed through GitHub Releases
rather than committed to the main branch. The first release workflow run must
therefore be bootstrapped with a known-good prior release package containing
`work/app.new.asar`. The installer verifies the release package checksum before
installing it.

After downloading the installer, package, and checksum file from the same
GitHub Release, verify both files before running the installer:

```powershell
$expected = @{}
Get-Content .\SHA256SUMS.txt | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})\s+\*?(.+)$') { throw "Invalid checksum line: $_" }
  $expected[$Matches[2]] = $Matches[1]
}
foreach ($file in @('install.ps1', 'slack-browser-install.zip')) {
  $actual = (Get-FileHash ".\$file" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected[$file]) { throw "Checksum mismatch: $file" }
}
Write-Host 'Checksums verified.'
```

The installer will:
- Download the latest package
- Refresh the payload in `%USERPROFILE%\.slack-browser` (your PIN, bookmarks, profiles and logs are never touched)
- Run the elevated patcher, check its exit code and require an explicit `PATCH OK` result before reporting success
- Restart Slack through the patcher (UAC prompt once)

Run the same local installer again as the **updater** after any Slack Store update.
If Sidebrowser is still available after a Slack change, Settings also provides a
health check and a re-patch action. Re-patching closes Slack and requires UAC
approval; if a Store update removed Sidebrowser before it could show Settings,
run the local installer again.

---

## How to use

1. Open Slack normally
2. Open your own DM (“Message yourself”)
3. Type the unlock phrase **`enjoy you`** and press Enter → set a PIN
4. The browser panel appears on the right side automatically

**Keyboard shortcuts**
| Shortcut              | Action                  |
|-----------------------|-------------------------|
| `Ctrl+Alt+B`          | Toggle browser panel    |
| `Ctrl+K` / `Ctrl+Shift+P` | Open command palette |
| `Esc`                 | Close palette / lock    |

---

## Uninstall

Close Slack, then run the bundled restoration script from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.slack-browser\uninstall.ps1"
```

Approve the UAC prompt to restore the original Slack files/package. The script
leaves Sidebrowser settings, profiles, and logs in `%USERPROFILE%\.slack-browser`;
remove that folder separately only after confirming the original Slack starts.

---

## Notes

- Logs: `%USERPROFILE%\.slack-browser\sb.log`
- User data: `sb_pin.json`, `sb_ui.json`, and per-profile bookmarks, history,
  downloads, and session folders
- After a Slack Store update, simply re-run the one-line installer
- The patcher supports Store and classic/portable fallbacks, but clean-machine,
  MSIX, and Windows 24H2 compatibility still need release qualification
- The release workflow overlays sources on a prebuilt ASAR; this repository
  cannot independently rebuild that binary payload

---

## Roadmap status

The current source implements profile isolation, command palette, browser
history/download persistence, blocking, split/focus/PiP modes, optional link
actions, theme matching, onboarding, and Settings health/repair. Remaining
release work includes independently rebuilding `app.new.asar`, verifying clean
machine and Windows 24H2/MSIX installs and restores, producing product
screenshots/demo, exercising a clean-machine install, and optionally signing
the release. These environment-dependent checks are not claimed as complete.

Run the local module tests with `npm test` (Node.js 18+). The Electron UI and
Slack patch/restore paths still require a Windows Slack installation for
end-to-end verification.

## License

Licensed under Apache-2.0; see [LICENSE](./LICENSE).

---

## Disclaimer

This is an unofficial personal tool. It is **not** affiliated with, endorsed by, or supported by Slack.  
Use at your own risk. Slack may change its packaging or private APIs at any time.

---

**Made for people who live in Slack.**
