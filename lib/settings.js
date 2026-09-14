export const DEFAULT_SETTINGS = {
  apiKey: '',
  analysisModel: 'gemini-flash-latest',
  imageModel: 'gemini-3.1-flash-image',
  imageProvider: 'gemini',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.apimart.ai/v1',
  openaiImageModel: 'gpt-image-2',
  openaiProtocol: 'auto',
  atlasApiKey: '',
  atlasImageModel: 'bytedance/seedream-v5.0-pro/text-to-image',
  grokBaseUrl: 'http://127.0.0.1:8000/v1',
  grokApiKey: '',
  grokImageModel: 'grok-imagine-image',
  grokEditModel: 'grok-imagine-image-edit',
  grokEditProtocol: 'json',
  grokEndpointRevision: 0,
  flowagentBaseUrl: 'http://127.0.0.1:8001',
  flowagentModel: '',
  videoDuration: 8,
  aspectRatio: '1:1',
  imageSize: '1K',
  ballEnabled: true,
  minImageSize: 120
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (stored.grokEndpointRevision < 1 && /^http:\/\/(?:127\.0\.0\.1|localhost):8011(?:\/v1)?\/?$/.test(stored.grokBaseUrl || '')) {
    stored.grokBaseUrl = DEFAULT_SETTINGS.grokBaseUrl;
    stored.grokEditProtocol = 'json';
    stored.grokEndpointRevision = 1;
    await chrome.storage.sync.set({ grokBaseUrl: stored.grokBaseUrl, grokEditProtocol: 'json', grokEndpointRevision: 1 });
  }
  return { ...DEFAULT_SETTINGS, ...stored, imageProvider: stored.imageProvider === 'comfy' ? 'grok' : (stored.imageProvider || DEFAULT_SETTINGS.imageProvider) };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(Object.hasOwn(patch, 'grokBaseUrl') ? { ...patch, grokEndpointRevision: 1 } : patch);
}
