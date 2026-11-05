'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const e = require('electron');
const { app, BrowserWindow, ipcMain, globalShortcut, session, screen, shell, clipboard } = e;

const MOD_DIR = __dirname;
function createFallbackTabRegistry() {
  let tabs = [];
  let activeId = null;
  let nextId = 0;
  return {
    all: function () { return tabs.slice(); },
    activeId: function () { return activeId; },
    setActive: function (id) { activeId = id && tabs.some((tab) => tab.id === id) ? id : null; return activeId; },
    find: function (id) { return tabs.find((tab) => tab.id === id) || null; },
    add: function (tab) { if (!tab || !tab.id || tabs.some((item) => item.id === tab.id)) return false; tabs.push(tab); return true; },
    remove: function (id) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return null;
      const result = { tab: tabs[index], index: index };
      tabs.splice(index, 1);
      if (activeId === id) activeId = null;
      return result;
    },
    clear: function () { tabs = []; activeId = null; },
    nextId: function () { return 't' + (++nextId); },
  };
}
let tabRegistry;
let tabRegistryLoadError = null;
try { tabRegistry = require(path.join(MOD_DIR, 'sb_tabs.cjs')).createRegistry(); }
catch (err) { tabRegistry = createFallbackTabRegistry(); tabRegistryLoadError = err; }
const TOOLBAR_H = 72;
const SLACK_TOP_H = 52;   // Slack's top nav/search bar height; keep browser below it
let toolbarH = TOOLBAR_H;
const ACCEL = 'Control+Alt+B';
const DEFAULT_HOME = 'https://duckduckgo.com/';
const DEFAULT_PHRASE = 'enjoy you';
const LOG = path.join(MOD_DIR, 'sb.log');
const REPAIR_FILES = [
  'apply-store-patch.ps1', 'apply-msix-patch.ps1', 'sb_main.js', 'sb_update.cjs',
  'sb_store.cjs', 'sb_lock.cjs', 'sb_tabs.cjs', 'sb_blocker.cjs', 'sb_search.cjs', 'sb_easylist.txt',
  'sb_preload.cjs', 'sb_content_preload.cjs', 'sb_toolbar.html',
  'sb_toolbar_preload.cjs', 'sb_unlock.html', 'sb_settings.html', 'sb_phrase.html',
  'sb_onboarding.html',
  'work/app.new.asar',
];

try {
  fs.appendFileSync(LOG, '[import] start electron=' + process.versions.electron + ' pid=' + process.pid + '\n');
} catch (_iErr) {}

const LOG_MAX = 2 * 1024 * 1024;  // sb.log is append-only while Slack runs; keep it bounded
function log(...args) {
  try {
    try {
      if (fs.statSync(LOG).size > LOG_MAX) {
        try { fs.unlinkSync(LOG + '.1'); } catch (_old) {}
        fs.renameSync(LOG, LOG + '.1');
      }
      if (tabRegistryLoadError) log('tab registry module missing; using compatibility fallback', String(tabRegistryLoadError && tabRegistryLoadError.message));
    } catch (_rot) {}
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + args.join(' ') + '\n');
  } catch (_) {}
}

try {
  process.on('uncaughtException', (err) => { log('UNCAUGHT', err && (err.stack || err)); });
  process.on('unhandledRejection', (err) => { log('REJECTION', err && (err.stack || String(err))); });
} catch (_) {}

// ---- userData: if the launcher provided --user-data-dir, respect it; otherwise use the
// real Slack profile dir.
try {
  const usesFlag = process.argv.some((a) => String(a).startsWith('--user-data-dir'));
  if (!usesFlag) {
    const defaultData = path.join(app.getPath('appData'), 'Slack');
    const fixUserData = () => {
      try { app.setPath('userData', defaultData); } catch (_) {}
    };
    process.nextTick(fixUserData);
    app.on('ready', () => { setTimeout(fixUserData, 0); });
  }
} catch (_) {}

// ---- state
const S = {
  shown: false,
  toolbar: null,
  parent: null,
  url: '',
  ipcBound: false,
  opacity: 100,   // browser transparency, 20..100, persisted in sb_ui.json
  autolockMin: 30, // auto-lock seconds after leaving own DM / minimize, 0 = off; sb_ui.json
  paletteOpen: false,
  splitRatio: 0.5,
  panelMode: 'overlay',
  contextLinks: false,
  theme: null,
  focusMode: false,
};
let settingsWin = null;
function openSettingsWindow() {
  try {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    const wb = (S.parent && !S.parent.isDestroyed()) ? S.parent.getBounds() : { x: 100, y: 100, width: 900, height: 700 };
    const w = new BrowserWindow({
      width: 300, height: 620,
      x: Math.max(0, wb.x + wb.width - 310),
      y: Math.max(0, wb.y + 60),
      frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false,
        preload: path.join(MOD_DIR, 'sb_toolbar_preload.cjs') },
    });
    settingsWin = w;
    w.loadFile(path.join(MOD_DIR, 'sb_settings.html')).catch((err) => { log('settings load err', String(err && err.message)); });
    w.webContents.once('did-finish-load', () => {
      if (S.theme && !w.isDestroyed()) w.webContents.send('sb-theme', S.theme);
    });
    // defer blur-close to avoid a close-during-creation race
    setTimeout(() => {
      try {
        if (!w || w.isDestroyed()) return;
        w.on('blur', () => { try { if (w && !w.isDestroyed()) w.close(); } catch (_) {} });
      } catch (_) {}
    }, 400);
    w.on('closed', () => { settingsWin = null; });
    log('settings window opened');
  } catch (err) {
    settingsWin = null;
    log('settings window err', String(err && (err.stack || err.message)));
  }
}

// ---- user data store (bookmarks + UI prefs); optional, so a missing file can
// never stop Slack from booting
let store = null;
function getStore() {
  if (store) return store;
  try { store = require(path.join(MOD_DIR, 'sb_store.cjs')); return store; }
  catch (err) { log('store module missing, using inline fallback: ' + String(err && err.message)); }
  // inline fallback so UI prefs / bookmarks still persist when sb_store.cjs is absent
  const fs = require('fs'); const p = require('path');
  function readJSON(f, fb) { try { return JSON.parse(fs.readFileSync(p.join(MOD_DIR, f), 'utf8')); } catch (_) { return fb; } }
  function writeJSON(f, v) { try { fs.writeFileSync(p.join(MOD_DIR, f), JSON.stringify(v), 'utf8'); return true; } catch (_) { return false; } }
  function norm(u) { return String(u || '').toLowerCase().replace(/\/+$/, ''); }
  const MAXB = 60;
  const shim = {
    listBookmarks() {
      const v = readJSON('sb_bookmarks.json', []);
      return Array.isArray(v) ? v.filter((b) => b && typeof b.url === 'string' && b.url) : [];
    },
    addBookmark(url, title) {
      url = String(url || '').trim();
      if (!url) return { list: this.listBookmarks(), added: false };
      const all = this.listBookmarks();
      const key = norm(url);
      const idx = all.findIndex((b) => norm(b.url) === key);
      const clean = String(title || '').trim().slice(0, 80) || url;
      if (idx >= 0) { all[idx].title = clean; writeJSON('sb_bookmarks.json', all); return { list: all, added: false, existed: true }; }
      all.unshift({ url: url, title: clean, added: new Date().toISOString() });
      while (all.length > MAXB) all.pop();
      writeJSON('sb_bookmarks.json', all);
      return { list: all, added: true };
    },
    removeBookmark(url) {
      const key = norm(url);
      const all = this.listBookmarks();
      const next = all.filter((b) => norm(b.url) !== key);
      writeJSON('sb_bookmarks.json', next);
      return next;
    },
    getUI() {
      const v = readJSON('sb_ui.json', {});
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    },
    setUI(patch) {
      const v = Object.assign(this.getUI(), (patch && typeof patch === 'object') ? patch : {});
      writeJSON('sb_ui.json', v);
      return v;
    },
  };
  store = shim;
  return store;
}

function activeProfileId() {
  const st = getStore();
  try { return (st && st.getActiveProfileId) ? st.getActiveProfileId() : 'personal'; } catch (_) { return 'personal'; }
}

function activeHome() {
  const st = getStore();
  try {
    const p = st && st.getProfile ? st.getProfile(activeProfileId()) : null;
    return (p && p.home) || DEFAULT_HOME;
  } catch (_) { return DEFAULT_HOME; }
}

function activePartition() {
  const st = getStore();
  try { return (st && st.partitionFor) ? st.partitionFor(activeProfileId()) : 'persist:slack-embedded-browser-personal'; } catch (_) {
    return 'persist:slack-embedded-browser-personal';
  }
}

function activeProfile() {
  const st = getStore();
  try { return st && st.getProfile ? st.getProfile(activeProfileId()) : { id: 'personal', name: 'Personal', color: '#3ddc97', home: DEFAULT_HOME }; } catch (_) {
    return { id: 'personal', name: 'Personal', color: '#3ddc97', home: DEFAULT_HOME };
  }
}

let blockerMod = null;
function getBlocker() {
  if (blockerMod) return blockerMod;
  try {
    blockerMod = require(path.join(MOD_DIR, 'sb_blocker.cjs'));
    blockerMod.loadList(path.join(MOD_DIR, 'sb_easylist.txt'));
    const st = getStore();
    const on = st && st.getUI ? st.getUI().blocker : undefined;
    blockerMod.setEnabled(on !== false);
  } catch (err) { log('blocker unavailable', String(err && err.message)); }
  return blockerMod;
}

let searchMod = null;
function getSearch() {
  if (searchMod) return searchMod;
  try { searchMod = require(path.join(MOD_DIR, 'sb_search.cjs')); } catch (_) {}
  return searchMod;
}

