// Seedream channel via Atlas Cloud. Same async shape as APIMart:
// submit POST /api/v1/model/generateImage -> { data: { id } }
// poll   GET  /api/v1/model/prediction/{id} until completed/succeeded/failed.
import { urlToDataUrl } from './util.js';
import { buildGenInstruction } from './gemini.js';

const DEFAULT_BASE = 'https://api.atlascloud.ai';

function apiBase(settings) {
  return (settings.atlasBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function authHeaders(settings) {
  return { Authorization: `Bearer ${settings.atlasApiKey}` };
}

// Documented Seedream v4.5 preset resolutions (2K / 4K tiers). Seedream v4
// accepts arbitrary sizes in the 1024-4096 range, so the presets are valid
// for every model variant.
const SIZE_PRESETS = {
  '2K': {
    '1:1': '2048*2048',
    '4:3': '2304*1728',
    '3:4': '1728*2304',
    '16:9': '2848*1600',
    '9:16': '1600*2848',
    '3:2': '2496*1664',
    '2:3': '1664*2496',
    '21:9': '3136*1344'
  },
  '4K': {
    '1:1': '4096*4096',
    '4:3': '4704*3520',
    '3:4': '3520*4704',
    '16:9': '5504*3040',
    '9:16': '3040*5504',
    '3:2': '4992*3328',
    '2:3': '3328*4992',
    '21:9': '6240*2656'
  }
};

/** Map our aspect ratio + tier onto the closest documented Seedream size. */
export function atlasSize(aspectRatio, tier) {
  const presets = SIZE_PRESETS[tier === '4K' ? '4K' : '2K'];
  if (presets[aspectRatio]) return presets[aspectRatio];
  const [w, h] = (aspectRatio || '1:1').split(':').map(Number);
  const want = w && h ? w / h : 1;
  let best = presets['1:1'];
  let bestDiff = Infinity;
  for (const size of Object.values(presets)) {
    const [pw, ph] = size.split('*').map(Number);
    const diff = Math.abs(pw / ph - want);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  return best;
}

/**
 * Reference images require the model's edit variant:
 *   bytedance/seedream-v4.5           -> bytedance/seedream-v4.5/edit
 *   bytedance/seedream-v5.0-pro/text-to-image -> bytedance/seedream-v5.0-pro/edit
 */
export function atlasModelFor(model, hasRefs) {
  if (!hasRefs) return model;
  if (model.endsWith('/edit')) return model;
  if (model.endsWith('/text-to-image')) return model.replace(/\/text-to-image$/, '/edit');
  return `${model}/edit`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function outputToDataUrl(output) {
  if (typeof output !== 'string' || !output) throw new Error('接口返回了空的生成结果');
  if (output.startsWith('data:')) return output;
  if (/^https?:\/\//.test(output)) return urlToDataUrl(output);
  // enable_base64_output returns bare base64 without a dataURL header.
  return `data:image/png;base64,${output}`;
}

/**
 * Poll an Atlas Cloud prediction until it finishes. Throws Error with
 * `pending: true` when the deadline passes while still processing, so the
 * generation stays "running" and the resume alarm keeps polling after the
 * MV3 service worker is reclaimed.
 */
export async function pollAtlasPrediction(predictionId, settings, { deadlineMs = 4 * 60 * 1000 } = {}) {
  const base = apiBase(settings);
  const pollMs = settings.pollIntervalMs || 3000;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo(() => {});
    }
    const res = await fetch(`${base}/api/v1/model/prediction/${predictionId}`, {
      headers: authHeaders(settings)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || data?.message || `查询任务失败（HTTP ${res.status}）`);
    const pred = data?.data || data;
    if (pred?.status === 'completed' || pred?.status === 'succeeded') {
      const outputs = (pred.outputs || []).filter(Boolean);
      if (!outputs.length) throw new Error('任务完成但未返回图片');
      const images = [];
      for (const out of outputs) images.push(await outputToDataUrl(out));
      return { images, text: '' };
    }
    if (pred?.status === 'failed') {
      throw new Error(pred?.error || 'Seedream 生成任务失败');
    }
  }
  const err = new Error('任务仍在处理中');
  err.pending = true;
  throw err;
}

export async function generateImageAtlas(
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

  const body = {
    model: atlasModelFor(settings.atlasImageModel, refs.length > 0),
    prompt: instruction,
    size: atlasSize(aspectRatio, imageSize),
    enable_base64_output: false
  };
  if (refs.length) body.images = refs;

  const res = await fetch(`${apiBase(settings)}/api/v1/model/generateImage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  const predictionId = data?.data?.id;
  if (!predictionId) throw new Error('接口未返回任务号（prediction id）');

  if (onTaskSubmitted) await onTaskSubmitted(predictionId);
  return pollAtlasPrediction(predictionId, settings);
}

/** Cheap auth check: an authorized key gets 404 for a bogus prediction id. */
export async function testAtlasKey(baseUrl, apiKey) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/model/prediction/plens-key-check`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (res.status === 401 || res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || data?.message || 'API Key 无效或未授权');
  }
  return true;
}
