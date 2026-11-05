'use strict';

// Built-in EasyList-style network filter for the embedded browser partition.
// No Electron imports so node can unit-test it.

const fs = require('fs');

let enabled = true;
let rules = [];
let exceptions = [];

function reset() {
  rules = [];
  exceptions = [];
}

function compile(line) {
  line = String(line || '').trim();
  if (!line || line[0] === '!' || line[0] === '[') return null;
  if (line.indexOf('##') >= 0 || line.indexOf('#@#') >= 0 || line.indexOf('#?#') >= 0) return null;
  let except = false;
  if (line.indexOf('@@') === 0) { except = true; line = line.slice(2); }
  line = line.replace(/\$[^$]*$/, '');
  if (!line) return null;
  let s = '';
  if (line.slice(0, 2) === '||') {
    s += '(?:^https?:\\/\\/)(?:[^\\/]*\\.)?';
    line = line.slice(2);
  } else if (line[0] === '|') {
    s += '^';
    line = line.slice(1);
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '*') s += '.*';
    else if (c === '^') s += '(?:[\\/:?&=]|$)';
    else if (c === '|') s += '$';
    else if (/[.?+()[\]{}\\]/.test(c)) s += '\\' + c;
    else s += c;
  }
  try {
    return { except: except, re: new RegExp(s, 'i') };
  } catch (_) {
    return null;
  }
}

function loadList(file) {
  reset();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return 0; }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const r = compile(line);
    if (!r) continue;
    if (r.except) exceptions.push(r.re);
    else rules.push(r.re);
  }
  return rules.length + exceptions.length;
}

function setEnabled(v) {
  enabled = !!v;
  return enabled;
}

function isEnabled() {
  return enabled;
}

function shouldBlock(url) {
  if (!enabled) return false;
  const u = String(url || '');
  if (!u) return false;
  for (let i = 0; i < exceptions.length; i++) {
    if (exceptions[i].test(u)) return false;
  }
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].test(u)) return true;
  }
  return false;
}

module.exports = {
  loadList: loadList,
  setEnabled: setEnabled,
  isEnabled: isEnabled,
  shouldBlock: shouldBlock,
  compile: compile,
};