// ---- transparency. WebContentsView has no setOpacity (electron/electron#45104),
// so the fallback is CSS opacity on each document, re-applied after navigation.
// ---- transparency. We keep the page TEXT at full opacity and only make the
// page's own background transparent, so the Slack DM behind the browser shows
// through (a glass effect) while the browser content stays readable.
function makeViewTransparent(view) {
  try { if (view && typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#00000000'); } catch (_) {}
  try { if (view && view.webContents && typeof view.webContents.setBackgroundColor === 'function') view.webContents.setBackgroundColor('#00000000'); } catch (_) {}
}
function applyViewOpacity(view, op) {
  if (!view) return;
  try {
    if (typeof view.setOpacity === 'function') { view.setOpacity(op); return; }  // BrowserView path
  } catch (_) {}
  try {
    const cw = view.webContents;
    if (cw && !cw.isDestroyed()) {
      const js = '(function(){try{var d=document,e=d.getElementById("sb-trans");var need=' + (op < 0.999) + ';'
        + 'if(need && !e){e=d.createElement("style");e.id="sb-trans";e.textContent="html,body{background:transparent!important;background-color:transparent!important}";d.documentElement.appendChild(e);}'
        + 'else if(!need && e){e.remove();}'
        + 'd.documentElement.style.opacity=need?String(' + op + '):"";}catch(_){}})()';
      cw.executeJavaScript(js, true).catch(() => {});
    }
  } catch (_) {}
}

function transparencyOp() {
  const v = Number(S.opacity);
  return Math.max(0.2, Math.min(1, isFinite(v) ? v / 100 : 1));
}

function applyTransparency() {
  const op = transparencyOp();
  applyViewOpacity(S.toolbar, op);
  for (const t of tabRegistry.all()) applyViewOpacity(t.view, op);
}

const hasWCV = () => typeof e.WebContentsView === 'function';

function createView(prefs) {
  let v;
  if (hasWCV()) v = new e.WebContentsView({ webPreferences: prefs, backgroundColor: '#00000000' });
  else v = new e.BrowserView({ webPreferences: prefs, backgroundColor: '#00000000' });
  makeViewTransparent(v);
  return v;
}

function attachView(win, view) {
  if (!win || !view) return;
  if (win.isDestroyed()) return;
  if (hasWCV()) {
    if (!win.contentView.children.includes(view)) win.contentView.addChildView(view);
  } else {
    try { win.removeBrowserView(view); } catch (_) {}
    win.addBrowserView(view);
  }
}

function detachView(win, view) {
  if (!win || !view || win.isDestroyed()) return;
  try {
    if (hasWCV()) win.contentView.removeChildView(view);
    else win.removeBrowserView(view);
  } catch (_) {}
}

function setBounds(view, rect) {
  try { view.setBounds(rect); } catch (_) {}
}

// ---- header stripping for our partition only
function setupSession(part) {
  if (!part) return;
  // createTab() calls this for every tab; without the guard each tab stacked another
  // onHeadersReceived handler on the same session.
  if (part.__sbConfigured) return;
  part.__sbConfigured = true;
  const profileId = activeProfileId();
  part.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
    const h = details.responseHeaders;
    if (h) {
      for (const k of Object.keys(h)) {
        if (/^x-frame-options$/i.test(k)) delete h[k];
        else if (/^content-security-policy$/i.test(k)) delete h[k];
        else if (/^content-security-policy-report-only$/i.test(k)) delete h[k];
        else if (/^cross-origin-opener-policy$/i.test(k)) delete h[k];
        else if (/^cross-origin-embedder-policy$/i.test(k)) delete h[k];
      }
    }
    cb({ responseHeaders: h });
  });
  // make UA look like plain Chrome (some sites reject Slack/Electron UAs)
  try {
    const ua = part.getUserAgent() || '';
    part.setUserAgent(
      ua.replace(/\s*Slack_SSB\/[\d.]+/gi, '')
        .replace(/\s*Slack\/[\d.]+/gi, '')
        .replace(/\s*Electron\/[\d.]+/gi, '')
    );
  } catch (_) {}
  try {
    const blk = getBlocker();
    if (blk) {
      part.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        try {
          if (blk.shouldBlock(details.url)) return cb({ cancel: true });
        } catch (_) {}
        cb({});
      });
    }
  } catch (err) { log('blocker bind err', String(err && err.message)); }
  try {
    part.on('will-download', (_e, item) => {
      try {
        const directory = path.join(app.getPath('downloads'), 'Slack Sidebrowser', profileId);
        fs.mkdirSync(directory, { recursive: true });
        const suggested = path.basename(item.getFilename()).replace(/[<>:"|?*]/g, '_') || 'download';
        const extension = path.extname(suggested);
        const stem = suggested.slice(0, suggested.length - extension.length);
        let destination = path.join(directory, suggested);
        let suffix = 2;
        while (fs.existsSync(destination)) {
          destination = path.join(directory, stem + ' (' + suffix++ + ')' + extension);
        }
        item.setSavePath(destination);
        const rec = {
          id: 'dl' + Date.now() + Math.floor(Math.random() * 999),
          url: item.getURL(),
          filename: path.basename(destination),
          state: 'progressing',
          bytes: 0,
          total: item.getTotalBytes() || 0,
          path: destination,
        };
        const st = getStore();
        if (st && st.addDownload) st.addDownload(rec, profileId);
        item.on('updated', (_ev, state) => {
          try {
            if (st && st.updateDownload) st.updateDownload(rec.id, { state: state, bytes: item.getReceivedBytes(), total: item.getTotalBytes() }, profileId);
            sendToolbar('sb-download-progress', { id: rec.id, state: state, bytes: item.getReceivedBytes(), total: item.getTotalBytes() });
          } catch (err) { log('download progress err', String(err && err.message)); }
        });
        item.once('done', (_ev, state) => {
          try {
            if (st && st.updateDownload) st.updateDownload(rec.id, { state: state, bytes: item.getReceivedBytes(), path: item.getSavePath() }, profileId);
            sendStatus(state === 'completed' ? ('downloaded ' + rec.filename) : ('download ' + state), state === 'completed' ? 'ok' : 'err');
          } catch (err) { log('download completion err', String(err && err.message)); }
        });
      } catch (err) { log('download err', String(err && err.message)); }
    });
  } catch (err) { log('download bind err', String(err && err.message)); }
}

// ---- toolbar/status channel
function pushUpdate() {
  const tw = S.toolbar && S.toolbar.webContents;
  if (!tw || tw.isDestroyed()) return;
  const active = getActiveTab();
  let u = '';
  let loading = false;
  try {
    const cw = active && active.view && active.view.webContents;
    if (cw) { u = cw.getURL(); loading = cw.isLoading(); }
  } catch (_) {}
  const tabs = tabRegistry.all().map((t) => ({ id: t.id, title: t.title || t.url, url: t.url, active: t.id === tabRegistry.activeId() }));
  const p = activeProfile();
  const health = checkSidebrowserHealth();
  tw.send('sb-update', {
    url: u, loading, tabs, activeTabId: tabRegistry.activeId(),
    profile: { id: p.id, name: p.name, color: p.color, home: p.home },
    profiles: (function () { try { return getStore().listProfiles(); } catch (_) { return []; } })(),
    blocker: (function () { const b = getBlocker(); return b ? b.isEnabled() : false; })(),
    mode: S.panelMode,
    splitRatio: S.splitRatio,
    versionWarning: health && /differs from the last patch target/.test(health.text) ? health.text : '',
  });
}

function normalize(u) {
  u = String(u || '').trim();
  if (!u) return activeHome();
  if (/^(https?|file):/i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)) return 'https://' + u;
  // treat as search
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(u);
}

function getActiveTab() {
  return tabRegistry.find(tabRegistry.activeId()) || tabRegistry.all()[0] || null;
}

function activeWC() {
  const t = getActiveTab();
  return (t && t.view && t.view.webContents) || null;
}

function recordHistory(url, title) {
  try {
    const st = getStore();
    if (st && st.addHistory) st.addHistory(url, title, activeProfileId());
  } catch (_) {}
}

function createTab(url, switchTo) {
  if (switchTo === undefined) switchTo = true;
  const part = session.fromPartition(activePartition());
  setupSession(part);
  const view = createView({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    preload: path.join(MOD_DIR, 'sb_content_preload.cjs'),
    session: part,
  });
  const tab = { id: tabRegistry.nextId(), view, url: normalize(url || activeHome()), title: '' };
  const cw = view.webContents;
  // mouse-wheel + keyboard zoom (independent of page JS)
  cw.on('input-event', (_ev, ie) => {
    try {
      const _mods = Array.isArray(ie.modifiers) ? ie.modifiers : [];
      const _ctrl = !!(ie.control || ie.controlKey || _mods.indexOf('control') >= 0 || _mods.indexOf('ctrl') >= 0);
      const _meta = !!(ie.meta || ie.metaKey || _mods.indexOf('meta') >= 0 || _mods.indexOf('command') >= 0);
      if (ie.type === 'mouseWheel' && (_ctrl || _meta)) {
        // Wheel zoom is owned by sb_content_preload.cjs (it turns the wheel into
        // sb-zoom). Calling preventDefault() here would swallow the event before the
        // renderer sees it, so Ctrl+wheel would stop zooming altogether.
      } else if (ie.type === 'keyDown' && (_ctrl || _meta)) {
        if (ie.key === '+' || ie.key === '=' || ie.key === 'Add') { _ev.preventDefault(); cw.setZoomFactor(Math.min(3, cw.getZoomFactor() * 1.1)); }
        else if (ie.key === '-' || ie.key === 'Subtract') { _ev.preventDefault(); cw.setZoomFactor(Math.max(0.25, cw.getZoomFactor() / 1.1)); }
        else if (ie.key === '0') { _ev.preventDefault(); cw.setZoomFactor(1); }
      }
    } catch (_) {}
  });
  cw.on('did-navigate', (_e, u) => { tab.url = u || tab.url; if (tab.id === tabRegistry.activeId()) S.url = tab.url; recordHistory(tab.url, tab.title); pushUpdate(); });
  cw.on('did-navigate-in-page', () => { tab.url = cw.getURL(); if (tab.id === tabRegistry.activeId()) S.url = tab.url; pushUpdate(); });
  cw.on('did-start-loading', () => pushUpdate());
  cw.on('did-stop-loading', () => { recordHistory(tab.url, tab.title); pushUpdate(); });
  cw.on('page-title-updated', (_e, t) => { tab.title = t || tab.title; pushUpdate(); });
  cw.on('did-fail-load', (_ev, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log('page load failed', code, description, validatedURL);
    if (tab.id === tabRegistry.activeId()) sendStatus('page failed to load: ' + String(description || code).slice(0, 80), 'err');
  });
  cw.on('did-finish-load', () => applyViewOpacity(view, transparencyOp()));
  tabRegistry.add(tab);
  applyViewOpacity(view, transparencyOp());
  try {
    cw.on('before-input-event', (_e, input) => {
      const key = String(input.key).toLowerCase();
      const command = input.control || input.meta;
      if (input.type === 'keyDown' && command && (key === 'k' || (key === 'p' && input.shift))) {
        _e.preventDefault();
        setPaletteOpen(!S.paletteOpen);
      }
    });
  } catch (_) {}
  try { cw.loadURL(tab.url).catch(() => {}); } catch (_) {}
  if (switchTo) switchTab(tab.id);
  else pushUpdate();
  return tab;
}

