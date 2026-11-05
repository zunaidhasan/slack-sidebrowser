'use strict';

// Self-update helper for Slack Browser.
// Deliberately free of electron imports so it can be exercised directly with node:
//   node -e "require('sb_update.cjs').checkAndApply(dir, console.log)"

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');

const REPO = 'zunaidhasan/slack-sidebrowser';
const BRANCH = 'main';
const ZIP_URL = 'https://github.com/' + REPO + '/releases/latest/download/slack-browser-install.zip';
const INSTALLER_URL = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/install.ps1';

// keep in sync with apply-store-patch.ps1 and install.ps1
const FILES = [
  'apply-store-patch.ps1',
  'apply-msix-patch.ps1',
  'sb_main.js',
  'sb_update.cjs',
  'sb_store.cjs',
  'sb_lock.cjs',
  'sb_tabs.cjs',
  'sb_blocker.cjs',
  'sb_search.cjs',
  'sb_easylist.txt',
  'sb_content_preload.cjs',
  'sb_preload.cjs',
  'sb_toolbar.html',
  'sb_toolbar_preload.cjs',
  'sb_unlock.html',
  'sb_settings.html',
  'sb_phrase.html',
  'sb_onboarding.html',
  'uninstall.ps1',
];

// critical files that must exist for the UI to work
const CRITICAL_FILES = ['sb_settings.html', 'sb_main.js', 'sb_store.cjs', 'sb_lock.cjs', 'sb_tabs.cjs', 'sb_update.cjs', 'sb_onboarding.html'];
const PAYLOAD_FILE = 'work/app.new.asar';

let busy = false;

// Compare on content, not bytes: a checkout with CRLF must not look like an update.
function hash(p) {
  const contents = fs.readFileSync(p);
  if (!/\.(?:cjs|js|ps1|html|txt)$/i.test(p)) {
    return crypto.createHash('sha256').update(contents).digest('hex');
  }
  const text = contents.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function getBuf(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(err); return; }
    if (target.protocol !== 'https:') { reject(new Error('refusing non-HTTPS download URL')); return; }
    const req = https.get(target, { headers: { 'User-Agent': 'slack-browser-updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, target);
        if (next.protocol !== 'https:') return reject(new Error('refusing non-HTTPS redirect'));
        return resolve(getBuf(next.toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

// Release assets contain the built app payload, including app.new.asar; it is
// intentionally not committed to the source repository.
async function fetchZip(dest) {
  const [zip, sums] = await Promise.all([
    getBuf(ZIP_URL),
    getBuf('https://github.com/' + REPO + '/releases/latest/download/SHA256SUMS.txt'),
  ]);
  const match = sums.toString('utf8').match(/^([0-9a-f]{64})\s+\*?slack-browser-install\.zip\s*$/im);
  if (!match) throw new Error('release checksum is missing the installer package entry');
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== match[1].toLowerCase()) throw new Error('release package checksum mismatch');
  fs.writeFileSync(dest, zip);
}

function extract(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + dest + "' -Force"],
      { windowsHide: true, timeout: 120000 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
        resolve(dest);
      }
    );
  });
}

// --- self-bootstrapping: download and run the installer ---
// This is the most reliable update path: the installer handles everything
// (downloads latest zip, copies all files, patches Slack, restarts Slack).
// Even old updaters can trigger this because it only needs install.ps1.
async function runInstaller(modDir, onStatus) {
  const say = (text, kind) => { try { if (onStatus) onStatus({ text: text, kind: kind || 'info' }); } catch (_) {} };
  try {
    say('downloading installer...', 'busy');
    const buf = await getBuf(INSTALLER_URL + '?cb=' + Date.now());
    const installPath = path.join(os.tmpdir(), 'sb-install-' + Date.now() + '.ps1');
    fs.writeFileSync(installPath, buf);
    say('launching installer (UAC prompt)...', 'busy');
    // run with elevation via PowerShell Start-Process -Verb RunAs
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      'Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \\"' + installPath + '\\" -HomeDir \\"' + modDir + '\\""'
    ], { windowsHide: true }, (err) => {
      if (err) { try { say('installer launch failed', 'err'); } catch (_) {} }
    });
    say('installer launched - Slack will restart', 'ok');
    return { state: 'installer', changed: [] };
  } catch (e) {
    const msg = String((e && e.message) || e);
    say('installer failed: ' + msg.slice(0, 80), 'err');
    return { state: 'error', error: msg };
  }
}

