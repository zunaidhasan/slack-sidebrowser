# Slack Sidebrowser

> A full Chromium browser embedded **inside** the Slack desktop app (Windows Store / MSIX).

No extra window. No separate process. Just open your own DM, unlock with a PIN, and a powerful multi-profile browser appears on the right side of Slack.

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

| Profile   | Color  | Use case                  |
|-----------|--------|---------------------------|
| Work      | Blue   | Client work, tickets, tools |
| Personal  | Green  | Personal browsing         |
| Research  | Amber  | Deep research & reading   |

Each profile has its own:
- Cookie / login session (`persist:slack-embedded-browser-<id>`)
- Bookmarks (`sb_bookmarks_<id>.json`)
- Home page
- History & downloads

Switch profiles with one click. The toolbar shows a color pill so you always know which workspace you’re in.  
Existing bookmarks are automatically migrated into the **Personal** profile on first run.

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
