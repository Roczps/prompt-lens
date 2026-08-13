export const DEFAULT_SETTINGS = {
  apiKey: '',
  analysisModel: 'gemini-flash-latest',
  imageModel: 'gemini-3.1-flash-image',
  aspectRatio: '1:1',
  imageSize: '1K',
  ballEnabled: true,
  minImageSize: 120
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}