function switchTab(id) {
  const tab = tabRegistry.find(id);
  if (!tab) return;
  const prev = getActiveTab();
  if (prev && prev.id !== id && S.shown && S.parent && !S.parent.isDestroyed()) {
    try { detachView(S.parent, prev.view); } catch (_) {}
  }
  tabRegistry.setActive(id);
  S.url = tab.url;
  if (S.shown && S.parent && !S.parent.isDestroyed()) {
    attachView(S.parent, tab.view);
    layout();
    try { tab.view.webContents.focus(); } catch (_) {}
    // keep the toolbar above the (new) content view in z-order
    if (S.toolbar) { detachView(S.parent, S.toolbar); attachView(S.parent, S.toolbar); }
  }
  pushUpdate();
}

function closeTab(id) {
  const activeId = tabRegistry.activeId();
  const removed = tabRegistry.remove(id);
  if (!removed) return;
  const idx = removed.index;
  const tab = removed.tab;
  const wasActive = id === activeId;
  if (S.shown && S.parent && !S.parent.isDestroyed()) {
    try { detachView(S.parent, tab.view); } catch (_) {}
  }
  try { tab.view.webContents.destroy(); } catch (_) {}
  if (!tabRegistry.all().length) {
    S.url = '';
    if (S.shown) hide();
    else pushUpdate();
    return;
  }
  if (wasActive) {
    const next = tabRegistry.all()[Math.min(idx, tabRegistry.all().length - 1)];
    switchTab(next.id);
  } else {
    pushUpdate();
  }
}

function loadContent(u) {
  const tab = getActiveTab();
  if (!tab) return;
  const target = normalize(u);
  tab.url = target;
  S.url = target;
  try {
    tab.view.webContents.loadURL(target).catch((err) => {
      log('navigation failed', target, String(err && err.message));
      sendStatus('could not load page: ' + String(err && err.message || err).slice(0, 80), 'err');
    });
  } catch (err) {
    log('navigation failed', target, String(err && err.message));
    sendStatus('could not load page: ' + String(err && err.message || err).slice(0, 80), 'err');
  }
}

function destroyAllTabs() {
  for (const t of tabRegistry.all()) {
    try { if (S.shown && S.parent && !S.parent.isDestroyed()) detachView(S.parent, t.view); } catch (_) {}
    try { t.view.webContents.destroy(); } catch (_) {}
  }
  tabRegistry.clear();
  S.url = '';
}

function switchProfile(id) {
  const st = getStore();
  if (!st || !st.setActiveProfile) return;
  const next = st.setActiveProfile(id);
  if (!next) return;
  const keepShown = S.shown;
  destroyAllTabs();
  if (keepShown) {
    createTab(activeHome(), true);
    layout();
  }
  pushUpdate();
  log('profile', next);
  sendStatus('profile: ' + (activeProfile().name || next), 'ok');
}

function currentUrl() {
  const cw = activeWC();
  try { return (cw && cw.getURL()) || (getActiveTab() && getActiveTab().url) || ''; } catch (_) { return ''; }
}

function openInSystemBrowser(url) {
  const u = url || currentUrl();
  if (!u) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    shell.openExternal(parsed.toString());
    return true;
  } catch (err) {
    log('external open failed', String(err && err.message));
    return false;
  }
}

function copyUrl(url) {
  const u = url || currentUrl();
  if (!u) return false;
  try { clipboard.writeText(u); return true; } catch (_) { return false; }
}

const PASTE_JS = `(function(url){
  try{
    var tx=document.querySelector('[role="textbox"][data-qa="texty_input"]');
    if(!tx)return 'missing';
    tx.focus();
    var ok=false;
    try{ok=document.execCommand('insertText',false,url);}catch(e){}
    if(!ok){
      try{
        tx.innerText=(tx.innerText||'')+url;
        tx.dispatchEvent(new InputEvent('input',{bubbles:true,data:url,inputType:'insertText'}));
      }catch(e){}
    }
    return 'ok';
  }catch(e){return 'err'}
})`;

async function pasteUrlToSlack(url) {
  const u = url || currentUrl();
  if (!u) return 'empty';
  try { clipboard.writeText(u); } catch (_) {}
  try {
    if (!S.parent || S.parent.isDestroyed()) return 'copied';
    if (!(await isSelfDMActive())) return 'copied';
    const r = await S.parent.webContents.executeJavaScript('(' + PASTE_JS + ')(' + JSON.stringify(u) + ')', true);
    return r || 'copied';
  } catch (_) { return 'copied'; }
}

function setPaletteOpen(open) {
  S.paletteOpen = !!open;
  toolbarH = S.paletteOpen ? Math.max(toolbarH, 420) : TOOLBAR_H;
  if (S.shown) try { layout(); } catch (_) {}
  try {
    const tw = S.toolbar && S.toolbar.webContents;
    if (tw && !tw.isDestroyed()) tw.send('sb-palette', { open: S.paletteOpen });
  } catch (_) {}
}

