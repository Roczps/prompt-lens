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
  comfyBaseUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: '',
  comfySteps: 25,
  comfyCfg: 7,
  comfyNegative: '',
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
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}
