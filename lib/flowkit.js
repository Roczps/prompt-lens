// FlowKit Preview: local API, account-bound submissions, resumable status queries.
// Never replay an upload or generation POST after a network error/uncertain response.
import { bytesToBase64 } from './util.js';

const DEFAULT_BASE = 'http://127.0.0.1:8111';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isMediaId = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function apiBase(settings = {}) {
  const raw = settings.flowkitBaseUrl || DEFAULT_BASE;
  let url;
  try { url = new URL(raw); } catch { throw new Error('FlowKit 地址无效，请填写本机服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('FlowKit 仅支持本机地址，不需要 Key、Cookie 或 URL 凭据。');
  }
  return url.href.replace(/\/+$/, '');
}

function errorDetail(data) {
  const value = data?.detail || data?.error?.message || data?.error || data?.message || data?.msg;
  return typeof value === 'string' ? value : value ? JSON.stringify(value) : '';
}

function httpError(status, data, stage) {
  const advice = status === 503 ? '请检查本机服务与浏览器插件连接。'
    : status === 404 ? '请检查地址或账号连接；连接重连后需重新读取槽位，原生成不能直接重提。'
    : status === 429 ? '账号容量不足，请等待空槽，不要循环提交。'
    : [400, 422].includes(status) ? '请核对参数、模型与必填字段。'
    : [401, 403].includes(status) ? '请检查账号登录、权限和账号健康状态。' : '';
  return new Error(`FlowKit ${stage}失败（HTTP ${status}）。${advice}${errorDetail(data)}`);
}

async function request(base, path, { body, timeoutMs = 15000, stage = '请求' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const keepAlive = setInterval(() => {
    if (globalThis.chrome?.runtime?.getPlatformInfo) chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
  try {
    let res;
    try {
      res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        signal: controller.signal,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        })
      });
    } catch {
      throw new Error(`无法连接 FlowKit（${base}）或${stage}超时，请确认本机服务已启动。`);
    }
    let data;
    try { data = await res.json(); } catch { throw new Error(`FlowKit ${stage}返回了无效 JSON（HTTP ${res.status}）。`); }
    if (!res.ok) {
      const err = httpError(res.status, data, stage);
      err.evidence = data;
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    clearInterval(keepAlive);
  }
}

export async function getFlowKitAccount(settings = {}) {
  const base = apiBase(settings);
  const health = await request(base, '/health', { stage: '健康检查' });
  if (health?.ok === false || health?.healthy === false ||
      ['error', 'failed', 'unhealthy', 'offline'].includes(String(health?.status).toLowerCase())) {
    throw new Error('FlowKit 健康检查失败，请检查本机服务。');
  }
  if (health?.extension_connected !== true) throw new Error('FlowKit 浏览器插件未连接。');
  const status = await request(base, '/api/flow/status', { stage: '检查视频传输模式' });
  if (status?.transport !== 'batch') throw new Error('FlowKit 未使用 batch 传输，请检查 Preview 插件连接。');
  const slots = await request(base, '/api/slots', { stage: '读取账号槽位' });
  const account = (Array.isArray(slots?.accounts) ? slots.accounts : []).find((a) => a.online === true &&
    a.health?.blocked === false && Number(a.free) > 0 &&
    typeof a.connection_id === 'string' && a.connection_id.trim() &&
    typeof a.project_id === 'string' && a.project_id.trim());
  if (!account) throw new Error('FlowKit 没有可用账号槽位：需要账号在线、未阻断、有空槽，并已识别连接与项目。');
  return { baseUrl: base, project_id: account.project_id, connection_id: account.connection_id };
}

export async function testFlowKit(settings = {}) {
  await getFlowKitAccount(settings);
  return 'FlowKit 服务正常，插件已连接并使用 batch 传输，有可用账号槽位（仅验证健康、传输模式和槽位，未生成视频）。';
}

export function canResumeFlowKitVideo(descriptor) {
  if (descriptor?.version !== 1 || !descriptor.baseUrl) return false;
  // Imported first frames are bound by the server's media_owner record. Never
  // borrow the account picked for preflight to poll a server-owned operation.
  if (descriptor.serverOwnedPolling === true) {
    return Array.isArray(descriptor.operations) && descriptor.operations.length > 0 &&
      descriptor.operations.every(item => typeof item?.operation?.name === 'string' && item.operation.name.trim());
  }
  return !!descriptor.project_id && !!descriptor.connection_id && (
      (Array.isArray(descriptor.operations) && descriptor.operations.length > 0) ||
      (Array.isArray(descriptor.workflows) && descriptor.workflows.length > 0)
    );
}

function submittedError(error, descriptor, { pending = false, uncertain = false, evidence } = {}) {
  const err = new Error(`${error?.message || error}${uncertain ? ' 结果不明（uncertain），禁止自动重传或重提，请先核实 FlowKit 后台。' : ' 仅可查询原任务，不会重新上传或提交生成。'}`);
  err.noResubmit = true;
  err.pending = pending;
  err.uncertain = uncertain;
  err.descriptor = descriptor;
  err.evidence = evidence || error?.evidence;
  return err;
}

function isUncertain(data) {
  return data?.uncertain === true || String(data?.status).toLowerCase() === 'uncertain';
}

// Veo: Shotline preview-assets.ts:233-239; Omni: services/omni_flash.py:384-400.
// Keep status/metadata checks explicit: an image URL or HTTP 200 is not a video.
function videoResult(data, serverOwnedPolling) {
  const operations = Array.isArray(data?.operations) ? data.operations : [];
  const failed = operations.find((item) => /FAILED|CANCELLED|CANCELED|ERROR/.test(String(item.status).toUpperCase()));
  if (failed) return { error: errorDetail(failed.operation) || errorDetail(failed) || '视频生成失败。' };
  if (data?.error) return { error: errorDetail(data) };
  const finished = operations.filter((item) => item.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
  if (finished.length && finished.length === operations.length) {
    const urls = finished.map((item) => {
      const media = item.operation?.metadata?.video;
      if (serverOwnedPolling && !isMediaId(media?.mediaId)) return null;
      return typeof media?.fifeUrl === 'string' && media.fifeUrl.trim() ? media.fifeUrl : null;
    }).filter(Boolean);
    return urls.length === finished.length ? { urls } : { error: '视频任务完成，但未返回视频下载地址。' };
  }
  // /check-status dispatches workflows to check_omni_flash_status.
  const workflows = Array.isArray(data?.workflows) ? data.workflows : [];
  const workflowFailure = workflows.find((item) => item.error || /FAILED|CANCELLED|CANCELED|ERROR/.test(String(item.status).toUpperCase()));
  if (workflowFailure) return { error: errorDetail(workflowFailure) || '视频工作流失败。' };
  const ready = workflows.filter((item) => item.done === true && item.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
  if (ready.length && ready.length === workflows.length) {
    const urls = ready.map((item) => typeof item.media?.url === 'string' && item.media.url.trim() ? item.media.url : null).filter(Boolean);
    return urls.length === ready.length ? { urls } : { error: '视频工作流已完成，但未返回视频下载地址。' };
  }
  return {};
}

async function downloadVideo(url, base) {
  const target = new URL(url, base);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('视频下载地址无效。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(target.href, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) throw new Error(`视频已生成，但下载失败（HTTP ${res.status}）。`);
    const mime = res.headers.get('content-type')?.split(';')[0] || 'video/mp4';
    if (!mime.startsWith('video/') && mime !== 'application/octet-stream') throw new Error('视频下载返回了非视频内容。');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error('视频下载内容为空。');
    return `data:${mime.startsWith('video/') ? mime : 'video/mp4'};base64,${bytesToBase64(bytes)}`;
  } finally { clearTimeout(timer); }
}

export async function resumeFlowKitVideo(settings, descriptor, { deadlineMs = 4 * 60 * 1000 } = {}) {
  if (!canResumeFlowKitVideo(descriptor)) {
    throw submittedError('上传或视频执行中断，未取得可查询的视频标识；保留原回执待核对。', descriptor, { uncertain: true });
  }
  const base = apiBase({ flowkitBaseUrl: descriptor.baseUrl });
  // Shotline shot-fallback.ts:132 / preview-assets.ts:225-230: the backend
  // resolves the original operation owner, even after active leases disappear.
  const body = descriptor.serverOwnedPolling ? {} : {
    project_id: descriptor.project_id, connection_id: descriptor.connection_id
  };
  if (descriptor.operations?.length) body.operations = descriptor.operations;
  else body.workflows = descriptor.workflows;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(settings.pollIntervalMs || 5000);
    let data;
    try { data = await request(base, '/api/flow/check-status', { body, stage: '查询原视频任务', timeoutMs: 30000 }); }
    catch (e) {
      throw submittedError(e, descriptor, { pending: !e.httpStatus || e.httpStatus >= 500 || e.httpStatus === 429 });
    }
    if (isUncertain(data)) throw submittedError('FlowKit 查询结果不明。', descriptor, { uncertain: true, evidence: data });
    const kind = body.operations ? 'operations' : 'workflows';
    const handles = body[kind];
    const results = data?.[kind];
    const mismatched = !Array.isArray(results) || results.length !== handles.length || handles.some((original, index) => {
      const current = results[index];
      if (kind === 'operations') {
        const name = original.operation?.name || original.name;
        return !!name && name !== (current?.operation?.name || current?.name);
      }
      const mediaId = original.primary_media_id || original.metadata?.primaryMediaId;
      return (original.name && original.name !== current?.name) ||
        (mediaId && mediaId !== current?.primary_media_id) ||
        (original.project_id && original.project_id !== current?.project_id);
    });
    if (mismatched) {
      throw submittedError(`FlowKit 轮询返回的 ${kind} 与原任务不符。`, descriptor, { uncertain: true, evidence: data });
    }
    // A successful unrelated workflow cannot complete a pending operation (or
    // vice versa). Only parse the kind and handles actually queried above.
    const result = videoResult({ [kind]: results, error: data.error }, descriptor.serverOwnedPolling);
    if (result.error) throw submittedError(result.error, descriptor, { evidence: data });
    if (result.urls) {
      try {
        const videos = [];
        for (const url of result.urls) videos.push(await downloadVideo(url, base));
        return { videos, text: '', evidence: data };
      } catch (e) { throw submittedError(e, descriptor, { evidence: data }); }
    }
  }
  throw submittedError('视频仍在生成中，将继续查询原任务。', descriptor, { pending: true });
}

export async function generateVideoFlowKit(settings, {
  prompt, aspectRatio = '16:9', duration = 8, referenceDataUrl = '', sceneId = '', onTaskCreated
}) {
  if (!String(prompt || '').trim()) throw new Error('请填写视频提示词。');
  if (!['16:9', '9:16'].includes(aspectRatio)) throw new Error('FlowKit 视频画幅请选择 16:9 或 9:16。');
  if (referenceDataUrl && Number(duration) !== 8) throw new Error('FlowKit 首帧图生视频固定为 8 秒。');
  if (![4, 6, 8, 10].includes(Number(duration))) throw new Error('FlowKit 文生视频时长请选择 4、6、8 或 10 秒。');
  // FlowKit UploadImageRequest takes raw base64, not a data URL or a path on
  // the browser's filesystem (agent/api/flow.py:108-132, 762-769).
  let image;
  if (referenceDataUrl) {
    image = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(referenceDataUrl);
    if (!image || image[2].length % 4 !== 0) throw new Error('首帧需要有效的 PNG、JPEG 或 WebP base64 图片。');
  }
  const account = await getFlowKitAccount(settings);
  let descriptor;
  let body;
  if (image) {
    const uploadBody = {
      image_base64: image[2], mime_type: image[1],
      file_name: `first-frame.${image[1] === 'image/jpeg' ? 'jpg' : image[1].slice(6)}`,
      project_id: account.project_id
    };
    descriptor = {
      version: 1, baseUrl: account.baseUrl, project_id: account.project_id,
      serverOwnedPolling: true, state: 'uploading',
      uploadRequest: { project_id: uploadBody.project_id, mime_type: uploadBody.mime_type, file_name: uploadBody.file_name }
    };
    // A worker killed during upload must leave a durable no-reupload receipt.
    if (onTaskCreated) await onTaskCreated(descriptor);
    let upload;
    try {
      upload = await request(account.baseUrl, '/api/flow/upload-image', {
        body: uploadBody, stage: '上传首帧', timeoutMs: settings.submitTimeoutMs || 180000
      });
    } catch (e) { throw submittedError(e, descriptor, { uncertain: true }); }
    // Same media_id validation as Shotline shot-fallback.ts:99-106. A logical
    // project ID is not proof of the owning account; no connection_id is sent.
    const mediaId = upload?.media_id;
    const uploaded = !isUncertain(upload) && isMediaId(mediaId);
    descriptor = {
      ...descriptor, state: uploaded ? 'uploaded' : 'upload_uncertain', uploadResponse: upload,
      ...(uploaded ? { start_image_media_id: mediaId } : {})
    };
    if (onTaskCreated) {
      try { await onTaskCreated(descriptor); }
      catch (e) { throw submittedError(e, descriptor, { uncertain: true, evidence: upload }); }
    }
    if (!uploaded) throw submittedError('FlowKit 首帧上传未确认，已保留上传回执。', descriptor, { uncertain: true, evidence: upload });
    // Shotline preview-assets.ts:136,142-143. Veo's duration/resolution are
    // model-defined; those optional Omni parameters are deliberately omitted.
    body = {
      prompt, project_id: descriptor.project_id, start_image_media_id: mediaId,
      scene_id: sceneId || crypto.randomUUID(), model_family: 'veo',
      video_model: 'veo_3_1_i2v_lite',
      aspect_ratio: aspectRatio === '9:16' ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE'
    };
    descriptor = { ...descriptor, state: 'submitting', request: body };
  } else {
    descriptor = { version: 1, ...account, state: 'submitting' };
    body = {
      prompt, project_id: account.project_id, connection_id: account.connection_id,
      duration_s: Number(duration), resolution: '720p',
      aspect_ratio: aspectRatio === '9:16' ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE'
    };
  }
  // Persist before crossing the submission boundary, including when no response arrives.
  if (onTaskCreated) {
    try { await onTaskCreated(descriptor); }
    catch (e) {
      if (image) throw submittedError(e, descriptor, { uncertain: true, evidence: descriptor.uploadResponse });
      throw e;
    }
  }
  let data;
  try {
    data = await request(account.baseUrl, image ? '/api/flow/generate-video' : '/api/flow/generate-video-omni-text', {
      body, stage: '提交视频', timeoutMs: settings.submitTimeoutMs || 240000
    });
  } catch (e) {
    throw submittedError(e, descriptor, { uncertain: true });
  }
  descriptor = {
    ...descriptor, state: 'submitted', submission: data,
    ...(data?.operations ? { operations: data.operations } : {}),
    ...(data?.flowkitPolling ? { flowkitPolling: data.flowkitPolling } : {}),
    ...(data?.flowkitPolling?.workflows ? { workflows: data.flowkitPolling.workflows } : {})
  };
  if (onTaskCreated) {
    try { await onTaskCreated(descriptor); }
    catch (e) { throw submittedError(e, descriptor, { uncertain: true, evidence: data }); }
  }
  if (isUncertain(data) || !canResumeFlowKitVideo(descriptor)) {
    throw submittedError('FlowKit 未确认视频任务可查询。', descriptor, { uncertain: true, evidence: data });
  }
  return resumeFlowKitVideo(settings, descriptor);
}
