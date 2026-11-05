'use strict';

// Persistence for user data that no update ever overwrites:
//   sb_ui.json              - UI prefs + active profile
//   sb_bookmarks_<id>.json  - bookmarks per profile
//   sb_history_<id>.json    - recent URLs per profile
//   sb_downloads_<id>.json  - download records per profile
// Deliberately free of electron imports so it can be exercised directly with node.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DIR = __dirname;
const MAX_BOOKMARKS = 60;
const MAX_HISTORY = 50;
const MAX_DOWNLOADS = 80;
const DEFAULT_HOME = 'https://duckduckgo.com/';

const DEFAULT_PROFILES = [
  { id: 'work', name: 'Work', home: DEFAULT_HOME, color: '#36c5f0' },
  { id: 'personal', name: 'Personal', home: DEFAULT_HOME, color: '#3ddc97' },
  { id: 'research', name: 'Research', home: DEFAULT_HOME, color: '#f5c451' },
];

function setDir(dir) {
  DIR = dir;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJSON(file, value) {
  try {
    fs.writeFileSync(path.join(DIR, file), JSON.stringify(value), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function norm(u) {
  return String(u || '').toLowerCase().replace(/\/+$/, '');
}

function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || ('p' + crypto.randomBytes(3).toString('hex'));
}

function getUI() {
  const v = readJSON('sb_ui.json', {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function setUI(patch) {
  const v = Object.assign(getUI(), patch && typeof patch === 'object' ? patch : {});
  writeJSON('sb_ui.json', v);
  return v;
}

function sanitizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return null;
  const rawColor = String(p.color || '#36c5f0');
  return {
    id: id,
    name: String(p.name || id).trim().slice(0, 40) || id,
    home: String(p.home || DEFAULT_HOME).trim() || DEFAULT_HOME,
    color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : '#36c5f0',
  };
}

function normalizeHome(home) {
  const value = String(home || DEFAULT_HOME).trim();
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function ensureProfiles() {
  const ui = getUI();
  let list = Array.isArray(ui.profiles) ? ui.profiles.map(sanitizeProfile).filter(Boolean) : [];
  if (!list.length) {
    list = DEFAULT_PROFILES.map((p) => Object.assign({}, p));
    const legacy = readJSON('sb_bookmarks.json', null);
    if (Array.isArray(legacy) && legacy.length) {
      writeJSON('sb_bookmarks_personal.json', legacy.filter((b) => b && typeof b.url === 'string' && b.url));
    }
    setUI({ profiles: list, activeProfile: ui.activeProfile || 'personal' });
    return list;
  }
  return list;
}

function listProfiles() {
  return ensureProfiles();
}

function getProfile(id) {
  const list = ensureProfiles();
  return list.find((p) => p.id === id) || list[0] || DEFAULT_PROFILES[1];
}

function getActiveProfileId() {
  const ui = getUI();
  const list = ensureProfiles();
  const want = String(ui.activeProfile || 'personal');
  if (list.some((p) => p.id === want)) return want;
  return (list[0] && list[0].id) || 'personal';
}

function setActiveProfile(id) {
  const list = ensureProfiles();
  if (!list.some((p) => p.id === id)) return getActiveProfileId();
  setUI({ activeProfile: id });
  return id;
}

function addProfile(opts) {
  const list = ensureProfiles();
  const name = String((opts && opts.name) || 'Profile').trim().slice(0, 40) || 'Profile';
  let id = slug(name);
  let n = 2;
  while (list.some((p) => p.id === id)) { id = slug(name) + '-' + n; n++; }
  const p = sanitizeProfile({
    id: id,
    name: name,
    home: (opts && opts.home) || DEFAULT_HOME,
    color: (opts && opts.color) || '#8fa3b8',
  });
  list.push(p);
  setUI({ profiles: list });
  return p;
}

function removeProfile(id) {
  const list = ensureProfiles();
  if (list.length <= 1) return list;
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return list;
  const patch = { profiles: next };
  if (getActiveProfileId() === id) patch.activeProfile = next[0].id;
  setUI(patch);
  return next;
}

function setProfileHome(id, home) {
  const list = ensureProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const normalized = normalizeHome(home);
  if (!normalized) return null;
  p.home = normalized;
  setUI({ profiles: list });
  return p;
}

function renameProfile(id, name) {
  const list = ensureProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const normalized = String(name || '').trim().slice(0, 40);
  if (!normalized) return null;
  p.name = normalized;
  setUI({ profiles: list });
  return p;
}

function setProfileColor(id, color) {
  const list = ensureProfiles();
  const p = list.find((x) => x.id === id);
  if (!p || !/^#[0-9a-f]{6}$/i.test(String(color || ''))) return null;
  p.color = String(color).toLowerCase();
  setUI({ profiles: list });
  return p;
}

function partitionFor(id) {
  const pid = id || getActiveProfileId();
  return 'persist:slack-embedded-browser-' + pid;
}

function bmFile(id) {
  return 'sb_bookmarks_' + (id || getActiveProfileId()) + '.json';
}

function listBookmarks(id) {
  ensureProfiles();
  const v = readJSON(bmFile(id), []);
  if (!Array.isArray(v)) return [];
  return v.filter((b) => b && typeof b.url === 'string' && b.url);
}

function addBookmark(url, title, id) {
  url = String(url || '').trim();
  if (!url) return { list: listBookmarks(id), added: false };
  const all = listBookmarks(id);
  const key = norm(url);
  const existing = all.findIndex((b) => norm(b.url) === key);
  const clean = String(title || '').trim().slice(0, 80) || url;
  if (existing >= 0) {
    all[existing].title = clean;
    writeJSON(bmFile(id), all);
    return { list: all, added: false, existed: true };
  }
  all.unshift({ url: url, title: clean, added: new Date().toISOString() });
  while (all.length > MAX_BOOKMARKS) all.pop();
  writeJSON(bmFile(id), all);
  return { list: all, added: true };
}

function removeBookmark(url, id) {
  const key = norm(url);
  const all = listBookmarks(id);
  const next = all.filter((b) => norm(b.url) !== key);
  writeJSON(bmFile(id), next);
  return next;
}

function histFile(id) {
  return 'sb_history_' + (id || getActiveProfileId()) + '.json';
}

function listHistory(id) {
  const v = readJSON(histFile(id), []);
  if (!Array.isArray(v)) return [];
  return v.filter((h) => h && typeof h.url === 'string' && h.url);
}

function addHistory(url, title, id) {
  url = String(url || '').trim();
  if (!url) return listHistory(id);
  const all = listHistory(id);
  const key = norm(url);
  const next = all.filter((h) => norm(h.url) !== key);
  next.unshift({
    url: url,
    title: String(title || '').trim().slice(0, 80) || url,
    at: new Date().toISOString(),
  });
  while (next.length > MAX_HISTORY) next.pop();
  writeJSON(histFile(id), next);
  return next;
}

function dlFile(id) {
  return 'sb_downloads_' + (id || getActiveProfileId()) + '.json';
}

function listDownloads(id) {
  const v = readJSON(dlFile(id), []);
  if (!Array.isArray(v)) return [];
  return v.filter((d) => d && typeof d.url === 'string');
}

function addDownload(rec, id) {
  if (!rec || typeof rec !== 'object') return listDownloads(id);
  const all = listDownloads(id);
  const item = {
    id: String(rec.id || ('d' + Date.now())),
    url: String(rec.url || ''),
    filename: String(rec.filename || rec.url || 'download').slice(0, 160),
    state: String(rec.state || 'progressing'),
    bytes: Number(rec.bytes) || 0,
    total: Number(rec.total) || 0,
    path: String(rec.path || ''),
    at: rec.at || new Date().toISOString(),
  };
  const idx = all.findIndex((d) => d.id === item.id);
  if (idx >= 0) all[idx] = Object.assign(all[idx], item);
  else all.unshift(item);
  while (all.length > MAX_DOWNLOADS) all.pop();
  writeJSON(dlFile(id), all);
  return all;
}

function updateDownload(idOrRec, patch, profileId) {
  const id = typeof idOrRec === 'string' ? idOrRec : (idOrRec && idOrRec.id);
  if (!id) return listDownloads(profileId);
  const all = listDownloads(profileId);
  const idx = all.findIndex((d) => d.id === id);
  if (idx < 0) return all;
  all[idx] = Object.assign(all[idx], patch && typeof patch === 'object' ? patch : {});
  writeJSON(dlFile(profileId), all);
  return all;
}

module.exports = {
  setDir: setDir,
  listBookmarks: listBookmarks,
  addBookmark: addBookmark,
  removeBookmark: removeBookmark,
  getUI: getUI,
  setUI: setUI,
  listProfiles: listProfiles,
  getProfile: getProfile,
  getActiveProfileId: getActiveProfileId,
  setActiveProfile: setActiveProfile,
  addProfile: addProfile,
  removeProfile: removeProfile,
  setProfileHome: setProfileHome,
  renameProfile: renameProfile,
  setProfileColor: setProfileColor,
  partitionFor: partitionFor,
  listHistory: listHistory,
  addHistory: addHistory,
  listDownloads: listDownloads,
  addDownload: addDownload,
  updateDownload: updateDownload,
  MAX_BOOKMARKS: MAX_BOOKMARKS,
  MAX_HISTORY: MAX_HISTORY,
  DEFAULT_HOME: DEFAULT_HOME,
};
