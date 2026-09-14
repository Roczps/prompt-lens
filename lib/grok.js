import { dataUrlToBlob, bytesToBase64 } from './util.js';
import { buildGenInstruction } from './gemini.js';

export function grokBase(settings) {
  const base = (settings.grokBaseUrl || 'http://127.0.0.1:8011/v1').trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

// grok2api accepts only these sizes; resolution tiers are not supported.
export function grokSize(aspectRatio = '1:1') {
  const [w, h] = aspectRatio.split(':').map(Number);
  const ratio = w / h;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('Grok 画幅比例无效');
  const sizes = [[1, '1024x1024'], [16/9, '1280x720'], [9/16, '720x1280'], [3/2, '1792x1024'], [2/3, '1024x1792']];
  return sizes.sort((a, b) => Math.abs(Math.log(ratio/a[0])) - Math.abs(Math.log(ratio/b[0])))[0][1];
}

function auth(settings) {
  return settings.grokApiKey ? { Authorization: `Bearer ${settings.grokApiKey}` } : {};
}

async function readResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || (typeof data.detail === 'string' ? data.detail : '') || `Grok 请求失败（HTTP ${res.status}）`);
  return data;
}

export async function testGrok(settings) {
  const data = await readResponse(await fetch(`${grokBase(settings)}/models`, { headers: auth(settings) }));
  if (!Array.isArray(data.data)) throw new Error('Grok 未返回有效模型列表');
  return data.data.map(m => m.id).filter(id => typeof id === 'string' && id.includes('image'));
}

export async function generateImageGrok({ prompt, aspectRatio, poseRefDataUrl, styleRefDataUrl, charDataUrl, charDesc }, settings) {
  const refs = [poseRefDataUrl, styleRefDataUrl, charDataUrl].filter(Boolean);
  const instruction = buildGenInstruction({ prompt, hasPose: !!poseRefDataUrl, hasStyle: !!styleRefDataUrl, hasChar: !!charDataUrl, charDesc });
  const base = grokBase(settings);
  const fields = {
    model: refs.length ? (settings.grokEditModel || 'grok-imagine-image-edit') : (settings.grokImageModel || 'grok-imagine-image'),
    prompt: instruction, n: 1, size: grokSize(aspectRatio), response_format: 'b64_json'
  };
  let body, headers = auth(settings);
  if (refs.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    refs.forEach((ref, i) => {
      const blob = dataUrlToBlob(ref);
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      body.append('image[]', blob, `ref${i + 1}.${ext}`);
    });
  } else {
    body = JSON.stringify(fields);
    headers['Content-Type'] = 'application/json';
  }
  // Synchronous endpoint: keep MV3 alive; never blindly replay uncertain requests.
  const keepAlive = setInterval(() => {
    if (typeof chrome !== 'undefined') chrome.runtime?.getPlatformInfo?.(() => {});
  }, 20000);
  try {
    const data = await readResponse(await fetch(`${base}/images/${refs.length ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(240000)
    }));
    const images = [];
    for (const item of data.data || []) {
      if (item.b64_json) {
        const b64 = item.b64_json;
        const mime = b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png';
        images.push(b64.startsWith('data:image/') ? b64 : `data:${mime};base64,${b64}`);
      } else if (item.url) {
        const url = new URL(item.url, `${base}/`);
        const sameOrigin = url.origin === new URL(base).origin;
        const res = await fetch(url.href, { headers: sameOrigin ? auth(settings) : {}, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`下载 Grok 图片失败（HTTP ${res.status}）`);
        const mime = res.headers.get('content-type')?.split(';')[0] || '';
        if (!mime.startsWith('image/')) throw new Error('Grok 结果地址未返回图片');
        images.push(`data:${mime};base64,${bytesToBase64(new Uint8Array(await res.arrayBuffer()))}`);
      }
    }
    if (!images.length) throw new Error('Grok 接口未返回图片数据');
    return { images, text: '' };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) {
      throw new Error('Grok 连接中断或超时，远端结果未知；请先检查 grok2api 后台，确认后再手动重试。');
    }
    throw error;
  } finally {
    clearInterval(keepAlive);
  }
}
