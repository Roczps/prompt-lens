export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Translate content-safety rejections into an actionable Chinese message. */
export function friendlyGenError(raw) {
  const msg = String(raw?.message || raw);
  if (/content safety|safety system|content policy|moderation|PROHIBITED_CONTENT|blocked.*safety|SAFETY/i.test(msg)) {
    return `内容安全审核未通过。GPT-Image 渠道对写实人物的裸露、内衣类描述审核很严：可给人物加上完整着装描述后重试，或切换 Gemini 渠道再点"重试这张"。原始错误：${msg}`;
  }
  return msg;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function dataUrlToBytes(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

export function dataUrlToBlob(dataUrl) {
  const { bytes, mime } = dataUrlToBytes(dataUrl);
  return new Blob([bytes], { type: mime });
}

export function dataUrlToInlinePart(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'image/png';
  return { inlineData: { mimeType: mime, data: body } };
}

/** Download a generated asset (image or video) and inline it as a dataURL. */
export async function urlToDataUrl(url, fallbackMime = 'image/png') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载生成结果失败（HTTP ${res.status}）`);
  const mime = res.headers.get('content-type') || fallbackMime;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export async function fetchImageData(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`无法获取图片（HTTP ${res.status}）`);
  const blob = await res.blob();
  const mime = blob.type || 'image/jpeg';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mime };
}

/**
 * Downscale to maxDim and re-encode as JPEG so we have a compact,
 * API-friendly copy of the source image (works in the service worker).
 */
export async function makeThumbnail(bytes, mime, maxDim = 1024) {
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const base64 = bytesToBase64(outBytes);
  return {
    base64,
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${base64}`,
    width: w,
    height: h
  };
}
