// Local ComfyUI channel (open-source models on the user's own machine).
// Wire protocol: POST /prompt with a workflow graph -> { prompt_id },
// poll GET /history/{prompt_id} until outputs appear, download each image
// via GET /view. Two built-in graphs: classic checkpoint txt2img, and
// Z-Image Turbo (diffusion model + Qwen3-4B text encoder + Flux AE).
// Reference images can be added later through /upload/image + img2img.
import { bytesToBase64 } from './util.js';

function apiBase(settings) {
  return (settings.comfyBaseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

// Local GPUs choke on huge latents; keep the long edge modest per tier.
const LONG_EDGE = { 512: 512, '1K': 1024, '2K': 1536, '4K': 2048 };

/** SD latent sizes must be multiples of 8. */
export function comfySize(aspectRatio, tier) {
  const [w, h] = (aspectRatio || '1:1').split(':').map(Number);
  const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 1;
  const long = LONG_EDGE[tier] || 1024;
  const short = Math.max(64, Math.round(long / ratio / 8) * 8);
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

const DEFAULT_NEGATIVE =
  'lowres, bad anatomy, bad hands, missing fingers, extra digits, watermark, signature, text, jpeg artifacts';

/** Plain txt2img graph (checkpoint -> CLIP encode -> KSampler -> VAE -> save). */
export function buildComfyWorkflow({ prompt, width, height }, settings) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  return {
    4: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: settings.comfyCheckpoint }
    },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 }
    },
    6: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['4', 1] }
    },
    7: {
      class_type: 'CLIPTextEncode',
      inputs: { text: settings.comfyNegative || DEFAULT_NEGATIVE, clip: ['4', 1] }
    },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: Number(settings.comfySteps) || 25,
        cfg: Number(settings.comfyCfg) || 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0]
      }
    },
    8: {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] }
    },
    9: {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'PromptLens' }
    }
  };
}

/** Z-Image models live in models/diffusion_models and need their own graph. */
export function isZImageModel(name) {
  return /z[-_]?image/i.test(name || '');
}

/**
 * Z-Image Turbo graph, mirroring the official ComfyUI template:
 * UNETLoader + CLIPLoader(qwen_3_4b, type lumina2) + Flux AE, 16-channel
 * latent, AuraFlow shift 3. The model is step-distilled: 9 steps / CFG 1.0
 * is the sweet spot, so the user's comfySteps/comfyCfg are ignored here
 * (higher values burn the image).
 */
export function buildZImageWorkflow({ prompt, width, height, clipName, vaeName }, settings) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  return {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: settings.comfyCheckpoint, weight_dtype: 'default' }
    },
    2: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clipName, type: 'lumina2' }
    },
    3: {
      class_type: 'VAELoader',
      inputs: { vae_name: vaeName }
    },
    4: {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { shift: 3, model: ['1', 0] }
    },
    5: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['2', 0] }
    },
    6: {
      // CFG 1.0 effectively disables guidance; empty negative keeps it fast.
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['2', 0] }
    },
    7: {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: 1 }
    },
    8: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 9,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['4', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['7', 0]
      }
    },
    9: {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['3', 0] }
    },
    10: {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'PromptLens' }
    }
  };
}

