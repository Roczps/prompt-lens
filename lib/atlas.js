// Seedream channel via Atlas Cloud. Same async shape as APIMart:
// submit POST /api/v1/model/generateImage -> { data: { id } }
// poll   GET  /api/v1/model/prediction/{id} until completed/succeeded/failed.
import { urlToDataUrl } from './util.js';
import { buildGenInstruction } from './gemini.js';

const DEFAULT_BASE = 'https://api.atlascloud.ai';

function apiBase(settings) {
  return (settings.atlasBaseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
}

export function normalizeAtlasKey(value) {
  const key = String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!key) throw new Error('未填写 Atlas Cloud API Key，请填写控制台创建的密钥');
  if (/\s/.test(key)) throw new Error('Atlas Cloud API Key 含内部空白或换行，请重新复制完整密钥');
  if (key.startsWith('ak_')) throw new Error('填写的是 API Key 公开 ID（ak_），请使用秘密密钥（apikey-），不是公开 ID');
  return key;
}

function authHeaders(settings) {
  return { Authorization: `Bearer ${normalizeAtlasKey(settings.atlasApiKey)}` };
}

function errorText(data) {
  for (const value of [data?.error?.message, data?.error, data?.msg, data?.message]) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

async function readAtlasResponse(res, stage, settings) {
  const data = await res.json().catch(() => null);
  const apiCode = Number(data?.code);
  if (!res.ok || apiCode >= 400) {
    const status = !res.ok ? res.status : apiCode;
    const detail = errorText(data);
    const hints = {
      401: '鉴权失败：请检查 Atlas Cloud 密钥是否正确、有效，以及请求地址；其他平台的 Seedream Key 不能用于此渠道',
      402: '余额或套餐额度不足',
      403: stage === '连接测试' ? '余额查询被拒绝：此接口需要账户余额读取权限，不能据此判定生图权限' : '请求未获授权，请检查密钥范围及模型权限',
      404: '接口、任务或模型不存在，请检查地址和模型名称',
      429: '请求频率受限，请稍后再试'
    };
    const requestId = res.headers?.get?.('x-request-id') || data?.request_id;
    let message = `Atlas Cloud ${stage}失败（HTTP ${res.status}${res.ok && apiCode >= 400 ? `，API ${apiCode}` : ''}）：${hints[status] || '服务返回错误'}`;
    if (detail) message += `；原始错误：${detail}`;
    if (requestId) message += `；request_id=${requestId}`;
    // Never persist an echoed credential in a generation error/history record.
    const raw = String(settings.atlasApiKey || '').trim();
    const key = normalizeAtlasKey(raw);
    for (const secret of [raw, key]) if (secret) message = message.split(secret).join('[已隐藏密钥]');
    const error = new Error(message);
    error.status = status;
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Atlas Cloud ${stage}返回了无效 JSON 响应`);
  return data;
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

// Seedream 5.0 Pro only accepts an enumerated size list (max 2048*2048 total
// pixels). <=2.36M px bills at the 1.5K tier, larger at the 2K tier.
const SEEDREAM5_SIZES = {
  '1.5K': ['1536*1536', '1776*1328', '1328*1776', '2048*1152', '1152*2048', '1024*1024'],
  '2K': ['2048*2048', '2304*1728', '1728*2304', '2720*1530', '1530*2720', '2496*1664', '1664*2496']
};

function nearestByRatio(sizes, aspectRatio) {
  const [w, h] = (aspectRatio || '1:1').split(':').map(Number);
  const want = w && h ? w / h : 1;
  let best = sizes[0];
  let bestDiff = Infinity;
  for (const size of sizes) {
    const [pw, ph] = size.split('*').map(Number);
    const diff = Math.abs(pw / ph - want);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  return best;
}

/** Map our aspect ratio + tier onto the closest documented Seedream size. */
export function atlasSize(aspectRatio, tier, model = '') {
  if (/v5\.0/.test(model)) {
    const sizes = SEEDREAM5_SIZES[tier === '2K' || tier === '4K' ? '2K' : '1.5K'];
    return nearestByRatio(sizes, aspectRatio);
  }
  const presets = SIZE_PRESETS[tier === '4K' ? '4K' : '2K'];
  if (presets[aspectRatio]) return presets[aspectRatio];
  return nearestByRatio(Object.values(presets), aspectRatio);
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
    const data = await readAtlasResponse(res, '查询任务', settings);
    const pred = data?.data || data;
    if (pred?.status === 'completed' || pred?.status === 'succeeded') {
      const outputs = (pred.outputs || []).filter(Boolean);
      if (!outputs.length) throw new Error('任务完成但未返回图片');
      const images = [];
      for (const out of outputs) images.push(await outputToDataUrl(out));
      return { images, text: '' };
    }
    if (pred?.status === 'failed') {
      throw new Error(errorText(pred) || 'Seedream 生成任务失败');
    }
  }
  const err = new Error('任务仍在处理中');
  err.pending = true;
  throw err;
}

export async function generateImageAtlas(
  { prompt, aspectRatio, imageSize, sourceDataUrl, poseRefDataUrl, styleRefDataUrl, charDataUrl, charDesc, onTaskSubmitted },
  settings
) {
  const faceOnly = !!charDataUrl && !!(sourceDataUrl || poseRefDataUrl || styleRefDataUrl);
  const instruction = faceOnly ? [
    'Edit Image 1. Replace ONLY the facial identity of its main person with the facial identity in Image 2.',
    'Image 1 is the sole reference for the body, body proportions, pose, head position and angle, expression, gaze, hands, clothing, accessories, hairstyle, framing, crop, camera angle, subject placement, background, lighting and colors. Preserve all of these unchanged.',
    'Image 2 is a FACE IDENTITY reference only. Do not copy its body, pose, clothing, accessories, hairstyle, framing or background. Match the new face naturally to the original lighting and skin tone, with seamless edges.',
    'Keep every non-facial region unchanged. Do not redesign the outfit, replace the body, or recompose the image.',
    'The following scene description is context only; ignore any part that conflicts with the face-only edit and preservation rules above:',
    prompt
  ].join('\n') : buildGenInstruction({
    hasPose: !!poseRefDataUrl,
    hasStyle: !!styleRefDataUrl,
    hasChar: !!charDataUrl,
    charDesc,
    prompt
  });
  const refs = faceOnly
    ? [sourceDataUrl || poseRefDataUrl || styleRefDataUrl, charDataUrl]
    : [poseRefDataUrl, styleRefDataUrl, charDataUrl].filter(Boolean);

  const body = {
    model: atlasModelFor(settings.atlasImageModel, refs.length > 0),
    prompt: instruction,
    size: atlasSize(aspectRatio, imageSize, settings.atlasImageModel),
    enable_base64_output: false
  };
  if (refs.length) body.images = refs;

  const res = await fetch(`${apiBase(settings)}/api/v1/model/generateImage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
    body: JSON.stringify(body)
  });
  const data = await readAtlasResponse(res, '提交生成', settings);
  const predictionId = data?.data?.id || data?.id;
  if (!predictionId) throw new Error('接口未返回任务号（prediction id）');

  if (onTaskSubmitted) await onTaskSubmitted(predictionId);
  return pollAtlasPrediction(predictionId, settings);
}

/** Read-only documented endpoint. Success proves this request, not model entitlement. */
export async function testAtlasKey(baseUrl, apiKey) {
  const settings = { atlasBaseUrl: baseUrl, atlasApiKey: apiKey };
  const res = await fetch(`${apiBase(settings)}/public/v1/balance`, {
    headers: authHeaders(settings), signal: AbortSignal.timeout(20000)
  });
  const data = await readAtlasResponse(res, '连接测试', settings);
  if (!Object.keys(data).length) throw new Error('Atlas Cloud 连接测试返回空响应，无法确认鉴权');
  return 'Atlas Cloud 鉴权及余额接口通过；尚未验证 Seedream 生图权限。若修改了 Key，请点击下方“保存设置”后再生成。';
}
