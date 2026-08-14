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

console.log('ALL OK');