async function loaderOptions(base, node, field) {
  const res = await fetch(`${base}/object_info/${node}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const list = data?.[node]?.input?.required?.[field]?.[0] || [];
  return Array.isArray(list) ? list : [];
}

/** Find the Qwen3-4B text encoder and Flux AE that Z-Image needs. */
async function resolveZImageAux(base) {
  const [clips, vaes] = await Promise.all([
    loaderOptions(base, 'CLIPLoader', 'clip_name'),
    loaderOptions(base, 'VAELoader', 'vae_name')
  ]);
  const clipName = clips.find((n) => /qwen_3_4b/i.test(n)) || clips.find((n) => /qwen/i.test(n));
  const vaeName =
    vaes.find((n) => /(^|[\\/])ae\.safetensors$/i.test(n)) || vaes.find((n) => /z.?image/i.test(n));
  if (!clipName) {
    throw new Error('ComfyUI 缺少 Z-Image 文本编码器（qwen_3_4b.safetensors，应放在 models/text_encoders）');
  }
  if (!vaeName) {
    throw new Error('ComfyUI 缺少 Z-Image VAE（ae.safetensors，应放在 models/vae）');
  }
  return { clipName, vaeName };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function viewToDataUrl(base, img) {
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || '',
    type: img.type || 'output'
  });
  const res = await fetch(`${base}/view?${params}`);
  if (!res.ok) throw new Error(`下载 ComfyUI 结果失败（HTTP ${res.status}）`);
  const mime = res.headers.get('content-type') || 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function historyError(entry) {
  const messages = entry?.status?.messages || [];
  for (const [kind, payload] of messages) {
    if (kind === 'execution_error') {
      return payload?.exception_message || 'ComfyUI 执行出错';
    }
  }
  return null;
}

/**
 * Poll a ComfyUI prompt until history has its outputs. Throws Error with
 * `pending: true` on deadline so the generation can resume after the MV3
 * service worker restarts (prompt_id persists on the gen record).
 */
export async function pollComfyHistory(promptId, settings, { deadlineMs = 4 * 60 * 1000 } = {}) {
  const base = apiBase(settings);
  const pollMs = settings.pollIntervalMs || 2000;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo(() => {});
    }
    const res = await fetch(`${base}/history/${promptId}`);
    if (!res.ok) throw new Error(`查询 ComfyUI 任务失败（HTTP ${res.status}）`);
    const data = await res.json().catch(() => ({}));
    const entry = data?.[promptId];
    if (!entry) continue; // still queued or executing

    const errMsg = historyError(entry);
    if (errMsg) throw new Error(errMsg);

    const images = [];
    for (const node of Object.values(entry.outputs || {})) {
      for (const img of node.images || []) {
        if ((img.type || 'output') !== 'output') continue;
        images.push(await viewToDataUrl(base, img));
      }
    }
    if (images.length) return { images, text: '' };
    if (entry.status?.completed) throw new Error('ComfyUI 任务完成但没有输出图片');
  }
  const err = new Error('任务仍在处理中');
  err.pending = true;
  throw err;
}

export async function generateImageComfy(
  { prompt, aspectRatio, imageSize, onTaskSubmitted },
  settings
) {
  if (!settings.comfyCheckpoint) {
    throw new Error('未配置 ComfyUI 模型。请到设置页点"测试"后从列表中选择。');
  }
  const base = apiBase(settings);
  const zImage = isZImageModel(settings.comfyCheckpoint);
  // Z-Image is trained at ~1024; huge latents degrade quality, so cap 4K -> 2K.
  const tier = zImage && imageSize === '4K' ? '2K' : imageSize;
  const { width, height } = comfySize(aspectRatio, tier);
  let workflow;
  if (zImage) {
    const { clipName, vaeName } = await resolveZImageAux(base);
    workflow = buildZImageWorkflow({ prompt, width, height, clipName, vaeName }, settings);
  } else {
    workflow = buildComfyWorkflow({ prompt, width, height }, settings);
  }

  let res;
  try {
    res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'prompt-lens' })
    });
  } catch {
    throw new Error(`无法连接本地 ComfyUI（${base}）。请确认 ComfyUI 已启动。`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const nodeErrors = data?.node_errors && Object.values(data.node_errors)[0];
    const detail =
      nodeErrors?.errors?.[0]?.message || data?.error?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(`ComfyUI 拒绝了任务：${detail}`);
  }
  const promptId = data?.prompt_id;
  if (!promptId) throw new Error('ComfyUI 未返回任务号（prompt_id）');

  if (onTaskSubmitted) await onTaskSubmitted(promptId);
  return pollComfyHistory(promptId, settings);
}

/**
 * Connectivity check; returns selectable models for the options UI:
 * classic checkpoints plus diffusion models (Z-Image lives in the latter).
 */
export async function testComfy(baseUrl) {
  const base = (baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/object_info/CheckpointLoaderSimple`);
  } catch {
    throw new Error(`无法连接 ComfyUI（${base}）。请确认它已启动且地址正确。`);
  }
  if (!res.ok) throw new Error(`ComfyUI 响应异常（HTTP ${res.status}）`);
  const data = await res.json().catch(() => ({}));
  const checkpoints = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
  const diffusionModels = await loaderOptions(base, 'UNETLoader', 'unet_name').catch(() => []);
  return {
    checkpoints: Array.isArray(checkpoints) ? checkpoints : [],
    diffusionModels
  };
}
