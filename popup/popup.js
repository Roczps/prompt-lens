import { getSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function openSidePanel() {
  const tabId = await currentTabId();
  if (tabId != null) await chrome.sidePanel.open({ tabId }).catch(() => {});
}

function analyzeFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    chrome.runtime.sendMessage({
      type: 'ANALYZE_DATA',
      payload: { dataUrl: reader.result, name: file.name || '' }
    });
    window.close();
  };
  reader.readAsDataURL(file);
}

async function init() {
  const settings = await getSettings();
  $('key-warning').classList.toggle('hidden', !!settings.apiKey);

  const openOptions = () => chrome.runtime.openOptionsPage();
  $('btn-settings').addEventListener('click', openOptions);
  $('link-options').addEventListener('click', (e) => {
    e.preventDefault();
    openOptions();
  });

  const zone = $('dropzone');
  const fileInput = $('file-input');
  // chrome.sidePanel.open() only works inside a user-gesture context, so the
  // panel must be opened synchronously in these handlers -- not after the
  // async FileReader finishes.
  zone.addEventListener('click', () => {
    openSidePanel();
    fileInput.click();
  });
  fileInput.addEventListener('change', () => analyzeFile(fileInput.files[0]));

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    openSidePanel();
    analyzeFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      openSidePanel();
      analyzeFile(item.getAsFile());
    }
  });

  $('btn-sidepanel').addEventListener('click', async () => {
    await openSidePanel();
    window.close();
  });
}

init();
