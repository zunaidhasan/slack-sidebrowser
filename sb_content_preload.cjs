'use strict';
const { ipcRenderer } = require('electron');

try { ipcRenderer.send('sb-preload-ready'); } catch (_) {}

function send(dir) {
  try { ipcRenderer.send('sb-zoom', dir); } catch (_) {}
}

// Ctrl/Cmd + wheel zoom (direction from renderer WheelEvent.deltaY)
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    try { e.preventDefault(); } catch (_) {}
    try { e.stopPropagation(); } catch (_) {}
    send(e.deltaY > 0 ? 'out' : 'in');
  }
}, { passive: false, capture: true });

// Ctrl/Cmd keyboard zoom shortcuts
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '+' || e.key === '=' || e.key === 'Add') { e.preventDefault(); send('in'); }
  else if (e.key === '-' || e.key === 'Subtract') { e.preventDefault(); send('out'); }
  else if (e.key === '0') { e.preventDefault(); send('reset'); }
}, { capture: true });