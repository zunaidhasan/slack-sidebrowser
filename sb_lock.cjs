'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SALT_BYTES = 16;
const KEY_BYTES = 64;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, KEY_BYTES);
}

function read(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch (_) {
    return null;
  }
}

function write(file, pin) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const record = {
    algorithm: 'scrypt',
    salt: salt.toString('hex'),
    hash: hashPin(pin, salt).toString('hex'),
    set: new Date().toISOString(),
  };
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(temp); } catch (_) {}
    return false;
  }
}

function verify(file, pin) {
  const record = read(file);
  if (!record) return { ok: false, exists: false, migrated: false };

  if (record.algorithm === 'scrypt' && /^[0-9a-f]{32}$/i.test(record.salt) && /^[0-9a-f]{128}$/i.test(record.hash)) {
    const salt = Buffer.from(record.salt, 'hex');
    const expected = Buffer.from(record.hash, 'hex');
    const actual = hashPin(pin, salt);
    return { ok: crypto.timingSafeEqual(actual, expected), exists: true, migrated: false };
  }

  // Upgrade legacy unsalted SHA-256 records after their first successful unlock.
  if (/^[0-9a-f]{64}$/i.test(record.hash || '')) {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = crypto.createHash('sha256').update(String(pin), 'utf8').digest();
    const ok = crypto.timingSafeEqual(actual, expected);
    if (ok) return { ok: true, exists: true, migrated: write(file, pin) };
    return { ok: false, exists: true, migrated: false };
  }

  return { ok: false, exists: true, migrated: false };
}

module.exports = { read: read, write: write, verify: verify };
