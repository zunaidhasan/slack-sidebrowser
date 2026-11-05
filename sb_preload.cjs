'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sb', {
  submit: (pin) => ipcRenderer.invoke('sb-pin-submit', String(pin || '')),
  phraseGet: () => ipcRenderer.invoke('sb-phrase-get'),
  phraseSet: (phrase) => ipcRenderer.invoke('sb-phrase-set', String(phrase || '')),
  onboardingState: () => ipcRenderer.invoke('sb-onboarding-state'),
  onboardingFinish: (profileId) => ipcRenderer.invoke('sb-onboarding-finish', String(profileId || '')),
  onboardingSkip: () => ipcRenderer.send('sb-onboarding-skip'),
});
