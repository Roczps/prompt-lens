import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
for (const mode of ['success', 'invalidated', 'disconnected', 'rejected', 'empty']) {
  const handlers = {}, nodes = [];
  const node = () => ({ events: {}, classList: { add() {}, remove() {} }, style: {}, addEventListener(type, fn) { this.events[type] = fn; }, contains() { return false; }, remove() {} });
  class Image {
    currentSrc = 'https://example.com/test.jpg';
    getBoundingClientRect() { return { width: 400, height: 400, top: 0, right: 400 }; }
  }
  let submitted;
  const runtime = {
    sendMessage(message, callback) {
      submitted = message;
      if (mode === 'invalidated') throw new Error('Extension context invalidated.');
      if (mode === 'disconnected') runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      callback(mode === 'success' ? { ok: true } : mode === 'rejected' ? { ok: false, error: 'storage unavailable' } : undefined);
      delete runtime.lastError;
    }
  };
  vm.runInNewContext(code, {
    chrome: { runtime, storage: { sync: { get(defaults, cb) { cb(defaults); } }, onChanged: { addListener() {} } } },
    document: { createElement: node, documentElement: { appendChild(el) { nodes.push(el); } }, addEventListener(type, fn) { handlers[type] = fn; } },
    window: { innerWidth: 1000, addEventListener() {} }, HTMLImageElement: Image,
    location: { href: 'https://example.com/' }, setTimeout() {}, clearTimeout() {}, requestAnimationFrame(fn) { fn(); }
  });
  handlers.mouseover({ target: new Image() });
  nodes[0].events.click({ preventDefault() {}, stopPropagation() {} });
  const toast = nodes.at(-1).textContent;
  assert.equal(submitted.type, 'ANALYZE_IMAGE');
  assert.equal(submitted.payload.srcUrl, 'https://example.com/test.jpg');
  if (mode === 'success') assert.match(toast, /图片已提交/);
  else {
    assert.ok(!toast.includes('图片已提交'));
    assert.match(toast, mode === 'invalidated' || mode === 'disconnected' ? /刷新当前网页/ : /未提交成功/);
  }
}
console.log('--- Content entry: successful delivery, stale context, disconnected background, rejection and empty response OK');
