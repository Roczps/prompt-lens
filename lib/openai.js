import { dataUrlToBlob, bytesToBase64 } from './util.js';
import { buildGenInstruction } from './gemini.js';

function apiBase(settings) {
  return (settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/**
 * gpt-image-2 accepts arbitrary sizes: edges must be multiples of 16, long/short
 * ratio <= 3:1, total pixels between 655,360 and 8,294,400, max edge < 3840.
 */
export function openaiSize(aspectRatio, tier) {
  const [w, h] = (aspectRatio || '1:1').split(':').map(Number);
  const ratio = Math.max(w, h) / Math.min(w, h);
  const longEdgeByTier = { 512: 1024, '1K': 1024, '2K': 2048, '4K': 3824 };
  let long = longEdgeByTier[tier] || 1024;
  const shortFor = (l) => Math.max(16, Math.round(l / ratio / 16) * 16);
  let short = shortFor(long);
  while (long * short < 655360) {
    long += 16;
    short = shortFor(long);
  }
  while (long * short > 8294400) {
    long -= 16;
    short = shortFor(long);
  }
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

function openaiQuality(tier) {
  return { 512: 'low', '1K': 'medium', '2K': 'high', '4K': 'high' }[tier] || 'auto';
}

async function parseImageResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  const item = data?.data?.[0];
  if (item?.b64_json) {
    return { images: [`data:image/png;base64,${item.b64_json}`], text: '' };
  }
  // Some relay providers return a URL instead of inline base64.
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`下载生成结果失败（HTTP ${imgRes.status}）`);
    const mime = imgRes.headers.get('content-type') || 'image/png';
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    return { images: [`data:${mime};base64,${bytesToBase64(bytes)}`], text: '' };
  }
  throw new Error('接口未返回图片数据');
}

export async function generateImageOpenAI(
  { prompt, aspectRatio, imageSize, poseRefDataUrl, styleRefDataUrl, charDataUrl, charDesc },
  settings
) {
  const size = openaiSize(aspectRatio, imageSize);
  const quality = openaiQuality(imageSize);
  const instruction = buildGenInstruction({
    hasPose: !!poseRefDataUrl,
    hasStyle: !!styleRefDataUrl,
    hasChar: !!charDataUrl,
    charDesc,
    prompt
  });
  const refs = [poseRefDataUrl, styleRefDataUrl, charDataUrl].filter(Boolean);

  let res;
  if (!refs.length) {
    res = await fetch(`${apiBase(settings)}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openaiApiKey}`
      },
      body: JSON.stringify({
        model: settings.openaiImageModel,
        prompt: instruction,
        size,
        quality
      })
    });
  } else {
    const form = new FormData();
    form.append('model', settings.openaiImageModel);
    form.append('prompt', instruction);
    form.append('size', size);
    form.append('quality', quality);
    refs.forEach((dataUrl, i) => form.append('image[]', dataUrlToBlob(dataUrl), `ref${i + 1}.jpg`));
    res = await fetch(`${apiBase(settings)}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.openaiApiKey}` },
      body: form
    });
  }
  return parseImageResponse(res);
}

export async function testOpenAIKey(baseUrl, apiKey) {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return true;
}
