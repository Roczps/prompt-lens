import assert from 'node:assert/strict';
import { generateImageGrok, grokBase, grokSize, testGrok } from '../lib/grok.js';
import { getSettings } from '../lib/settings.js';

const previousFetch = globalThis.fetch;
const previousChrome = globalThis.chrome;
const settings = { grokBaseUrl: 'http://127.0.0.1:8011/', grokApiKey: 'test-only', grokImageModel: 'grok-imagine-image', grokEditModel: 'grok-imagine-image-edit', grokEditProtocol: 'multipart' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
try {
  assert.equal(grokBase(settings), 'http://127.0.0.1:8011/v1');
  assert.equal(grokBase({ grokBaseUrl: 'https://example.com/v1/' }), 'https://example.com/v1');
  for (const ratio of ['1:1', '3:4', '4:5', '16:9', '9:16', '21:9']) {
    assert.ok(['1024x1024', '1280x720', '720x1280', '1792x1024', '1024x1792'].includes(grokSize(ratio)));
  }
  assert.equal(grokSize('3:4'), '1024x1792');
  assert.equal(grokSize('16:9'), '1280x720');
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'http://127.0.0.1:8011/v1/images/generations');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, settings.grokImageModel);
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.size, '1280x720');
    assert.equal(body.n, 1);
    assert.equal(body.quality, undefined);
    assert.equal(opts.headers.Authorization, 'Bearer test-only');
    return json({ data: [{ b64_json: '/9j/test' }] });
  };
  const result = await generateImageGrok({ prompt: 'a cat', aspectRatio: '16:9', imageSize: '4K' }, settings);
  assert.match(result.images[0], /^data:image\/jpeg/);
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.endsWith('/images/edits'));
    assert.equal(opts.body.get('model'), settings.grokEditModel);
    assert.equal(opts.body.getAll('image[]').length, 2);
    assert.equal(opts.headers['Content-Type'], undefined);
    assert.match(opts.body.get('prompt'), /角色/);
    return json({ data: [{ b64_json: 'iVBORw0KGgo=' }] });
  };
  await generateImageGrok({ prompt: 'a portrait', aspectRatio: '3:4', poseRefDataUrl: 'data:image/png;base64,aGk=', charDataUrl: 'data:image/jpeg;base64,aGk=', charDesc: 'short hair' }, settings);
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.endsWith('/images/edits'));
    const body = JSON.parse(opts.body);
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(body.model, settings.grokEditModel);
    assert.equal(body.size, 'auto');
    assert.equal(body.aspect_ratio, '3:4');
    assert.equal(body.images[0].url, 'data:image/png;base64,aGk=');
    return json({ data: [{ b64_json: 'iVBORw0KGgo=' }] });
  };
  await generateImageGrok({ prompt: 'portrait', aspectRatio: '3:4', styleRefDataUrl: 'data:image/png;base64,aGk=' }, { ...settings, grokEditProtocol: 'json' });
  globalThis.fetch = async () => json({ error: { message: 'unauthorized' } }, 401);
  await assert.rejects(testGrok(settings), /客户端 API Key/);
  for (const remote of ['/v1/files/image?id=one', 'https://cdn.example.com/image.png']) {
    globalThis.fetch = async (url, opts) => {
      if (url.endsWith('/images/generations')) return json({ data: [{ url: remote }] });
      assert.equal(opts.headers.Authorization, remote.startsWith('/') ? 'Bearer test-only' : undefined);
      assert.equal(url, new URL(remote, 'http://127.0.0.1:8011/').href);
      return new Response(new Uint8Array([1,2,3]), { headers: { 'Content-Type': 'image/png' } });
    };
    assert.match((await generateImageGrok({ prompt: 'cat' }, settings)).images[0], /^data:image\/png;base64,/);
  }
  globalThis.fetch = async () => json({ error: { message: 'quota exhausted' } }, 429);
  await assert.rejects(generateImageGrok({ prompt: 'cat' }, settings), /quota exhausted/);
  globalThis.fetch = async () => json({ data: [] });
  await assert.rejects(generateImageGrok({ prompt: 'cat' }, settings), /未返回图片/);
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(generateImageGrok({ prompt: 'cat' }, settings), /远端结果未知/);
  assert.equal(attempts, 1);
  globalThis.fetch = async (_, opts) => {
    assert.equal(opts.headers.Authorization, undefined);
    return json({ data: [{ id: 'grok-imagine-image' }, { id: 'grok-4' }] });
  };
  assert.deepEqual(await testGrok({ grokBaseUrl: settings.grokBaseUrl }), ['grok-imagine-image']);
  globalThis.chrome = { storage: { sync: { get: async () => ({ imageProvider: 'comfy' }) } } };
  assert.equal((await getSettings()).imageProvider, 'grok');
  console.log('--- Grok: generation, reference edit, size mapping, auth, downloads, errors, no replay, settings migration OK');
} finally {
  globalThis.fetch = previousFetch;
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
}
