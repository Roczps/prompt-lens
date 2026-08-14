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

console.log('ALL OK');
