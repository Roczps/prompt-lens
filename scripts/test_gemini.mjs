// Offline harness: stub fetch, exercise generateImage/reversePrompt paths.
import { generateImage, reversePrompt } from '../lib/gemini.js';

const settings = { apiKey: 'test-key', analysisModel: 'gemini-flash-latest', imageModel: 'gemini-3.1-flash-image' };
const calls = [];
let mode = 'ok';

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, body });
  if (mode === 'reject-responseFormat' && body.generationConfig?.responseFormat) {
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid JSON payload received. Unknown name "responseFormat"' } })
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }]
          }
        }
      ]
    })
  };
};

const fakePart = { inlineData: { mimeType: 'image/jpeg', data: '/9j/fake' } };

// 1. pose + character
calls.length = 0;
let res = await generateImage(
  { prompt: 'test prompt', aspectRatio: '3:4', imageSize: '1K', poseRefPart: fakePart, charPart: fakePart, charDesc: '短发女生' },
  settings
);
console.log('--- pose+char parts:', calls[0].body.contents[0].parts.length, '| images:', res.images.length);
console.log(calls[0].body.contents[0].parts.at(-1).text);
console.log('generationConfig:', JSON.stringify(calls[0].body.generationConfig));

// 2. fallback when responseFormat rejected
mode = 'reject-responseFormat';
calls.length = 0;
res = await generateImage({ prompt: 'p', aspectRatio: '1:1', imageSize: '2K' }, settings);
console.log('--- fallback attempts:', calls.length, '| final config:', JSON.stringify(calls.at(-1).body.generationConfig), '| images:', res.images.length);

// 3. reversePrompt JSON parse
mode = 'ok';
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                image_type: '真实摄影',
                analysis: { subject: 's', pose: 'p' },
                prompt: 'a prompt',
                prompt_zh: '中文',
                tags: { subject: ['人'] },
                palette: ['#112233']
              })
            }
          ]
        }
      }
    ]
  })
});
const r = await reversePrompt({ base64: 'x', mimeType: 'image/jpeg' }, settings);
console.log('--- reversePrompt keys:', Object.keys(r).join(','), '| pose:', r.analysis.pose);

// 4. OpenAI channel
const { generateImageOpenAI, openaiSize } = await import('../lib/openai.js');

const sizeCases = [
  ['1:1', '1K', '1024x1024'],
  ['16:9', '2K', '2048x1152'],
  ['9:16', '1K', '576x1024'],
  ['1:1', '4K', '2880x2880'],
  ['21:9', '4K', '3824x1632']
];
for (const [ar, tier, expected] of sizeCases) {
  const got = openaiSize(ar, tier);
  const [w, h] = got.split('x').map(Number);
  const ok = w % 16 === 0 && h % 16 === 0 && w * h >= 655360 && w * h <= 8294400;
  console.log(`--- openaiSize ${ar} ${tier} -> ${got} (expected ${expected}) valid:${ok}`);
  if (!ok) throw new Error('invalid size ' + got);
}

const oaSettings = {
  openaiApiKey: 'sk-test',
  openaiBaseUrl: 'https://api.openai.com/v1/',
  openaiImageModel: 'gpt-image-2'
};
const oaCalls = [];
globalThis.fetch = async (url, opts) => {
  oaCalls.push({ url, opts });
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] })
  };
};

// text-only -> generations JSON
oaCalls.length = 0;
let oa = await generateImageOpenAI({ prompt: 'p', aspectRatio: '3:4', imageSize: '1K' }, oaSettings);
let body = JSON.parse(oaCalls[0].opts.body);
console.log('--- openai generations url:', oaCalls[0].url, '| size:', body.size, '| quality:', body.quality, '| images:', oa.images.length);

// with refs -> edits multipart
oaCalls.length = 0;
const fakeDataUrl = 'data:image/jpeg;base64,/9j/AAAA';
oa = await generateImageOpenAI(
  { prompt: 'p', aspectRatio: '1:1', imageSize: '2K', poseRefDataUrl: fakeDataUrl, charDataUrl: fakeDataUrl, charDesc: 'd' },
  oaSettings
);
const form = oaCalls[0].opts.body;
const imgEntries = [...form.entries()].filter(([k]) => k === 'image[]');
console.log('--- openai edits url:', oaCalls[0].url, '| image[] count:', imgEntries.length, '| images:', oa.images.length);
if (!oaCalls[0].url.endsWith('/images/edits') || imgEntries.length !== 2) throw new Error('edits request malformed');

// 5. APIMart async protocol
const apimartSettings = {
  openaiApiKey: 'am-test',
  openaiBaseUrl: 'https://api.apimart.ai/v1',
  openaiImageModel: 'gpt-image-2',
  openaiProtocol: 'auto',
  pollIntervalMs: 1
};
const amCalls = [];
let pollCount = 0;
globalThis.fetch = async (url, opts = {}) => {
  amCalls.push({ url, method: opts.method || 'GET' });
  if (url.endsWith('/images/generations')) {
    const body = JSON.parse(opts.body);
    if (body.size !== '9:16' || body.resolution !== '2k') throw new Error('bad apimart body: ' + opts.body);
    return { ok: true, status: 200, json: async () => ({ code: 200, data: [{ status: 'submitted', task_id: 'task_123' }] }) };
  }
  if (url.includes('/tasks/task_123')) {
    pollCount++;
    if (pollCount < 2) {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { status: 'processing', progress: 50 } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        data: { status: 'completed', result: { images: [{ url: ['https://upload.apimart.ai/f/img.png'] }] } }
      })
    };
  }
  // image download
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new TextEncoder().encode('img').buffer
  };
};

