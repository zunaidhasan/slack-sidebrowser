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
- **Survives Slack updates** — one-line re-patch after any Store update

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

### Coming Next
- **Smart side-panel modes**
  - Split view (adjustable ratio between Slack + browser)
  - Picture-in-Picture for video
  - Focus mode (dims everything except the current thread)
- **Context-aware link detection** — “Open here” buttons appear on links in the conversation
- **Download manager + full history** (per profile)
- **Built-in ad & tracker blocker** (EasyList + privacy lists)

---

## Install / Update

Download the installer to a local file so you can inspect it before running:

```powershell
$installer = Join-Path $PWD 'install.ps1'
Invoke-WebRequest `
  -Uri 'https://raw.githubusercontent.com/zunaidhasan/slack-sidebrowser/main/install.ps1' `
  -OutFile $installer `
  -ProxyUseDefaultCredentials
Get-FileHash $installer -Algorithm SHA256
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

The installer checks for a running Slack process before downloading. It prompts
for UAC elevation only when patching Slack; do not run the whole PowerShell
session as Administrator. On a corporate network, `-ProxyUseDefaultCredentials`
uses the current Windows credentials for the configured proxy.
The patcher also detects classic Win32 Slack under `%LOCALAPPDATA%\slack` and
has portable/classic fallbacks when Store package files cannot be patched.

Pushing a `v*` tag runs the release workflow, which checks the package and
publishes the installer, package, and `SHA256SUMS.txt`. It publishes the
checked-in prebuilt package; this repository does not contain the source build
needed to regenerate `work/app.new.asar`. The installer prefers the latest
release asset and falls back to the repository package until a release exists.

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
- Patch your default Store Slack and restart it (UAC prompt once)

Run the same local installer again as the **updater** after any Slack Store update.

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

1. Delete the desktop / taskbar shortcut
2. Delete the folder `%USERPROFILE%\.slack-browser`
3. (Optional) Restore original files from `store\Slack.exe.bak` and `app.asar.bak` if needed

---

## Notes

- Logs: `%USERPROFILE%\.slack-browser\sb.log`
- User data: `sb_pin.json`, `sb_ui.json`, `sb_bookmarks_<id>.json`
- After a Slack Store update, simply re-run the one-line installer
- Built for recent Slack Store builds; the patcher rolls back automatically if Slack fails to start

---

## Roadmap

- [x] Multi-profile isolation (Work / Personal / Research + custom)
- [x] Command palette (`Ctrl+K`)
- [ ] Split view + Focus mode + Picture-in-Picture
- [ ] Context-aware “Open here” on links
- [ ] Per-profile history & download manager
- [ ] Built-in ad/tracker blocking
- [ ] Theme matching (auto dark/light with Slack)

---

## Disclaimer

This is an unofficial personal tool. It is **not** affiliated with, endorsed by, or supported by Slack.  
Use at your own risk. Slack may change its packaging or private APIs at any time.

---

**Made for people who live in Slack.**
