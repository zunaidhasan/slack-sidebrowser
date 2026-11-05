'use strict';

function createRegistry() {
  let tabs = [];
  let activeId = null;
  let nextId = 0;

  return {
    all: function () { return tabs.slice(); },
    activeId: function () { return activeId; },
    setActive: function (id) {
      activeId = id && tabs.some((tab) => tab.id === id) ? id : null;
      return activeId;
    },
    find: function (id) { return tabs.find((tab) => tab.id === id) || null; },
    add: function (tab) {
      if (!tab || !tab.id || tabs.some((item) => item.id === tab.id)) return false;
      tabs.push(tab);
      return true;
    },
    remove: function (id) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return null;
      const result = { tab: tabs[index], index: index };
      tabs.splice(index, 1);
      if (activeId === id) activeId = null;
      return result;
    },
    clear: function () {
      tabs = [];
      activeId = null;
    },
    nextId: function () { return 't' + (++nextId); },
  };
}

module.exports = { createRegistry: createRegistry };
