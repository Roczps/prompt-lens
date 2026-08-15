// GPT-Image channel. Speaks two wire protocols:
// - OpenAI official: synchronous /images/generations (JSON) and /images/edits (multipart)
// - APIMart relay:   async submit -> poll /tasks/{id} -> download result URLs
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

async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载生成结果失败（HTTP ${res.status}）`);
  const mime = res.headers.get('content-type') || 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
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
    return { images: [await urlToDataUrl(item.url)], text: '' };
  }
  throw new Error('接口未返回图片数据');
}

/**
 * Which wire protocol the configured endpoint speaks:
 * - 'openai': official synchronous images API (generations + edits multipart)
 * - 'apimart': APIMart async task API (submit -> poll /tasks/{id} -> download)
 */
function detectProtocol(settings) {
  if (settings.openaiProtocol === 'openai' || settings.openaiProtocol === 'apimart') {
    return settings.openaiProtocol;
  }
  return apiBase(settings).includes('apimart') ? 'apimart' : 'openai';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APIMART_RESOLUTION = { 512: '1k', '1K': '1k', '2K': '2k', '4K': '4k' };

/**
 * Poll an APIMart task until it finishes. Throws Error with `pending: true`
 * when the deadline passes while the task is still processing, so callers can
 * leave the generation in "running" state and resume polling later (the MV3
 * service worker may be killed at any time).
 */
export async function pollApimartTask(taskId, settings, { deadlineMs = 4 * 60 * 1000 } = {}) {
  const base = apiBase(settings);
  const auth = { Authorization: `Bearer ${settings.openaiApiKey}` };
  const pollMs = settings.pollIntervalMs || 3000;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    // Cheap extension-API call resets the service worker idle timer so Chrome
    // does not reclaim us mid-poll. No-op in test environments.
    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo(() => {});
    }
    const tRes = await fetch(`${base}/tasks/${taskId}`, { headers: auth });
    const tData = await tRes.json().catch(() => ({}));
    if (!tRes.ok) throw new Error(tData?.error?.message || `查询任务失败（HTTP ${tRes.status}）`);
    const task = tData?.data;
    if (task?.status === 'completed') {
      const urls = (task.result?.images || [])
        .flatMap((img) => (Array.isArray(img.url) ? img.url : [img.url]))
        .filter(Boolean);
      if (!urls.length) throw new Error('任务完成但未返回图片');
      const images = [];
      for (const u of urls) images.push(await urlToDataUrl(u));
      return { images, text: '' };
    }
    if (task?.status === 'failed') {
      throw new Error(task?.error?.message || tData?.error?.message || '生成任务失败');
    }
  }
  const err = new Error('任务仍在处理中');
  err.pending = true;
  throw err;
}

async function generateViaApimart({ instruction, aspectRatio, imageSize, refs, onTaskSubmitted }, settings) {
  const base = apiBase(settings);
  const auth = { Authorization: `Bearer ${settings.openaiApiKey}` };

  const body = {
    model: settings.openaiImageModel,
    prompt: instruction,
    n: 1,
    size: aspectRatio || 'auto',
    resolution: APIMART_RESOLUTION[imageSize] || '1k'
  };
  if (refs.length) body.image_urls = refs;

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  const taskId = data?.data?.[0]?.task_id;
  if (!taskId) throw new Error('接口未返回任务号（task_id）');

  if (onTaskSubmitted) await onTaskSubmitted(taskId);
  return pollApimartTask(taskId, settings);
}

export async function generateImageOpenAI(
  { prompt, aspectRatio, imageSize, poseRefDataUrl, styleRefDataUrl, charDataUrl, charDesc, onTaskSubmitted },
  settings
) {
  const instruction = buildGenInstruction({
    hasPose: !!poseRefDataUrl,
    hasStyle: !!styleRefDataUrl,
    hasChar: !!charDataUrl,
    charDesc,
    prompt
  });
  const refs = [poseRefDataUrl, styleRefDataUrl, charDataUrl].filter(Boolean);

  if (detectProtocol(settings) === 'apimart') {
    return generateViaApimart({ instruction, aspectRatio, imageSize, refs, onTaskSubmitted }, settings);
  }

  const size = openaiSize(aspectRatio, imageSize);
  const quality = openaiQuality(imageSize);

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
