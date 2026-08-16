// FlowAgent video channel: a local bridge server that exposes Google Flow
// video generation through OpenAI-compatible endpoints.
//   submit POST {base}/v1/videos/generations -> job id
//   poll   GET  {base}/v1/videos/generations/{job_id} until succeeded/failed
// Community forks differ slightly in field names, so response parsing is
// deliberately tolerant.
import { urlToDataUrl } from './util.js';

function apiBase(settings) {
  return (settings.flowagentBaseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

const RUNNING_STATUSES = new Set(['created', 'queued', 'pending', 'processing', 'running', 'in_progress']);
const DONE_STATUSES = new Set(['succeeded', 'completed', 'done']);
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);

function jobPayload(data) {
  return data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
}

function jobStatus(job) {
  return String(job?.status || '').toLowerCase();
}

function jobId(job) {
  return job?.job_id || job?.id || job?.data?.[0]?.job_id || job?.data?.[0]?.id || '';
}

/** Find the finished video in whatever shape this FlowAgent build returns. */
function extractVideoRef(job, base) {
  const direct =
    job?.video_url ||
    job?.download_url ||
    job?.url ||
    job?.output?.url ||
    job?.result?.url ||
    job?.media?.[0]?.url ||
    job?.data?.[0]?.url ||
    (Array.isArray(job?.outputs) ? job.outputs[0] : '') ||
    (typeof job?.output === 'string' ? job.output : '');
  if (typeof direct === 'string' && direct) {
    if (direct.startsWith('data:')) return { kind: 'dataUrl', value: direct };
    if (/^https?:\/\//.test(direct)) return { kind: 'url', value: direct };
    if (direct.startsWith('/')) return { kind: 'url', value: base + direct };
  }
  const b64 = job?.video_base64 || job?.b64_json;
  if (b64) return { kind: 'dataUrl', value: `data:video/mp4;base64,${b64}` };
  const filename = job?.filename || job?.result?.filename;
  if (filename) return { kind: 'url', value: `${base}/download/${filename}` };
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a FlowAgent video job until it finishes. Throws Error with
 * `pending: true` on deadline so the generation stays "running" and the
 * resume alarm keeps polling (job id persists on the gen record).
 */
export async function pollFlowVideoJob(videoJobId, settings, { deadlineMs = 4 * 60 * 1000 } = {}) {
  const base = apiBase(settings);
  const pollMs = settings.pollIntervalMs || 4000;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo(() => {});
    }
    const res = await fetch(`${base}/v1/videos/generations/${videoJobId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || data?.detail || `查询视频任务失败（HTTP ${res.status}）`);
    }
    const job = jobPayload(data);
    const status = jobStatus(job);
    if (DONE_STATUSES.has(status) || (!status && extractVideoRef(job, base))) {
      const ref = extractVideoRef(job, base);
      if (!ref) throw new Error('视频任务完成但未返回视频地址');
      const dataUrl = ref.kind === 'dataUrl' ? ref.value : await urlToDataUrl(ref.value, 'video/mp4');
      return { videos: [dataUrl], text: '' };
    }
    if (FAILED_STATUSES.has(status)) {
      throw new Error(job?.error?.message || job?.error || job?.detail || '视频生成任务失败');
    }
    if (status && !RUNNING_STATUSES.has(status)) {
      // Unknown status: keep polling until deadline rather than failing hard.
    }
  }
  const err = new Error('视频仍在生成中');
  err.pending = true;
  throw err;
}

export async function generateVideoFlow(
  { prompt, imageDataUrl = '', duration = 8, onTaskSubmitted },
  settings
) {
  const base = apiBase(settings);
  const body = {
    prompt,
    duration: Number(duration) || 8,
    seconds: Number(duration) || 8
  };
  if (settings.flowagentModel) body.model = settings.flowagentModel;
  if (imageDataUrl) body.image = imageDataUrl;

  let res;
  try {
    res = await fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error(`无法连接 FlowAgent（${base}）。请确认本机 FlowAgent 服务已启动。`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
  }
  const job = jobPayload(data);

  // Some builds answer synchronously with the finished video.
  const ref = extractVideoRef(job, base);
  if (ref && DONE_STATUSES.has(jobStatus(job))) {
    const dataUrl = ref.kind === 'dataUrl' ? ref.value : await urlToDataUrl(ref.value, 'video/mp4');
    return { videos: [dataUrl], text: '' };
  }

  const id = jobId(job);
  if (!id) throw new Error('FlowAgent 未返回任务号（job id）');
  if (onTaskSubmitted) await onTaskSubmitted(id);
  return pollFlowVideoJob(id, settings);
}

export async function testFlowAgent(baseUrl) {
  const base = (baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/health`);
  } catch {
    throw new Error(`无法连接 FlowAgent（${base}）。请确认服务已启动且地址正确。`);
  }
  if (!res.ok) throw new Error(`FlowAgent 响应异常（HTTP ${res.status}）`);
  return res.json().catch(() => ({}));
}
