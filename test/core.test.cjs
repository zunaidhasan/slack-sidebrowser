'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../sb_store.cjs');
const lock = require('../sb_lock.cjs');
const search = require('../sb_search.cjs');
const blocker = require('../sb_blocker.cjs');
const tabs = require('../sb_tabs.cjs');
const updater = require('../sb_update.cjs');

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-sidebrowser-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('profiles isolate their partitions and validate home URLs', (t) => {
  const dir = temporaryDirectory(t);
  store.setDir(dir);

  const profiles = store.listProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), ['work', 'personal', 'research']);
  assert.equal(store.partitionFor('research'), 'persist:slack-embedded-browser-research');
  assert.equal(store.setProfileHome('work', 'file:///secret'), null);
  assert.equal(store.setProfileHome('work', 'https://example.com').home, 'https://example.com/');
  assert.equal(store.setActiveProfile('research'), 'research');
  assert.equal(store.getActiveProfileId(), 'research');
});

test('legacy bookmarks migrate into Personal and bookmark caps are enforced', (t) => {
  const dir = temporaryDirectory(t);
  store.setDir(dir);
  fs.writeFileSync(path.join(dir, 'sb_bookmarks.json'), JSON.stringify([{ url: 'https://legacy.example', title: 'Legacy' }]));

  store.listProfiles();
  assert.equal(store.listBookmarks('personal')[0].url, 'https://legacy.example');
  for (let i = 0; i < store.MAX_BOOKMARKS + 3; i++) {
    store.addBookmark('https://example.test/' + i, 'Page ' + i, 'work');
  }
  assert.equal(store.listBookmarks('work').length, store.MAX_BOOKMARKS);
  assert.equal(store.listBookmarks('personal').length, 1);
});

test('removing a profile never removes the last profile', (t) => {
  const dir = temporaryDirectory(t);
  store.setDir(dir);
  store.listProfiles();
  for (const profile of store.listProfiles()) store.removeProfile(profile.id);
  assert.equal(store.listProfiles().length, 1);
});

test('history and downloads retain bounded, updateable per-profile records', (t) => {
  const dir = temporaryDirectory(t);
  store.setDir(dir);
  store.listProfiles();
  for (let i = 0; i < store.MAX_HISTORY + 2; i++) {
    store.addHistory('https://history.example/' + i, 'History ' + i, 'work');
  }
  assert.equal(store.listHistory('work').length, store.MAX_HISTORY);

  store.addDownload({ id: 'download-1', url: 'https://files.example/a.zip', state: 'progressing' }, 'work');
  store.updateDownload('download-1', { state: 'completed', bytes: 42 }, 'work');
  assert.equal(store.listDownloads('work')[0].state, 'completed');
  assert.equal(store.listDownloads('personal').length, 0);
});

test('PIN storage uses scrypt and upgrades legacy SHA-256 records', (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'sb_pin.json');
  assert.equal(lock.write(file, '1234'), true);
  assert.equal(lock.read(file).algorithm, 'scrypt');
  assert.equal(lock.write(file, '4321'), true);
  assert.equal(lock.verify(file, '4321').ok, true);
  assert.equal(lock.verify(file, 'wrong').ok, false);

  const legacyPin = '5678';
  fs.writeFileSync(file, JSON.stringify({
    hash: crypto.createHash('sha256').update(legacyPin).digest('hex'),
    set: new Date().toISOString(),
  }));
  const verified = lock.verify(file, legacyPin);
  assert.equal(verified.ok, true);
  assert.equal(verified.migrated, true);
  assert.equal(lock.read(file).algorithm, 'scrypt');
});

test('tab registry owns active tab state and monotonically unique IDs', () => {
  const registry = tabs.createRegistry();
  const first = { id: registry.nextId() };
  const second = { id: registry.nextId() };
  assert.equal(first.id, 't1');
  assert.equal(registry.add(first), true);
  assert.equal(registry.add(second), true);
  assert.equal(registry.add(first), false);
  registry.all().pop();
  assert.equal(registry.all().length, 2);
  assert.equal(registry.setActive(second.id), second.id);
  assert.equal(registry.find(second.id), second);
  assert.deepEqual(registry.remove(second.id), { tab: second, index: 1 });
  assert.equal(registry.activeId(), null);
  assert.equal(registry.nextId(), 't3');
  registry.clear();
  assert.deepEqual(registry.all(), []);
});

test('updater hashes binary payloads byte-for-byte and normalizes source newlines', (t) => {
  const dir = temporaryDirectory(t);
  const binary = path.join(dir, 'app.new.asar');
  const bytes = Buffer.from([0xff, 0x00, 0x80, 0x0d, 0x0a]);
  fs.writeFileSync(binary, bytes);
  assert.equal(updater.hashFile(binary), crypto.createHash('sha256').update(bytes).digest('hex'));

  const windowsText = path.join(dir, 'source.cjs');
  const unixText = path.join(dir, 'source-copy.cjs');
  fs.writeFileSync(windowsText, 'line one\r\nline two\r\n');
  fs.writeFileSync(unixText, 'line one\nline two\n');
  assert.equal(updater.hashFile(windowsText), updater.hashFile(unixText));
  assert.equal(updater.REPO, 'zunaidhasan/slack-sidebrowser');
});

test('fuzzy search ranks exact and prefix matches before subsequences', () => {
  const items = [
    { title: 'Research notes', url: 'https://example.com' },
    { title: 'Search', url: 'https://search.example' },
    { title: 'Read this', url: 'https://example.com' },
  ];
  assert.deepEqual(search.filterItems(items, 'search').slice(0, 2), [items[1], items[0]]);
  assert.equal(search.score(items[0], 'rsearch') >= 0, true);
  assert.equal(search.score(items[2], 'xyz'), -1);
});

test('blocker honors network rules and exceptions', (t) => {
  const dir = temporaryDirectory(t);
  const list = path.join(dir, 'rules.txt');
  fs.writeFileSync(list, '||ads.example^\n@@||ads.example/allow^\n');
  blocker.loadList(list);
  assert.equal(blocker.shouldBlock('https://ads.example/banner'), true);
  assert.equal(blocker.shouldBlock('https://ads.example/allow/image'), false);
  blocker.setEnabled(false);
  assert.equal(blocker.shouldBlock('https://ads.example/banner'), false);
  blocker.setEnabled(true);
});