function paletteItems(q) {
  const st = getStore();
  const pid = activeProfileId();
  const url = currentUrl();
  const actions = [
    { kind: 'action', id: 'open-system', title: 'Open in system browser', url: url },
    { kind: 'action', id: 'copy-url', title: 'Copy URL', url: url },
    { kind: 'action', id: 'slack-msg', title: 'Add to Slack message', url: url },
    { kind: 'action', id: 'new-tab', title: 'New tab', url: '' },
  ];
  try {
    const profiles = (st && st.listProfiles) ? st.listProfiles() : [];
    profiles.forEach((p) => {
      actions.push({ kind: 'action', id: 'profile:' + p.id, title: 'Switch profile: ' + p.name, url: '' });
    });
  } catch (_) {}
  const tabs = tabRegistry.all().map((t) => ({ kind: 'tab', id: t.id, title: t.title || t.url, url: t.url }));
  const bms = (st && st.listBookmarks) ? st.listBookmarks(pid).map((b) => ({ kind: 'bookmark', id: 'bm:' + b.url, title: b.title, url: b.url })) : [];
  const hist = (st && st.listHistory) ? st.listHistory(pid).map((h) => ({ kind: 'history', id: 'h:' + h.url, title: h.title, url: h.url })) : [];
  const s = getSearch();
  if (!s) return actions.concat(tabs, bms, hist).slice(0, 30);
  return actions.map((item) => ({ item: item, score: s.score(item, q) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
    .concat(s.filterItems(tabs, q), s.filterItems(bms, q), s.filterItems(hist, q))
    .slice(0, 30);
}

function runPaletteItem(item) {
  if (!item) return;
  if (item.kind === 'action') {
    if (item.id === 'open-system') { openInSystemBrowser(item.url); sendStatus('opened in system browser', 'ok'); }
    else if (item.id === 'copy-url') { copyUrl(item.url); sendStatus('copied URL', 'ok'); }
    else if (item.id === 'slack-msg') {
      pasteUrlToSlack(item.url).then((r) => {
        sendStatus(r === 'ok' ? 'pasted into Slack' : (r === 'missing' ? 'copied (composer missing)' : 'copied URL'), r === 'ok' ? 'ok' : 'busy');
      }).catch(() => sendStatus('copied URL', 'ok'));
    }
    else if (item.id === 'new-tab') createTab(activeHome(), true);
    else if (item.id.indexOf('profile:') === 0) switchProfile(item.id.slice(8));
  } else if (item.kind === 'tab') {
    switchTab(item.id);
  } else if (item.url) {
    loadContent(item.url);
  }
  setPaletteOpen(false);
}

function layout() {
  if (!S.shown || !S.parent || S.parent.isDestroyed()) return;
  let b;
  try { b = S.parent.getContentBounds(); } catch (_) { return; }
  const w = b.width, hgt = b.height;
  const slackRatio = S.panelMode === 'split' ? S.splitRatio : 0.25;
  const browserW = Math.max(240, Math.floor(w * (1 - slackRatio)));
  const x = Math.max(0, w - browserW);
  const handlePad = S.panelMode === 'split' ? 8 : 0;
  setBounds(S.toolbar, { x: x - handlePad, y: SLACK_TOP_H, width: browserW + handlePad, height: toolbarH });
  const active = getActiveTab();
  if (active) setBounds(active.view, { x: x, y: SLACK_TOP_H + TOOLBAR_H, width: browserW, height: Math.max(50, hgt - SLACK_TOP_H - TOOLBAR_H) });
}

function focusToolbar() {
  setTimeout(() => {
    try {
      const tw = S.toolbar && S.toolbar.webContents;
      if (tw && !tw.isDestroyed()) {
        tw.focus();
        tw.executeJavaScript("document.getElementById('sb-url') && document.getElementById('sb-url').focus()").catch(() => {});
      }
    } catch (_) {}
  }, 120);
}

function show() {
  if (!S.parent || S.parent.isDestroyed()) return;
  if (!S.toolbar) {
    // Own partition: the toolbar runs with nodeIntegration, so it must not share
    // storage or cookies with the untrusted pages loaded in the content tabs.
    const part = session.fromPartition('persist:slack-sb-toolbar');
    S.toolbar = createView({
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: path.join(MOD_DIR, 'sb_toolbar_preload.cjs'),
      session: part,
    });
    S.toolbar.webContents.loadFile(path.join(MOD_DIR, 'sb_toolbar.html')).catch(() => {});
    S.toolbar.webContents.on('did-finish-load', () => {
      applyViewOpacity(S.toolbar, transparencyOp());
      if (S.theme) S.toolbar.webContents.send('sb-theme', S.theme);
      pushUpdate();
    });
    try {
      S.toolbar.webContents.on('before-input-event', (_e, input) => {
        const key = String(input.key).toLowerCase();
        const command = input.control || input.meta;
        if (input.type === 'keyDown' && command && (key === 'k' || (key === 'p' && input.shift))) {
          _e.preventDefault();
          setPaletteOpen(!S.paletteOpen);
        } else if (input.type === 'keyDown' && input.key === 'Escape' && S.paletteOpen) {
          _e.preventDefault();
          setPaletteOpen(false);
        }
      });
    } catch (_) {}
  }
  if (!tabRegistry.all().length) {
    createTab(activeHome(), false);
  }
  if (!tabRegistry.activeId()) tabRegistry.setActive(tabRegistry.all()[0].id);
  const active = getActiveTab();
  if (active) attachView(S.parent, active.view);
  attachView(S.parent, S.toolbar);
  S.shown = true;
  layout();
  const cw = active && active.view && active.view.webContents;
  if (cw && !cw.getURL()) { try { cw.loadURL(active.url || activeHome()); } catch (_) {} }
  pushUpdate();
  focusToolbar();
  if (S.panelMode === 'focus') applyFocusMode(true);
  maybeShowOnboarding();
  log('browser shown');
}
try { globalThis.sbShow = show; globalThis.sbHide = hide; globalThis.sbCreateTab = createTab; globalThis.sbSwitchTab = switchTab; globalThis.sbCloseTab = closeTab; } catch (_) {}

function hide() {
  if (!S.parent || S.parent.isDestroyed()) { S.shown = false; return; }
  if (S.focusMode) {
    applyFocusMode(false);
    S.focusMode = false;
  }
  detachView(S.parent, S.toolbar);
  const active = getActiveTab();
  if (active) detachView(S.parent, active.view);
  S.shown = false;
  try { S.parent.webContents.focus(); } catch (_) {}
  log('browser hidden');
}

function toggle() {
  if (S.shown) hide(); else show();
}

// expose for debugging via --inspect
try { globalThis.sbToggle = toggle; globalThis.sbState = S; } catch (_) {}

// ===================== OWN-DM GATE =====================
// Browser only toggles when the active conversation is the logged-in
// user's own DM ("message yourself").
const PROBE_JS = `(function(){
  var r={href:location.href||'',t:document.title||''};
  try{var t=typeof TS;r.TS=t;if(t!=='undefined'&&TS.boot_data){var b=TS.boot_data;r.uid=b.user_id||'';r.me=(b.self&&(b.self.id))||''}}catch(e){}
  try{var h=document.querySelector('[data-qa="channel_name"]');r.chan=h?h.innerText:''}catch(e){}
  try{var h2=document.querySelector('[data-qa="channel_header"]');r.hdr=h2?(h2.innerText||'').split('\\n').slice(0,3).join('|'):''}catch(e){}
  try{r.bodyAttr={};['data-user-id','data-team-id'].forEach(function(a){if(document.body.getAttribute(a))r.bodyAttr[a]=document.body.getAttribute(a)})}catch(e){}
  try{var map={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i)||'';var m=/^persist-v1::(T[A-Z0-9]+)::(U[A-Z0-9]+)::/.exec(k);if(m){map[m[1]]=m[2]}}r.persistSelf=map}catch(e){}
  try{var yc=document.querySelector('[data-qa="channel-sidebar-channel"][class*="--im-you"][class*="--selected"]');r.youSel=yc?(yc.closest('[data-qa="virtual-list-item"]')||{}).id||'':''}catch(e){}
  try{var cm=/(?:^|\\/)client\\/(T[A-Z0-9]+)(?:\\/([A-Z0-9]+))?/.exec(location.href||'');r.team=cm?cm[1]:'';r.conv=cm&&cm[2]?cm[2]:''}catch(e){}
  try{var tx=document.querySelector('[role="textbox"][data-qa="texty_input"]');r.composer=tx?(tx.innerText||''):''}catch(e){}
  try{var sel='';var items=document.querySelectorAll('[data-qa="virtual-list-item"]');
    for(var i=0;i<items.length;i++){var it=items[i];var row=it.querySelector('[data-qa="channel-sidebar-channel"]');
      if(!row)continue;var cn=String(row.className||'');
      if(!/--selected|--active/.test(cn))continue;
      sel=it.id||'';r.selClass=cn.slice(0,200);r.selName=(row.innerText||'').trim().slice(0,60);break;}
    r.selChan=sel;}catch(e){}
  return JSON.stringify(r);
})()`;

function probe() {
  try {
    if (!S.parent || S.parent.isDestroyed()) return Promise.resolve('');
    return S.parent.webContents.executeJavaScript(PROBE_JS, true);
  } catch (_) {
    return Promise.resolve('');
  }
}
try { globalThis.sbProbe = probe; } catch (_) {}

const OWN = {
  resolved: false,
  map: {},      // teamId -> userId
  selfChan: {}, // teamId -> own-DM channel id (learned from the --im-you row)
  last: null,   // last probe verdict, for logging
  logged: '',   // last logged verdict, so the ticker does not spam sb.log
};

async function resolveSelf() {
  try {
    const raw = await probe();
    const j = JSON.parse(raw || '{}');
    const url = (j.href || '');
    const tm = /\/client\/(T[A-Z0-9]+)/.exec(url);
    const curTeam = tm ? tm[1] : '';
    // source 1: new UI persist-* localStorage keys: persist-v1::<team>::<user>::
    if (j.persistSelf && Object.keys(j.persistSelf).length) {
      OWN.map = Object.assign({}, OWN.map, j.persistSelf);
    }
    // source 2: old TS.boot_data
    const uidOld = (j.uid || '').trim();
    if (uidOld && curTeam) OWN.map[curTeam] = OWN.map[curTeam] || uidOld;
    // Only log when the answer changes: this runs every 400 ms and used to append a
    // line per tick, which is what made sb.log grow without bound.
    const key = curTeam + '|' + (OWN.map[curTeam] || '');
    if (curTeam && OWN.map[curTeam]) {
      OWN.resolved = true;
      if (OWN.logged !== key) { OWN.logged = key; log('self resolved', curTeam, OWN.map[curTeam]); }
    } else if (Object.keys(OWN.map).length) {
      OWN.resolved = true;
      if (OWN.logged !== key) { OWN.logged = key; log('self resolved (team-unmatched)', JSON.stringify(OWN.map)); }
    } else if (OWN.logged !== 'none') {
      OWN.logged = 'none';
      log('self not resolvable yet', j.href || '(no href)');
    }
    j.curTeam = curTeam;
    return j;
  } catch (err) {
    log('resolveSelf err', String(err));
    return null;
  }
}
try { globalThis.sbResolve = resolveSelf; } catch (_) {}

async function isSelfDMActive() {
  try {
    if (!S.parent || S.parent.isDestroyed()) return false;
    const j = await resolveSelf();
    if (!j) return false;
    const team = j.curTeam || j.team || '';
    const conv = String(j.conv || '').trim();
    // AUTHORITATIVE rule: the conversation in the URL must be the own-DM
    // conversation id we pinned at unlock time (typing the phrase proves we
    // were in the own DM at that moment). CSS-class sniffing false-fires on
    // some Slack builds, so the URL decides whenever it is available.
    const known = team ? String(OWN.selfChan[team] || '') : '';
    if (known && conv) { OWN.last = { ok: conv === known, team, selChan: conv, youSel: j.youSel || '', src: 'url' }; return conv === known; }
    // fallback (URL not parseable): the sidebar row flagged as your own DM
    if (j.youSel && /^[A-Z0-9]+$/.test(j.youSel)) {
      if (team) OWN.selfChan[team] = j.youSel;
      OWN.last = { ok: true, team, selChan: j.selChan || '', youSel: j.youSel, src: 'dom' };
      return true;
    }
    const kn2 = team ? OWN.selfChan[team] : '';
    const ok = !!(kn2 && j.selChan && j.selChan === kn2);
    OWN.last = { ok, team, selChan: j.selChan || '', youSel: j.youSel || '', src: 'dom2' };
    return ok;
  } catch (_) {
    return false;
  }
}

// browser lifecycle: unlocked once via secret phrase, visible ONLY in own DM
// (no keyboard shortcut)
let UNLOCKED = false;
let lastDM = null;        // null until first probe
let minimized = false;    // hidden but state kept; restore needs phrase + PIN
let manualHide = false;   // user hid while browsing another convo
function awayLockMs() { return (Number(S.autolockMin) || 0) * 1000; }   // 0 = off
let awaySince = 0;           // when we went away (0 = present); set by stateTick()
let outStreak = 0;           // consecutive OUT probes while visible (flicker guard)

function fullExit() {
  if (S.focusMode) applyFocusMode(false);
  S.focusMode = false;
  UNLOCKED = false;
  minimized = false;
  manualHide = false;
  awaySince = 0;
  S.paletteOpen = false;
  toolbarH = TOOLBAR_H;
  destroyAllTabs();
  if (S.shown) { detachView(S.parent, S.toolbar); S.shown = false; }
  log('browser full exit');
}

function stateTick() {
  if (!UNLOCKED || minimized) return;
  if (!S.parent || S.parent.isDestroyed()) return;
  if (S.shown) { try { layout(); } catch (_) {} }
  let slackMin = false;
  try { slackMin = S.parent.isMinimized(); } catch (_) {}
  isSelfDMActive().then((ok) => {
    if (lastDM !== ok) log('own-DM gate', ok ? 'IN' : 'OUT', 'team=' + ((OWN.last && OWN.last.team) || '-'), 'chan=' + ((OWN.last && OWN.last.selChan) || '-'), 'you=' + ((OWN.last && OWN.last.youSel) || '-'), 'src=' + ((OWN.last && OWN.last.src) || '-'));
    const away = !ok || slackMin;
    if (!away) {
      outStreak = 0;
      if (awaySince) { log('back within grace period'); awaySince = 0; }  // cancel the timer
      if (!S.shown && !unlockBusy && !manualHide) { log('own DM -> show'); show(); }
    } else {
      if (S.focusMode) {
        applyFocusMode(false);
        S.focusMode = false;
        S.panelMode = 'overlay';
        const st = getStore();
        if (st) st.setUI({ panelMode: 'overlay' });
        if (S.shown) layout();
      }
      // leaving the own DM: take the browser off the wrong conversation right
      // away (2 consecutive OUT probes ~0.4 s to tolerate one-off probe errors),
      // but only auto-LOCK (phrase + PIN again) after the full grace period
      outStreak++;
      if (S.shown && outStreak >= 2) { log('left own DM -> hiding browser'); hide(); }
      if (!awaySince) {
        awaySince = Date.now();
        const _alm0 = awayLockMs();
        if (_alm0 > 0) log('away: ' + (slackMin ? 'slack minimized' : 'left own DM') + ' -> auto lock in ' + (_alm0 / 1000) + 's');
        else log('away: ' + (slackMin ? 'slack minimized' : 'left own DM') + ' (auto-lock off)');
      } else {
        const _alm = awayLockMs();
        if (_alm > 0 && Date.now() - awaySince >= _alm) {
          // stayed away long enough: lock. Re-entry then needs the secret phrase + PIN,
          // exactly as if the minimize button had been pressed.
          awaySince = 0;
          outStreak = 0;
          minimized = true;
          manualHide = false;
          log('away ' + (_alm / 1000) + 's -> auto locked' + (S.shown ? '' : ' (already hidden)'));
          if (S.shown) hide();
        }
      }
    }
    lastDM = ok;
  }).catch(() => {});
}
try { globalThis.sbStateTick = stateTick; } catch (_) {}

// ===================== PIN LOCK =====================
const PIN_FILE = path.join(MOD_DIR, 'sb_pin.json');
let pinStore;
try { pinStore = require(path.join(MOD_DIR, 'sb_lock.cjs')); }
catch (err) {
  log('lock module missing; using compatibility fallback', String(err && err.message));
  const crypto = require('crypto');
  pinStore = {
    read: function (file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } },
    write: function (file, pin) {
      try {
        fs.writeFileSync(file, JSON.stringify({
          hash: crypto.createHash('sha256').update(String(pin), 'utf8').digest('hex'),
          set: new Date().toISOString(),
        }));
        return true;
      } catch (_) { return false; }
    },
    verify: function (file, pin) {
      const record = this.read(file);
      const actual = crypto.createHash('sha256').update(String(pin), 'utf8').digest('hex');
      return { ok: !!(record && record.hash && record.hash === actual), exists: !!record, migrated: false };
    },
  };
}

function pinRead() {
  return pinStore.read(PIN_FILE);
}
function pinWrite(pin) {
  return pinStore.write(PIN_FILE, pin);
}

let unlockWin = null;
let unlockBusy = false;
let unlockResolve = null;
let unlockMode = 'verify';
let forceSetPin = false;

// fire the success callback and close the window
function unlockSuccess() {
  const cb = unlockResolve;
  unlockResolve = null;
  UNLOCKED = true;
  minimized = false;
  manualHide = false;
  closeUnlock();
  try { if (cb) cb(true); } catch (_) {}
  log('unlock success');
}

function closeUnlock() {
  try { if (unlockWin && !unlockWin.isDestroyed()) unlockWin.close(); } catch (_) {}
  unlockWin = null;
}

// change the user's PIN: verify the old one first, then set a new one
function changePin() {
  if (unlockBusy) return;
  if (!fs.existsSync(PIN_FILE)) {
    // no pin yet -> just set one
    forceSetPin = true;
    requestUnlock(() => { forceSetPin = false; log('pin set'); }, 'set');
    return;
  }
  requestUnlock((ok) => {
    unlockBusy = false;
    if (!ok) { forceSetPin = false; log('pin change cancelled'); return; }
    forceSetPin = true;
    setTimeout(() => {
      requestUnlock(() => { forceSetPin = false; log('pin changed'); }, 'set');
    }, 250);
  }, 'verify');
}

async function requestUnlock(onOk, modeOverride) {
  if (unlockBusy) return;
  let st = false;
  try { st = await isSelfDMActive(); } catch (_) { st = false; }
  if (!st) { log('unlock aborted: not self DM'); return; }
  unlockBusy = true;
  if (modeOverride) unlockMode = modeOverride;
  else unlockMode = fs.existsSync(PIN_FILE) ? 'verify' : 'set';
  try {
    unlockWin = new BrowserWindow({
      width: 340, height: 220, frame: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      parent: (S.parent && !S.parent.isDestroyed()) ? S.parent : undefined,
      backgroundColor: '#1a1d21',
      webPreferences: {
        preload: path.join(MOD_DIR, 'sb_preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    unlockWin.setMenu(null);
    unlockWin.on('closed', () => {
      unlockBusy = false;
      if (unlockResolve) { const cb = unlockResolve; unlockResolve = null; cb(false); }
    });
    // after a successful PIN submit the loader resolves -> callback
    unlockResolve = (ok) => { try { if (ok && onOk) onOk(); } catch (_) {} };
    unlockWin.loadFile(path.join(MOD_DIR, 'sb_unlock.html'), { query: { mode: unlockMode } });
    unlockWin.webContents.once('did-finish-load', () => {
      try { unlockWin.show(); unlockWin.focus(); } catch (_) {}
    });
    log('unlock window opened mode=' + unlockMode);
  } catch (err) {
    unlockBusy = false;
    log('unlock window error', String(err));
  }
}
try { globalThis.sbRequestUnlock = requestUnlock; } catch (_) {}

// pending phrase-unlock pass (once PIN verified from phrase path)
ipcMain.handle('sb-pin-submit', (_ev, pin) => {
  pin = String(pin || '').trim();
  if (!pin) return { ok: false, msg: 'PIN likhen' };
  if (pin.length < 4) return { ok: false, msg: 'minimum 4 character' };
  const existing = pinRead();
  if (forceSetPin && unlockMode === 'set') {
    if (!pinWrite(pin)) return { ok: false, msg: 'Could not save PIN. Check the Sidebrowser data folder permissions.' };
    log('pin changed');
    forceSetPin = false;
    unlockSuccess();
    return { ok: true };
  }
  if (existing && existing.hash && unlockMode === 'set') {
    // a pin already exists; entering it here unlocks
    if (pinStore.verify(PIN_FILE, pin).ok) { unlockSuccess(); return { ok: true }; }
    return { ok: false, msg: 'bhul PIN' };
  }
  if (existing && existing.hash) {
    if (pinStore.verify(PIN_FILE, pin).ok) {
      log('pin verified');
      unlockSuccess();
      return { ok: true };
    }
    log('pin wrong');
    return { ok: false, msg: 'bhul PIN' };
  }
  // no pin yet -> first use, set it
  if (!pinWrite(pin)) return { ok: false, msg: 'Could not save PIN. Check the Sidebrowser data folder permissions.' };
  log('pin set (first time)');
  unlockSuccess();
  return { ok: true };
});
// ===================== SECRET PHRASE TRIGGER =====================
// Type the phrase in the composer of your OWN DM -> unlock prompt -> browser.
// Renderer keeps a capture-phase keydown listener: pressing Enter with the
// phrase in the composer swallows the send, clears the composer and flags.
// ---- secret phrase (default "enjoy you", changeable from settings) ----
function getPhrase() {
  const st = getStore();
  const v = st ? st.getUI().phrase : null;
  return (typeof v === 'string' && v.trim()) ? v.trim() : DEFAULT_PHRASE;
}
function phraseJS() {
  return `(function(){
  var phrase = ${JSON.stringify(getPhrase())};
  if(!window.__sbPhraseInstalled){
    window.__sbPhraseInstalled=1;window.__sbPhrase=0;
    window.__sbPhraseText=phrase;
    document.addEventListener('keydown',function(ev){
      if(ev.key!=='Enter'||ev.shiftKey)return;
      var tx=document.querySelector('[role="textbox"][data-qa="texty_input"]');
      if(!tx)return;
      var t=(tx.innerText||'').toLowerCase().replace(/[\\u2019']/g,"'");
      var p=(window.__sbPhraseText||'').toLowerCase().replace(/[\\u2019']/g,"'");
      if(!p||t.indexOf(p)<0)return;
      try{ev.preventDefault();ev.stopImmediatePropagation()}catch(e){}
      try{tx.innerHTML='';tx.dispatchEvent(new InputEvent('input',{bubbles:true}))}catch(e){}
      window.__sbPhrase=1;
    },true);
  }
  window.__sbPhraseText=phrase;
  if(window.__sbPhrase){window.__sbPhrase=0;
    var tx=document.querySelector('[role="textbox"][data-qa="texty_input"]');
    if(tx){try{tx.innerHTML='';tx.dispatchEvent(new InputEvent('input',{bubbles:true}))}catch(e){}}
    return '1';
  }
  var tx=document.querySelector('[role="textbox"][data-qa="texty_input"]');
  if(!tx)return '0';
  var t=(tx.innerText||'').toLowerCase().replace(/[\\u2019']/g,"'");
  var p=(window.__sbPhraseText||'').toLowerCase().replace(/[\\u2019']/g,"'");
  if(!p||t.indexOf(p)<0)return '0';
  try{tx.innerHTML='';tx.dispatchEvent(new InputEvent('input',{bubbles:true}))}catch(e){}
  return '1';
})()`;
}

let phraseBusy = false;
async function phraseTick() {
  if (S.shown || phraseBusy || unlockBusy) return;
  if (!S.parent || S.parent.isDestroyed()) return;
  phraseBusy = true;
  try {
    const hit = await S.parent.webContents.executeJavaScript(phraseJS(), true).catch(() => '0');
    if (hit === '1') {
      const okDM = await isSelfDMActive();
      if (!okDM) { log('phrase ignored: not own DM'); return; }
      // we are provably in the own DM right now: pin this exact conversation id
      // so the own-DM gate can use exact URL equality from now on
      try {
        const jp = await resolveSelf();
        if (jp && jp.conv && jp.curTeam) {
          OWN.selfChan[jp.curTeam] = jp.conv;
          OWN.resolved = true;
          log('own DM pinned', jp.curTeam, jp.conv);
        }
      } catch (_) {}
      log('phrase detected');
      requestUnlock(() => { isSelfDMActive().then((ok) => { if (ok) show(); }); });
    }
  } catch (_) {}
  finally { phraseBusy = false; }
}
try { globalThis.sbPhraseTick = phraseTick; } catch (_) {}


// ---- self-update (toolbar "Update" button)
let updater = null;
function getUpdater() {
  if (updater) return updater;
  try { updater = require(path.join(MOD_DIR, 'sb_update.cjs')); } catch (err) { log('updater unavailable', String(err && err.message)); }
  return updater;
}

function sendStatus(text, kind) {
  const status = { text: text, kind: kind };
  for (const win of [S.toolbar, settingsWin]) {
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (!wc || wc.isDestroyed()) continue;
    try { wc.send('sb-update-status', status); } catch (err) { log('status send err', String(err && err.message)); }
  }
}

function normalizedVersion(value) {
  const parts = String(value || '').split('.');
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null;
  while (parts.length < 4) parts.push('0');
  return parts.join('.');
}

function checkSidebrowserHealth() {
  const missing = REPAIR_FILES.filter((file) => !fs.existsSync(path.join(MOD_DIR, file)));
  if (missing.length) {
    return { kind: 'err', text: 'Repair files missing: ' + missing.join(', ') };
  }

  let patchResult;
  try {
    patchResult = fs.readFileSync(path.join(MOD_DIR, 'patch-result.txt'), 'utf8');
  } catch (err) {
    return { kind: 'busy', text: 'Sidebrowser is running, but patch status is unavailable: ' + String(err && err.message) };
  }

  const targetMatch = patchResult.match(/target: .*slackdesktop_(\d+(?:\.\d+){2,3})_/i);
  const executableMatch = String(process.execPath).match(/slackdesktop_(\d+(?:\.\d+){2,3})_/i);
  const runningVersion = normalizedVersion(app.getVersion()) || (executableMatch ? normalizedVersion(executableMatch[1]) : null);
  const patchedVersion = targetMatch ? normalizedVersion(targetMatch[1]) : null;
  if (runningVersion && patchedVersion && runningVersion !== patchedVersion) {
    return {
      kind: 'busy',
      text: 'Slack version differs from the last patch target (' + runningVersion + ' vs ' + patchedVersion + '). Re-patch recommended.',
    };
  }
  if (!/PATCH OK\b/.test(patchResult) || /ROLLBACK/.test(patchResult)) {
    return { kind: 'busy', text: 'Sidebrowser is running, but the last patch result does not confirm success. Re-patch if needed.' };
  }
  if (!patchedVersion) {
    return { kind: 'ok', text: 'Sidebrowser is running; the last patch succeeded. Slack version could not be verified.' };
  }
  return { kind: 'ok', text: 'Sidebrowser is running; last patch succeeded for Slack ' + patchedVersion + '.' };
}

let repairInProgress = false;
function requestRepatch() {
  if (repairInProgress) {
    sendStatus('re-patch is already starting', 'busy');
    return;
  }

  const patcher = path.join(MOD_DIR, 'apply-store-patch.ps1');
  const missing = REPAIR_FILES.filter((file) => !fs.existsSync(path.join(MOD_DIR, file)));
  if (missing.length) {
    sendStatus('re-patch unavailable; missing files: ' + missing.join(', '), 'err');
    return;
  }

  repairInProgress = true;
  sendStatus('requesting Administrator approval; Slack will close and restart', 'busy');
  const command = [
    "$argLine = '-NoProfile -ExecutionPolicy Bypass -File \"' + $env:SB_PATCHER_PATH + '\" -HomeDir \"' + $env:SB_MOD_DIR + '\"'",
    "try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argLine } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    env: Object.assign({}, process.env, { SB_PATCHER_PATH: patcher, SB_MOD_DIR: MOD_DIR }),
  }, (err, _stdout, stderr) => {
    if (err) {
      repairInProgress = false;
      const detail = String(stderr || err.message).trim().slice(0, 120);
      log('re-patch launch failed', detail);
      sendStatus('re-patch could not start: ' + detail, 'err');
      return;
    }
    log('re-patch launched');
    sendStatus('Administrator approval accepted; Slack will close and restart to apply the patch', 'busy');
  });
}

function sendToolbar(channel, payload) {
  const wc = S.toolbar && !S.toolbar.isDestroyed() ? S.toolbar.webContents : null;
  if (!wc || wc.isDestroyed()) return;
  try { wc.send(channel, payload); } catch (err) { log(channel + ' send err', String(err && err.message)); }
}

function setPanelMode(mode) {
  if (!['overlay', 'split', 'focus'].includes(mode)) return false;
  S.panelMode = mode;
  const st = getStore();
  if (st) st.setUI({ panelMode: mode });
  if (mode === 'focus') {
    applyFocusMode(true);
  } else if (S.focusMode) {
    applyFocusMode(false);
  }
  if (S.shown) layout();
  pushUpdate();
  return true;
}

function setSplitRatio(value) {
  const ratio = Number(value);
  if (!isFinite(ratio)) return false;
  S.splitRatio = Math.max(0.2, Math.min(0.7, ratio));
  const st = getStore();
  if (st) st.setUI({ splitRatio: S.splitRatio });
  if (S.shown) layout();
  sendToolbar('sb-split-ratio', S.splitRatio);
  return true;
}

function applyFocusMode(enabled) {
  if (!S.parent || S.parent.isDestroyed()) return Promise.resolve(false);
  const script = `(function(on){
    var old=window.__sbFocusState;
    if(old&&old.cleanup){old.cleanup();window.__sbFocusState=null;}
    if(!on)return true;
    var pane=document.querySelector('[data-qa="message_pane"]')||document.querySelector('[data-qa="virtual-list"]');
    if(!pane)return false;
    var shades=[];
    for(var i=0;i<4;i++){var n=document.createElement('div');n.setAttribute('aria-hidden','true');
      n.style.cssText='position:fixed;z-index:2147483640;pointer-events:none;background:rgba(0,0,0,.58);margin:0;padding:0;border:0;';
      document.documentElement.appendChild(n);shades.push(n);}
    function paint(){if(!pane.isConnected){shades.forEach(function(n){n.remove();});window.__sbFocusState=null;return;}
      var r=pane.getBoundingClientRect(),w=innerWidth,h=innerHeight,x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(w,r.right),bottom=Math.min(h,r.bottom);
      var boxes=[[0,0,w,y],[0,bottom,w,Math.max(0,h-bottom)],[0,y,x,Math.max(0,bottom-y)],[right,y,Math.max(0,w-right),Math.max(0,bottom-y)]];
      boxes.forEach(function(b,i){shades[i].style.left=b[0]+'px';shades[i].style.top=b[1]+'px';shades[i].style.width=b[2]+'px';shades[i].style.height=b[3]+'px';});}
    var observer=typeof ResizeObserver==='function'?new ResizeObserver(paint):null;if(observer)observer.observe(pane);
    addEventListener('resize',paint,true);addEventListener('scroll',paint,true);paint();
    window.__sbFocusState={cleanup:function(){if(observer)observer.disconnect();removeEventListener('resize',paint,true);removeEventListener('scroll',paint,true);shades.forEach(function(n){n.remove();});}};
    return true;
  })(${JSON.stringify(!!enabled)})`;
  return S.parent.webContents.executeJavaScript(script, true).then((ok) => {
    if (enabled && !ok) {
      S.focusMode = false;
      sendStatus('focus mode unavailable: Slack message pane was not found', 'err');
      return false;
    }
    S.focusMode = !!enabled;
    return true;
  }).catch((err) => {
    log('focus mode err', String(err && err.message));
    sendStatus('focus mode failed: ' + String(err && err.message || err).slice(0, 80), 'err');
    S.focusMode = false;
    return false;
  });
}

function openPictureInPicture() {
  const cw = activeWC();
  if (!cw || cw.isDestroyed()) {
    sendStatus('picture-in-picture unavailable: no active tab', 'err');
    return;
  }
  const script = `(async function(){
    var videos=Array.from(document.querySelectorAll('video')).filter(function(v){return v.readyState>=2&&v.videoWidth>0;});
    var video=videos.find(function(v){return !v.paused&&!v.ended;})||videos[0];
    if(!video)return 'No playable video found in this tab.';
    if(!document.pictureInPictureEnabled||!video.requestPictureInPicture)return 'Picture-in-Picture is not supported on this page.';
    try{await video.requestPictureInPicture();return 'Picture-in-Picture opened.';}catch(e){return String(e&&e.message||e);}
  })()`;
  cw.executeJavaScript(script, true).then((message) => {
    sendStatus(message || 'Picture-in-Picture request completed', /^Picture-in-Picture opened/.test(message) ? 'ok' : 'err');
  }).catch((err) => {
    log('picture-in-picture err', String(err && err.message));
    sendStatus('picture-in-picture failed: ' + String(err && err.message || err).slice(0, 80), 'err');
  });
}

function syncTheme() {
  if (!S.parent || S.parent.isDestroyed()) return;
  S.parent.webContents.executeJavaScript(`(function(){
    var b=document.body,s=b?getComputedStyle(b):null,bg=s&&s.backgroundColor||'rgb(26,29,33)',fg=s&&s.color||'rgb(209,210,211)';
    var m=/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/i.exec(bg),lum=m?(Number(m[1])+Number(m[2])+Number(m[3]))/3:40;
    var dark=/dark/i.test((document.documentElement.className||'')+' '+(b&&b.className||''))||lum<128;
    return JSON.stringify({mode:dark?'dark':'light',background:bg,foreground:fg});
  })()`, true).then((raw) => {
    let theme;
    try { theme = JSON.parse(raw); } catch (_) { return; }
    if (!theme || (S.theme && S.theme.mode === theme.mode && S.theme.background === theme.background && S.theme.foreground === theme.foreground)) return;
    S.theme = theme;
    for (const win of [S.toolbar, settingsWin]) {
      const wc = win && !win.isDestroyed() ? win.webContents : null;
      if (wc && !wc.isDestroyed()) wc.send('sb-theme', theme);
    }
  }).catch((err) => log('theme sync err', String(err && err.message)));
}

let onboardingWin = null;
function maybeShowOnboarding() {
  const st = getStore();
  if (!st || st.getUI().onboardingComplete || onboardingWin) return;
  try {
    onboardingWin = new BrowserWindow({
      width: 420, height: 340, frame: false, resizable: false, skipTaskbar: true,
      alwaysOnTop: true, parent: S.parent && !S.parent.isDestroyed() ? S.parent : undefined,
      backgroundColor: '#141a21',
      webPreferences: { preload: path.join(MOD_DIR, 'sb_preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    onboardingWin.loadFile(path.join(MOD_DIR, 'sb_onboarding.html')).catch((err) => log('onboarding load err', String(err && err.message)));
    onboardingWin.on('closed', () => { onboardingWin = null; });
  } catch (err) {
    onboardingWin = null;
    log('onboarding window err', String(err && err.message));
  }
}

let contextLinkBusy = false;
async function contextLinksTick() {
  if (!S.contextLinks || !UNLOCKED || !S.shown || contextLinkBusy || !S.parent || S.parent.isDestroyed()) return;
  contextLinkBusy = true;
  try {
    if (!(await isSelfDMActive())) return;
    const url = await S.parent.webContents.executeJavaScript(`(function(){
      if(!window.__sbContextLinks){
        window.__sbContextLinks={pending:'',scan:function(){
          var root=document.querySelector('[data-qa="message_pane"]')||document.body;if(!root)return;
          root.querySelectorAll('a[href^="http"]:not([data-sb-open-here])').forEach(function(a){
            a.setAttribute('data-sb-open-here','1');
            var b=document.createElement('button');b.type='button';b.textContent='Open here';b.setAttribute('data-sb-open-button','1');
            b.style.cssText='margin-left:6px;padding:1px 5px;border:1px solid #36c5f0;border-radius:8px;background:#1e2630;color:#dbe4ee;font:10px Segoe UI,sans-serif;cursor:pointer;';
            b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();window.__sbContextLinks.pending=a.href;});
            a.insertAdjacentElement('afterend',b);
          });
        }};
        window.__sbContextLinks.timer=setInterval(window.__sbContextLinks.scan,1200);
      }
      window.__sbContextLinks.scan();var u=window.__sbContextLinks.pending;window.__sbContextLinks.pending='';return u;
    })()`, true);
    if (url && /^https?:\/\//i.test(url)) loadContent(url);
  } catch (err) {
    log('context links err', String(err && err.message));
  } finally {
    contextLinkBusy = false;
  }
}

// ---- bind IPC once
function bindIPC() {
  if (S.ipcBound) return;
  S.ipcBound = true;
  ipcMain.on('sb-go', (_ev, u) => { loadContent(u); });
  ipcMain.on('sb-back', () => {
    const cw = activeWC();
    if (!cw) return;
    if (cw.navigationHistory && cw.navigationHistory.canGoBack()) cw.navigationHistory.goBack();
    else if (cw.canGoBack && cw.canGoBack()) cw.goBack();
  });
  ipcMain.on('sb-fwd', () => {
    const cw = activeWC();
    if (!cw) return;
    if (cw.navigationHistory && cw.navigationHistory.canGoForward()) cw.navigationHistory.goForward();
    else if (cw.canGoForward && cw.canGoForward()) cw.goForward();
  });
  ipcMain.on('sb-reload', () => {
    const cw = activeWC();
    if (cw) cw.reload();
  });
  ipcMain.on('sb-stop', () => {
    const cw = activeWC();
    if (cw) cw.stop();
  });
  ipcMain.on('sb-home', () => { loadContent(activeHome()); });
  ipcMain.on('sb-hide', () => { log('sb-hide received'); toolbarH = TOOLBAR_H; fullExit(); });
  ipcMain.on('sb-min', () => { log('sb-min received'); toolbarH = TOOLBAR_H; minimized = true; manualHide = false; hide(); });
  ipcMain.on('sb-newtab', (_ev, u) => { if (UNLOCKED) createTab(u || activeHome(), true); });
  ipcMain.on('sb-switchtab', (_ev, id) => { if (UNLOCKED) switchTab(id); });
  ipcMain.on('sb-closetab', (_ev, id) => { if (UNLOCKED) closeTab(id); });
  ipcMain.on('sb-devtools', () => {
    const cw = activeWC();
    if (cw) cw.openDevTools({ mode: 'detach' });
  });
  ipcMain.on('sb-preload-ready', () => { log('PRELOAD READY'); });
  ipcMain.on('sb-update-check', () => {
    const u = getUpdater();
    if (!u) { sendStatus('updater missing', 'err'); return; }
    u.checkAndApply(MOD_DIR, (st) => sendStatus(st.text, st.kind))
      .then((r) => {
        log('update check', r.state, (r.changed && r.changed.join(',')) || '', r.error || '');
        if (r && r.state === 'installer') {
          sendStatus('installer launched - Slack will restart', 'ok');
        } else if (r && r.state === 'updated') {
          if (r.needRestart) {
            sendStatus('updated - restart Slack to apply', 'ok');
          } else {
            // toolbar.html only -> hot-reload the toolbar view in place
            try {
              const tw = S.toolbar && S.toolbar.webContents;
              if (tw && !tw.isDestroyed()) { tw.reload(); sendStatus('updated (no restart needed)', 'ok'); }
              else sendStatus('updated - reopen browser', 'ok');
            } catch (_) { sendStatus('updated - reopen browser', 'ok'); }
          }
        } else if (r && r.state === 'current') {
          sendStatus('up to date', 'ok');
        } else if (r && r.state === 'error') {
          sendStatus('update failed: ' + (r.error || '').slice(0, 60), 'err');
        }
      })
      .catch((err) => { log('update check error', String(err && err.message)); sendStatus('update failed', 'err'); });
  });
  ipcMain.handle('sb-health-check', () => checkSidebrowserHealth());
  ipcMain.on('sb-repatch', () => { requestRepatch(); });
  // ---- transparency (percentage bar in the toolbar)
  ipcMain.handle('sb-opacity-get', () => { const v = Number(S.opacity); return isFinite(v) ? v : 100; });
  ipcMain.handle('sb-ui-get', () => {
    const st = getStore();
    return st ? st.getUI() : {};
  });
  ipcMain.on('sb-opacity', (_ev, pct) => {
    let v = Number(pct);
    if (!isFinite(v)) return;
    v = Math.max(20, Math.min(100, Math.round(v)));
    if (v === S.opacity) return;
    S.opacity = v;
    applyTransparency();
    const st = getStore();
    if (st) st.setUI({ transparency: v });
    log('transparency', v);
  });
  // ---- toolbar menu open/close (grows toolbar to fit the dropdown, overlays content)
  ipcMain.on('sb-menu', (_ev, open) => {
    const want = open ? 400 : TOOLBAR_H;
    if (toolbarH === want) { log('menu', open ? 'open (already sized)' : 'close (already sized)'); return; }
    toolbarH = want;
    if (S.shown && S.parent && !S.parent.isDestroyed()) {
      try { layout(); log('menu', open ? 'open resized->' + toolbarH : 'close resized->' + toolbarH); }
      catch (e) { log('menu layout err', String(e && e.message)); }
    } else {
      log('menu', open ? 'open (not shown)' : 'close (not shown)');
    }
  });
  ipcMain.on('sb-autolock', (_ev, sec) => {
    let v = Number(sec);
    if (!isFinite(v)) return;
    v = Math.max(0, Math.min(3600, Math.round(v)));
    if (v === S.autolockMin) return;
    S.autolockMin = v;
    const st = getStore();
    if (st) st.setUI({ autolockMin: v });
    log('auto-lock', v);
  });
  ipcMain.handle('sb-autolock-get', () => { const v = Number(S.autolockMin); return isFinite(v) ? v : 30; });
  // ---- change PIN (from settings panel)
  ipcMain.on('sb-change-pin', () => { try { changePin(); } catch (e) { log('changePin err', String(e && e.message)); } });
  // ---- change secret phrase (from settings panel) ----
  ipcMain.handle('sb-phrase-get', () => getPhrase());
  ipcMain.handle('sb-phrase-set', (_ev, phrase) => {
    phrase = String(phrase || '').trim();
    if (phrase.length < 3) return { ok: false, msg: 'minimum 3 characters' };
    const st = getStore();
    if (st) st.setUI({ phrase: phrase });
    log('phrase changed to: ' + phrase);
    return { ok: true };
  });
  ipcMain.on('sb-change-phrase', () => {
    try {
      if (unlockBusy) return;
      isSelfDMActive().then((ok) => {
        if (!ok) { log('phrase change aborted: not own DM'); return; }
        const w = new BrowserWindow({
          width: 360, height: 200, frame: false, resizable: false,
          alwaysOnTop: true, skipTaskbar: true, show: false,
          parent: (S.parent && !S.parent.isDestroyed()) ? S.parent : undefined,
          backgroundColor: '#1a1d21',
          webPreferences: { preload: path.join(MOD_DIR, 'sb_preload.cjs'), contextIsolation: true, nodeIntegration: false },
        });
        w.setMenu(null);
        w.loadFile(path.join(MOD_DIR, 'sb_phrase.html'));
        w.webContents.once('did-finish-load', () => { try { w.show(); w.focus(); } catch (_) {} });
        w.on('closed', () => {});
      }).catch(() => {});
    } catch (e) { log('changePhrase err', String(e && e.message)); }
  });
  // ---- settings popup window (floats above everything; auto-closes on blur)
  ipcMain.on('sb-open-settings', () => { openSettingsWindow(); });
  ipcMain.on('sb-open-bookmarks', () => {
    if (S.toolbar && !S.toolbar.isDestroyed()) {
      try { S.toolbar.webContents.executeJavaScript('window.sbToggleBM && window.sbToggleBM()').catch(() => {}); } catch (_) {}
    }
  });
  // ---- bookmarks
  ipcMain.handle('sb-bm-list', () => { const st = getStore(); return st ? st.listBookmarks(activeProfileId()) : []; });
  ipcMain.handle('sb-bm-add', (_ev, p) => {
    const st = getStore();
    if (!st) return [];
    st.addBookmark(p && p.url, p && p.title, activeProfileId());
    log('bookmark added', (p && p.url) || '(none)');
    return st.listBookmarks(activeProfileId());
  });
  ipcMain.handle('sb-bm-del', (_ev, p) => {
    const st = getStore();
    if (!st) return [];
    const next = st.removeBookmark(p && p.url, activeProfileId());
    log('bookmark removed', (p && p.url) || '(none)');
    return next;
  });
  ipcMain.handle('sb-profiles', () => {
    const st = getStore();
    return {
      list: st && st.listProfiles ? st.listProfiles() : [],
      active: activeProfileId(),
    };
  });
  ipcMain.on('sb-profile-switch', (_ev, id) => { if (UNLOCKED) switchProfile(String(id || '')); });
  ipcMain.handle('sb-profile-add', (_ev, p) => {
    const st = getStore();
    if (!st || !st.addProfile) return [];
    const name = String((p && p.name) || '').trim();
    if (!name) throw new Error('Profile name is required');
    st.addProfile({ name: name, home: (p && p.home) || DEFAULT_HOME, color: (p && p.color) || '#8fa3b8' });
    pushUpdate();
    return st.listProfiles();
  });
  ipcMain.handle('sb-profile-rename', (_ev, p) => {
    const st = getStore();
    const result = st && st.renameProfile ? st.renameProfile(p && p.id, p && p.name) : null;
    if (!result) throw new Error('Profile could not be renamed');
    pushUpdate();
    return result;
  });
  ipcMain.handle('sb-profile-color', (_ev, p) => {
    const st = getStore();
    const result = st && st.setProfileColor ? st.setProfileColor(p && p.id, p && p.color) : null;
    if (!result) throw new Error('Choose a valid profile color');
    pushUpdate();
    return result;
  });
  ipcMain.handle('sb-profile-del', (_ev, id) => {
    const st = getStore();
    if (!st || !st.removeProfile) return [];
    const current = st.listProfiles();
    if (current.length <= 1) throw new Error('At least one profile must remain');
    if (!current.some((profile) => profile.id === id)) throw new Error('Profile does not exist');
    if (id === activeProfileId()) switchProfile((current.find((x) => x.id !== id) || {}).id);
    st.removeProfile(id);
    pushUpdate();
    return st.listProfiles();
  });
  ipcMain.handle('sb-profile-home', (_ev, p) => {
    const st = getStore();
    if (!st || !st.setProfileHome) return null;
    const r = st.setProfileHome((p && p.id) || activeProfileId(), p && p.home);
    if (!r) throw new Error('Home must be a valid HTTP or HTTPS URL');
    pushUpdate();
    return r;
  });
  ipcMain.handle('sb-panel-mode', (_ev, mode) => {
    if (!UNLOCKED || !S.shown) throw new Error('Unlock the browser before changing its mode');
    if (!setPanelMode(String(mode || ''))) throw new Error('Invalid side-panel mode');
    return { mode: S.panelMode };
  });
  ipcMain.handle('sb-split-ratio', (_ev, ratio) => {
    if (!setSplitRatio(ratio)) throw new Error('Invalid split ratio');
    return S.splitRatio;
  });
  ipcMain.handle('sb-context-links', (_ev, enabled) => {
    S.contextLinks = !!enabled;
    const st = getStore();
    if (st) st.setUI({ contextLinks: S.contextLinks });
    if (!S.contextLinks && S.parent && !S.parent.isDestroyed()) {
      S.parent.webContents.executeJavaScript(`(function(){var s=window.__sbContextLinks;if(s){clearInterval(s.timer);document.querySelectorAll('[data-sb-open-button]').forEach(function(n){n.remove();});document.querySelectorAll('[data-sb-open-here]').forEach(function(n){n.removeAttribute('data-sb-open-here');});delete window.__sbContextLinks;}})()`, true)
        .catch((err) => log('context links cleanup err', String(err && err.message)));
    }
    return S.contextLinks;
  });
  ipcMain.handle('sb-onboarding-state', () => {
    const st = getStore();
    return { profiles: st && st.listProfiles ? st.listProfiles() : [], active: activeProfileId() };
  });
  ipcMain.handle('sb-onboarding-finish', (_ev, profileId) => {
    const st = getStore();
    if (!st || !st.listProfiles().some((profile) => profile.id === profileId)) throw new Error('Select a valid profile');
    switchProfile(profileId);
    st.setUI({ onboardingComplete: true });
    if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
    sendStatus('Setup complete. Open the command palette with Ctrl+K.', 'ok');
    return true;
  });
  ipcMain.on('sb-onboarding-skip', () => {
    const st = getStore();
    if (st) st.setUI({ onboardingComplete: true });
    if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
  });
  ipcMain.handle('sb-history-list', () => {
    const st = getStore();
    return st && st.listHistory ? st.listHistory(activeProfileId()) : [];
  });
  ipcMain.handle('sb-downloads-list', () => {
    const st = getStore();
    return st && st.listDownloads ? st.listDownloads(activeProfileId()) : [];
  });
  ipcMain.on('sb-download-open', (_ev, rec) => {
    try {
      const p = rec && rec.path;
      if (p) shell.showItemInFolder(p);
    } catch (_) {}
  });
  ipcMain.handle('sb-blocker-get', () => {
    const b = getBlocker();
    return b ? b.isEnabled() : false;
  });
  ipcMain.on('sb-blocker-set', (_ev, on) => {
    const b = getBlocker();
    if (!b) return;
    b.setEnabled(!!on);
    const st = getStore();
    if (st) st.setUI({ blocker: !!on });
    sendStatus(on ? 'ad blocker on' : 'ad blocker off', 'ok');
    pushUpdate();
  });
  ipcMain.handle('sb-palette-query', (_ev, q) => (UNLOCKED && S.shown) ? paletteItems(q) : []);
  ipcMain.on('sb-palette-run', (_ev, item) => { if (UNLOCKED) runPaletteItem(item); });
  ipcMain.on('sb-palette-toggle', () => { if (UNLOCKED && S.shown) setPaletteOpen(!S.paletteOpen); });
  ipcMain.on('sb-palette-close', () => setPaletteOpen(false));
  ipcMain.on('sb-picture-in-picture', () => { if (UNLOCKED && S.shown) openPictureInPicture(); });
  ipcMain.on('sb-focus-toggle', () => {
    if (!UNLOCKED || !S.shown) return;
    setPanelMode(S.panelMode === 'focus' ? 'overlay' : 'focus');
  });
  ipcMain.on('sb-split-ratio-drag', (_ev, screenX) => {
    if (!UNLOCKED || !S.shown || S.panelMode !== 'split' || !S.parent || S.parent.isDestroyed()) return;
    const bounds = S.parent.getBounds();
    setSplitRatio(1 - ((Number(screenX) - bounds.x) / bounds.width));
  });
  ipcMain.on('sb-open-system', (_ev, u) => { openInSystemBrowser(u); });
  ipcMain.on('sb-copy-url', (_ev, u) => { if (copyUrl(u)) sendStatus('copied URL', 'ok'); });
  ipcMain.on('sb-slack-msg', (_ev, u) => {
    pasteUrlToSlack(u).then((r) => {
      sendStatus(r === 'ok' ? 'pasted into Slack' : (r === 'missing' ? 'copied (composer missing)' : 'copied URL'), r === 'ok' ? 'ok' : 'busy');
    }).catch(() => {});
  });
  ipcMain.on('sb-zoom', (_ev, dir) => {
    const cw = activeWC();
    if (!cw) return;
    try {
      const cur = cw.getZoomFactor();
      const factor = dir === 'in' ? cur * 1.1 : (dir === 'out' ? cur / 1.1 : 1);
      const next = (dir === 'reset') ? 1 : Math.min(3, Math.max(0.25, factor));
      cw.setZoomFactor(next);
      log('ZOOM', dir, '->', next);
    } catch (e) { log('ZOOM err', String(e)); }
  });
}

// ---- parent window discovery
function isSlackMain(win) {
  try {
    const u = (win.webContents && win.webContents.getURL()) || '';
    const b = win.getBounds();
    return /https?:\/\/[^/]*(slack\.(com|gov))/i.test(u) && b.width > 700;
  } catch (_) {
    return false;
  }
}

function bindParent(win) {
  if (S.parent === win) return;
  S.parent = win;
  const relayout = () => { if (S.shown) layout(); };
  ['resize', 'move', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => {
    try { win.on(ev, relayout); } catch (_) {}
  });
  try {
    win.on('closed', () => {
      if (S.parent === win) {
        S.parent = null;
        S.shown = false;
      }
    });
  } catch (_) {}
  // state ticker: keep browser synced to the active conversation
  try {
    win.webContents.on('did-navigate', () => stateTick());
  } catch (_) {}
  log('parent bound', win.id);
}

function scan() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (isSlackMain(w)) { bindParent(w); break; }
    }
  } catch (_) {}
}

function onWindowCreated(win) {
  try {
    if (isSlackMain(win)) { bindParent(win); return; }
    const retry = () => { if (!S.parent || S.parent.isDestroyed()) scan(); };
    retry();
    try { win.webContents.on('did-navigate', retry); win.webContents.on('did-finish-load', retry); } catch (_) {}
    try { win.on('ready-to-show', retry); } catch (_) {}
  } catch (_) {}
}

try {
  app.whenReady().then(() => {
    const st = getStore();
    if (st) {
      try { if (st.listProfiles) st.listProfiles(); } catch (_) {}
      const saved = Number(st.getUI().transparency);
      if (isFinite(saved)) S.opacity = Math.max(20, Math.min(100, saved));
      const al = Number(st.getUI().autolockMin);
      if (isFinite(al) && al >= 0) S.autolockMin = al;
      const ratio = Number(st.getUI().splitRatio);
      if (isFinite(ratio)) S.splitRatio = Math.max(0.2, Math.min(0.7, ratio));
      const mode = st.getUI().panelMode;
      if (['overlay', 'split', 'focus'].includes(mode)) S.panelMode = mode;
      S.contextLinks = st.getUI().contextLinks === true;
      const blk = st.getUI().blocker;
      const b = getBlocker();
      if (b && typeof blk === 'boolean') b.setEnabled(blk);
    }
    bindIPC();
    scan();
    const registered = globalShortcut.register(ACCEL, () => {
      isSelfDMActive().then((isOwnDM) => {
        if (!isOwnDM) { log('activation hotkey ignored outside own DM'); return; }
        if (UNLOCKED) {
          if (S.shown) { manualHide = true; hide(); }
          else { manualHide = false; show(); }
        } else {
          requestUnlock(() => { isSelfDMActive().then((stillOwnDM) => { if (stillOwnDM) show(); }); });
        }
      }).catch((err) => log('activation hotkey err', String(err && err.message)));
    });
    if (!registered) log('activation hotkey could not be registered', ACCEL);
    // secret phrase watcher + renderer Enter-guard install
    setInterval(() => { phraseTick(); stateTick(); }, 400);
    setInterval(() => {
      syncTheme();
      contextLinksTick();
    }, 1400);
    // safety net: keep scanning briefly in case the main window loads late
    let n = 0;
    const iv = setInterval(() => {
      n++;
      if (S.parent && !S.parent.isDestroyed()) { clearInterval(iv); return; }
      scan();
      if (n > 36) clearInterval(iv);
    }, 2500);
  });
  app.on('browser-window-created', (_ev, win) => { try { onWindowCreated(win); } catch (_) {} });
  app.on('will-quit', () => { try { globalShortcut.unregister(ACCEL); } catch (_) {} });
} catch (err) {
  log('boot hook error', err && err.stack);
}

log('sb_main loaded', 'electron', process.versions.electron);