async function checkAndApply(modDir, onStatus) {
  const say = (text, kind) => { try { if (onStatus) onStatus({ text: text, kind: kind || 'info' }); } catch (_) {} };
  if (busy) { say('already checking', 'busy'); return { state: 'busy' }; }
  busy = true;
  let tmp = null;
  try {
    // --- self-check: if critical files are missing, this updater is too old ---
    // run the installer which handles everything (downloads latest, copies all files)
    const missingCritical = CRITICAL_FILES.filter((f) => !fs.existsSync(path.join(modDir, f)));
    if (missingCritical.length > 0) {
      say('missing files: ' + missingCritical.join(', '), 'busy');
      say('launching full installer...', 'busy');
      return await runInstaller(modDir, onStatus);
    }

    say('checking GitHub...', 'busy');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-update-'));
    const zip = path.join(tmp, 'pkg.zip');
    await fetchZip(zip);

    const src0 = path.join(tmp, 'x');
    await extract(zip, src0);
    // unwrap: the zipball (codeload) wraps the tree in a project-sha folder,
    // and a nested slack-browser-install.zip may also be present
    let src = src0;
    if (!fs.existsSync(path.join(src, 'apply-store-patch.ps1'))) {
      const inner = (function find(dir) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name === 'slack-browser-install.zip') return full;
            if (e.isDirectory()) { const r = find(full); if (r) return r; }
          }
        } catch (_) {}
        return null;
      })(src0);
      if (inner) {
        const x2 = path.join(tmp, 'x2');
        fs.mkdirSync(x2, { recursive: true });
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Expand-Archive -LiteralPath '" + inner + "' -DestinationPath '" + x2 + "' -Force"],
          { windowsHide: true, timeout: 120000 }, () => {});
        const deadline = Date.now() + 120000;
        while (!fs.existsSync(path.join(x2, 'apply-store-patch.ps1')) && Date.now() < deadline) {
          const t0 = Date.now(); while (Date.now() - t0 < 50) {}
        }
        if (fs.existsSync(path.join(x2, 'apply-store-patch.ps1'))) src = x2;
      }
    }
    if (!fs.existsSync(path.join(src, 'apply-store-patch.ps1'))) {
      const dir = (function findDir(dir) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            if (fs.existsSync(path.join(full, 'apply-store-patch.ps1'))) return full;
            const r = findDir(full); if (r) return r;
          }
        } catch (_) {}
        return null;
      })(src0);
      if (dir) src = dir;
    }

    const missing = FILES.concat(PAYLOAD_FILE).filter((f) => !fs.existsSync(path.join(src, f)));
    if (missing.length) {
      // if files are missing from the zip, the updater is too old or the zip is broken
      // fall back to running the installer
      say('package incomplete: ' + missing.join(', '), 'err');
      say('launching full installer...', 'busy');
      return await runInstaller(modDir, onStatus);
    }

    const changed = [];
    for (const f of FILES.concat(PAYLOAD_FILE)) {
      const want = hash(path.join(src, f));
      const local = path.join(modDir, f);
      const have = fs.existsSync(local) ? hash(local) : null;
      if (want !== have) changed.push(f);
    }

    if (!changed.length) { say('up to date', 'ok'); return { state: 'current', changed: [] }; }

    for (const f of changed) {
      const from = path.join(src, f);
      fs.copyFileSync(from, path.join(modDir, f));
      const dist = path.join(modDir, 'distribute', f);
      if (fs.existsSync(path.dirname(dist))) {
        try { fs.copyFileSync(from, dist); } catch (_) {}
      }
    }

    // sb_toolbar.html is pure markup/CSS/JS loaded via loadFile() at runtime, so
    // it can be hot-reloaded without a Slack restart. Everything else (main
    // process code, preloads, patchers) is cached at boot and needs a restart.
    const needRestart = changed.some((f) => f !== 'sb_toolbar.html');

    if (needRestart) say('updated ' + changed.length + ' file(s) - restarting Slack', 'ok');
    else say('updated ' + changed.length + ' file(s) - no restart needed', 'ok');
    return { state: 'updated', changed: changed, needRestart: needRestart };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // if the updater itself is broken, fall back to the installer
    say('update failed, launching installer...', 'err');
    return await runInstaller(modDir, onStatus);
  } finally {
    busy = false;
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  }
}

module.exports = {
  checkAndApply: checkAndApply,
  FILES: FILES,
  ZIP_URL: ZIP_URL,
  REPO: REPO,
  BRANCH: BRANCH,
  hashFile: hash,
};