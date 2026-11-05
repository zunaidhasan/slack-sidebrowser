'use strict';
const { ipcRenderer } = require('electron');
window.sbSend = (ch, v) => { try { console.log('preload send', ch); ipcRenderer.send(ch, v); } catch (e) { console.error('preload send err', e && e.message); } };
window.sbInvoke = (ch, v) => ipcRenderer.invoke(ch, v);
window.sbOnUpdate = (cb) => { ipcRenderer.on('sb-update', (_e, info) => { try { cb(info); } catch (e) {} }); };
window.sbOnStatus = (cb) => { ipcRenderer.on('sb-update-status', (_e, s) => { try { cb(s); } catch (e) {} }); };
window.sbOnPalette = (cb) => { ipcRenderer.on('sb-palette', (_e, s) => { try { cb(s); } catch (e) {} }); };
window.sbOnTheme = (cb) => { ipcRenderer.on('sb-theme', (_e, theme) => { try { cb(theme); } catch (e) {} }); };
window.sbOnDownloadProgress = (cb) => { ipcRenderer.on('sb-download-progress', (_e, progress) => { try { cb(progress); } catch (e) {} }); };