let submittedTaskId = '';
const am = await generateImageOpenAI(
  {
    prompt: 'p',
    aspectRatio: '9:16',
    imageSize: '2K',
    poseRefDataUrl: fakeDataUrl,
    charDataUrl: fakeDataUrl,
    charDesc: 'd',
    onTaskSubmitted: (id) => {
      submittedTaskId = id;
    }
  },
  apimartSettings
);
if (submittedTaskId !== 'task_123') throw new Error('onTaskSubmitted not called');
const submitted = amCalls.find((c) => c.url.endsWith('/images/generations'));
console.log('--- apimart submit:', submitted.method, '| polls:', pollCount, '| images:', am.images.length, '| starts with data:image/png:', am.images[0].startsWith('data:image/png'));
if (pollCount < 2 || am.images.length !== 1) throw new Error('apimart flow broken');

// failed-task path
pollCount = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/images/generations')) {
    return { ok: true, status: 200, json: async () => ({ code: 200, data: [{ task_id: 't2' }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ code: 200, data: { status: 'failed', error: { message: '内容审核未通过' } } }) };
};
try {
  await generateImageOpenAI({ prompt: 'p', aspectRatio: '1:1', imageSize: '1K' }, apimartSettings);
  throw new Error('should have thrown');
} catch (e) {
  console.log('--- apimart failed-task error surfaced:', e.message);
  if (!e.message.includes('内容审核')) throw e;
}

// pending-timeout keeps e.pending so callers leave the gen running
const { pollApimartTask } = await import('../lib/openai.js');
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 200, data: { status: 'processing', progress: 10 } })
});
try {
  await pollApimartTask('t3', apimartSettings, { deadlineMs: 5 });
  throw new Error('should have thrown pending');
} catch (e) {
  console.log('--- apimart pending timeout, e.pending =', e.pending === true);
  if (e.pending !== true) throw e;
}

// 6. post set planning
const { planPostSet } = await import('../lib/gemini.js');
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const text = body.contents[0].parts[1].text;
  if (!text.includes('小红书') || !text.includes('4 张')) throw new Error('plan instruction missing platform/count');
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify([
                  { label: '封面·全身街拍', prompt: 'full body street shot ...' },
                  { label: '半身特写', prompt: 'waist-up closeup ...' },
                  { label: '侧影', prompt: 'side profile ...' },
                  { label: '细节', prompt: 'detail shot ...' },
                  { label: '多余的一张', prompt: 'extra ...' }
                ])
              }
            ]
          }
        }
      ]
    })
  };
};
const shots = await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', stylePrompt: 'sp', charDesc: '短发', platform: 'xhs', count: 4 },
  settings
);
console.log('--- planPostSet shots:', shots.length, '| first:', shots[0].label);
if (shots.length !== 4 || shots[0].label !== '封面·全身街拍') throw new Error('planPostSet broken');

// 7. post set planning with a content preset
const { POST_PRESETS, getPreset, NEGATIVE_TAIL } = await import('../lib/presets.js');
if (POST_PRESETS.length < 8) throw new Error('preset library incomplete');
const preset = getPreset('xhs-cafe');
let planInstruction = '';
globalThis.fetch = async (url, opts) => {
  planInstruction = JSON.parse(opts.body).contents[0].parts[1].text;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify([{ label: '封面', prompt: 'cover shot in a cafe' }]) }]
          }
        }
      ]
    })
  };
};
const presetShots = await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', stylePrompt: 'sp', charDesc: '', platform: 'xhs', count: 1, preset, negativeTail: NEGATIVE_TAIL },
  settings
);
const anchorInjected = planInstruction.includes(preset.styleAnchor) && planInstruction.includes(preset.rhythm);
const tailAppended = presetShots[0].prompt.endsWith(NEGATIVE_TAIL);
console.log('--- preset anchor injected:', anchorInjected, '| negative tail appended:', tailAppended);
if (!anchorInjected || !tailAppended) throw new Error('preset injection broken');
for (const p of POST_PRESETS) {
  if (!p.id || !p.name || !p.styleAnchor || !p.rhythm || !p.platformAspect) throw new Error('preset missing field: ' + p.id);
}

// 8. safety handling: dress constraint for GPT-Image + friendly error mapping
await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', platform: 'xhs', count: 1, provider: 'openai' },
  settings
);
const dressConstraint = planInstruction.includes('内容安全硬约束') && planInstruction.includes('严禁裸上身');
await planPostSet({ base64: 'x', mimeType: 'image/jpeg', platform: 'xhs', count: 1, provider: 'gemini' }, settings);
const noConstraintForGemini = !planInstruction.includes('内容安全硬约束');
console.log('--- openai dress constraint:', dressConstraint, '| gemini unconstrained:', noConstraintForGemini);
if (!dressConstraint || !noConstraintForGemini) throw new Error('dress constraint injection broken');

const { friendlyGenError } = await import('../lib/util.js');
const mapped = friendlyGenError(new Error('Your prompt or input was rejected by the content safety system.'));
const passthrough = friendlyGenError(new Error('HTTP 500 boring error'));
console.log('--- friendly safety error:', mapped.startsWith('内容安全审核未通过'), '| passthrough:', passthrough === 'HTTP 500 boring error');
if (!mapped.includes('重试这张') || passthrough !== 'HTTP 500 boring error') throw new Error('friendlyGenError broken');

console.log('ALL OK');
