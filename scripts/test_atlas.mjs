import assert from 'node:assert/strict';
import { generateImageAtlas, pollAtlasPrediction, testAtlasKey, normalizeAtlasKey } from '../lib/atlas.js';
const originalFetch = globalThis.fetch;
const settings = { atlasApiKey: ' Bearer apikey-test-secret ', atlasImageModel: 'bytedance/seedream-v5.0-pro/text-to-image', pollIntervalMs: 1 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-test-123' } });
try {
  assert.equal(normalizeAtlasKey(settings.atlasApiKey), 'apikey-test-secret');
  assert.throws(() => normalizeAtlasKey(''), /未填写/);
  assert.throws(() => normalizeAtlasKey('ak_public'), /公开 ID/);
  assert.throws(() => normalizeAtlasKey('apikey-with\nnewline'), /内部空白/);
  for (const status of [401, 402, 403, 404, 429, 500]) {
    globalThis.fetch = async (url, opts) => {
      assert.equal(url, 'https://api.atlascloud.ai/public/v1/balance');
      assert.equal(opts.headers.Authorization, 'Bearer apikey-test-secret');
      return json({ code: status, msg: 'server-detail' }, status);
    };
    await assert.rejects(testAtlasKey('', settings.atlasApiKey), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /server-detail/);
      assert.match(error.message, /request-test-123/);
      if (status === 403) assert.match(error.message, /余额读取权限/);
      return true;
    });
  }
  globalThis.fetch = async () => json({ code: 401, msg: 'echo apikey-test-secret' });
  await assert.rejects(generateImageAtlas({ prompt: 'a cat', aspectRatio: '1:1', imageSize: '1K' }, settings), error => {
    assert.match(error.message, /提交生成.*HTTP 200，API 401/);
    assert.ok(!error.message.includes('apikey-test-secret'));
    return true;
  });
  globalThis.fetch = async () => json({ error: { message: 'expired credential' } }, 401);
  await assert.rejects(pollAtlasPrediction('existing-task', settings), /查询任务.*expired credential/);
  globalThis.fetch = async () => new Response('<html>gateway down</html>', { status: 502 });
  await assert.rejects(testAtlasKey('', settings.atlasApiKey), /HTTP 502/);
  globalThis.fetch = async () => json({});
  await assert.rejects(testAtlasKey('', settings.atlasApiKey), /空响应/);
  globalThis.fetch = async () => json({ data: { balance: { value: '1.000000', currency: 'usd' } } });
  assert.match(await testAtlasKey('', settings.atlasApiKey), /尚未验证 Seedream 生图权限/);
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    assert.equal(opts.headers.Authorization, 'Bearer apikey-test-secret');
    if (url.endsWith('/generateImage')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, settings.atlasImageModel);
      assert.equal(body.size, '1536*1536');
      return json({ id: 'flat-response-id', status: 'processing' });
    }
    assert.ok(url.endsWith('/prediction/flat-response-id'));
    return json({ data: { status: 'completed', outputs: ['data:image/png;base64,aGk='] } });
  };
  let remembered;
  const result = await generateImageAtlas({ prompt: 'a cat', aspectRatio: '1:1', imageSize: '1K', onTaskSubmitted: id => { remembered = id; } }, settings);
  assert.equal(remembered, 'flat-response-id');
  assert.equal(result.images.length, 1);
  assert.equal(calls, 2);
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/generateImage')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'bytedance/seedream-v5.0-pro/edit');
      assert.deepEqual(body.images, ['data:image/png;base64,c291cmNl', 'data:image/png;base64,ZmFjZQ==']);
      assert.match(body.prompt, /Replace ONLY the facial identity/);
      assert.match(body.prompt, /clothing/);
      assert.match(body.prompt, /Keep every non-facial region unchanged/);
      assert.ok(!body.prompt.includes('unwanted character outfit'));
      return json({ data: { id: 'face-edit' } });
    }
    return json({ data: { status: 'completed', outputs: ['data:image/png;base64,aGk='] } });
  };
  await generateImageAtlas({ prompt: 'original scene', sourceDataUrl: 'data:image/png;base64,c291cmNl', styleRefDataUrl: 'data:image/png;base64,c3R5bGU=', charDataUrl: 'data:image/png;base64,ZmFjZQ==', charDesc: 'unwanted character outfit', aspectRatio: '3:4', imageSize: '1K' }, settings);
  console.log('--- Atlas diagnostics: auth normalization, HTTP/API errors, redaction, no false-positive checks, flat prediction response OK');
} finally {
  globalThis.fetch = originalFetch;
}
