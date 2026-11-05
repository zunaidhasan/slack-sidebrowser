'use strict';

function score(item, q) {
  if (!q) return 0;
  const title = String((item && item.title) || '').toLowerCase();
  const url = String((item && item.url) || '').toLowerCase();
  const query = String(q).toLowerCase().trim();
  if (!query) return 0;
  if (title === query) return 1000;
  if (title.indexOf(query) === 0) return 800;
  if (title.indexOf(query) >= 0) return 500;
  if (url.indexOf(query) >= 0) return 300;
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => title.indexOf(p) >= 0 || url.indexOf(p) >= 0)) return 200;
  const fuzzy = (candidate) => {
    let cursor = 0;
    let gaps = 0;
    let first = -1;
    for (const char of query.replace(/\s+/g, '')) {
      const found = candidate.indexOf(char, cursor);
      if (found < 0) return -1;
      if (first < 0) first = found;
      gaps += found - cursor;
      cursor = found + 1;
    }
    return Math.max(1, 150 - gaps - first);
  };
  const fuzzyTitle = fuzzy(title);
  if (fuzzyTitle >= 0) return fuzzyTitle;
  const fuzzyUrl = fuzzy(url);
  if (fuzzyUrl >= 0) return fuzzyUrl;
  return -1;
}

function filterItems(items, q) {
  const list = Array.isArray(items) ? items : [];
  const query = String(q || '').trim();
  if (!query) return list.slice();
  return list
    .map((item) => ({ item: item, s: score(item, query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.item);
}

module.exports = { filterItems: filterItems, score: score };
