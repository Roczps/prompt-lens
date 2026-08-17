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

// 9. anchored planning: a character-swapped generation as reference means the
// image itself defines appearance AND wardrobe; the card description must not
// be injected alongside it.
await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', platform: 'ins', count: 1, charDesc: '短发', anchorIsCharacter: true },
  settings
);
const CARD_DESC_LINE = '角色外貌锚定（每张 prompt 都必须原样包含这些特征）';
const anchoredMode =
  planInstruction.includes('参考图中的人物就是这个角色本人') && !planInstruction.includes(CARD_DESC_LINE);
await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', platform: 'ins', count: 1, charDesc: '短发' },
  settings
);
const cardMode =
  planInstruction.includes(CARD_DESC_LINE) && !planInstruction.includes('参考图中的人物就是这个角色本人');
await planPostSet(
  { base64: 'x', mimeType: 'image/jpeg', platform: 'xhs', count: 1, preset, anchorIsCharacter: true },
  settings
);
const anchoredPreset = planInstruction.includes('外貌与服装穿搭');
console.log('--- anchored plan:', anchoredMode, '| card plan:', cardMode, '| anchored preset wardrobe:', anchoredPreset);
if (!anchoredMode || !cardMode || !anchoredPreset) throw new Error('anchored planning broken');

// 9b. post-set caption copy: platform rules, hashtag cleanup, error mapping
const { writePostCopy } = await import('../lib/gemini.js');

let copyInstruction = '';
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body);
  copyInstruction = body.contents[0].parts[1].text;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  title: '在游艇上偷得半日闲☀️',
                  body: '第一行\n第二行',
                  tags: ['#游艇出海', '夏日穿搭', ' plog ']
                })
              }
            ]
          }
        }
      ]
    })
  };
};
const xhsCopy = await writePostCopy(
  { base64: 'x', mimeType: 'image/jpeg', platform: 'xhs', presetName: '小红书 · 旅行 plog', shots: ['封面·全身', '手部特写'] },
  settings
);
if (!copyInstruction.includes('平台：小红书') || !copyInstruction.includes('封面·全身')) throw new Error('copy xhs instruction broken');
if (!copyInstruction.includes('旅行 plog')) throw new Error('copy preset name missing');
if (xhsCopy.tags[0] !== '游艇出海' || xhsCopy.tags[2] !== 'plog') throw new Error('copy hashtag cleanup broken');
if (xhsCopy.body !== '第一行\n第二行') throw new Error('copy body broken');
await writePostCopy({ base64: 'x', mimeType: 'image/jpeg', platform: 'ins' }, settings);
if (!copyInstruction.includes('平台：Instagram') || !copyInstruction.includes('hashtag')) throw new Error('copy ins instruction broken');
console.log('--- writePostCopy ok (title:', xhsCopy.title + ')');

// empty copy result is an error, not a silent success
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: '{"title":"","body":"","tags":[]}' }] } }] })
});
try {
  await writePostCopy({ base64: 'x', mimeType: 'image/jpeg', platform: 'xhs' }, settings);
  throw new Error('should have thrown');
} catch (e) {
  if (!e.message.includes('文案生成结果为空')) throw e;
  console.log('--- empty copy guarded');
}

const { friendlyGenError } = await import('../lib/util.js');
const mapped = friendlyGenError(new Error('Your prompt or input was rejected by the content safety system.'));
const passthrough = friendlyGenError(new Error('HTTP 500 boring error'));
console.log('--- friendly safety error:', mapped.startsWith('内容安全审核未通过'), '| passthrough:', passthrough === 'HTTP 500 boring error');
if (!mapped.includes('重试这张') || passthrough !== 'HTTP 500 boring error') throw new Error('friendlyGenError broken');

// 10. Seedream via Atlas Cloud: size mapping, edit-variant switch, async flow
const { generateImageAtlas, pollAtlasPrediction, atlasSize, atlasModelFor } = await import('../lib/atlas.js');

if (atlasSize('3:4', '2K') !== '1728*2304') throw new Error('atlasSize 3:4 2K broken');
if (atlasSize('1:1', '4K') !== '4096*4096') throw new Error('atlasSize 1:1 4K broken');
if (atlasSize('4:5', '2K') !== '1728*2304') throw new Error('atlasSize closest-ratio fallback broken');
if (atlasModelFor('bytedance/seedream-v4.5', false) !== 'bytedance/seedream-v4.5') throw new Error('atlasModelFor no-refs broken');
if (atlasModelFor('bytedance/seedream-v4.5', true) !== 'bytedance/seedream-v4.5/edit') throw new Error('atlasModelFor edit broken');
if (atlasModelFor('bytedance/seedream-v5.0-pro/text-to-image', true) !== 'bytedance/seedream-v5.0-pro/edit')
  throw new Error('atlasModelFor t2i->edit broken');
console.log('--- atlasSize/atlasModelFor ok');

const atlasSettings = { atlasApiKey: 'atlas-test', atlasImageModel: 'bytedance/seedream-v4.5', pollIntervalMs: 1 };
let atlasPollCount = 0;
let atlasSubmitBody = null;
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/api/v1/model/generateImage')) {
    atlasSubmitBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ code: 200, data: { id: 'pred_1', status: 'processing' } }) };
  }
  if (url.includes('/api/v1/model/prediction/pred_1')) {
    atlasPollCount++;
    if (atlasPollCount < 2) return { ok: true, status: 200, json: async () => ({ data: { status: 'processing' } }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'completed', outputs: ['https://storage.atlascloud.ai/out.png'] } })
    };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new TextEncoder().encode('img').buffer
  };
};
let atlasSubmittedId = '';
const atlasRes = await generateImageAtlas(
  {
    prompt: 'p',
    aspectRatio: '3:4',
    imageSize: '2K',
    charDataUrl: fakeDataUrl,
    charDesc: 'd',
    onTaskSubmitted: (id) => {
      atlasSubmittedId = id;
    }
  },
  atlasSettings
);
console.log(
  '--- atlas submit model:',
  atlasSubmitBody.model,
  '| size:',
  atlasSubmitBody.size,
  '| refs:',
  atlasSubmitBody.images?.length,
  '| polls:',
  atlasPollCount,
  '| images:',
  atlasRes.images.length
);
if (atlasSubmitBody.model !== 'bytedance/seedream-v4.5/edit') throw new Error('atlas edit model not used with refs');
if (atlasSubmitBody.size !== '1728*2304' || atlasSubmittedId !== 'pred_1') throw new Error('atlas submit broken');
if (atlasPollCount < 2 || !atlasRes.images[0].startsWith('data:image/png')) throw new Error('atlas poll broken');

// failed prediction surfaces its error
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/api/v1/model/generateImage')) {
    return { ok: true, status: 200, json: async () => ({ data: { id: 'pred_2' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { status: 'failed', error: '配额不足' } }) };
};
try {
  await generateImageAtlas({ prompt: 'p', aspectRatio: '1:1', imageSize: '2K' }, atlasSettings);
  throw new Error('should have thrown');
} catch (e) {
  console.log('--- atlas failed-task error surfaced:', e.message);
  if (!e.message.includes('配额不足')) throw e;
}

// pending timeout keeps e.pending
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { status: 'processing' } }) });
try {
  await pollAtlasPrediction('pred_3', atlasSettings, { deadlineMs: 5 });
  throw new Error('should have thrown pending');
} catch (e) {
  console.log('--- atlas pending timeout, e.pending =', e.pending === true);
  if (e.pending !== true) throw e;
}

// 11. local ComfyUI: latent size, workflow graph, submit -> history -> /view
const { generateImageComfy, pollComfyHistory, comfySize, buildComfyWorkflow } = await import('../lib/comfy.js');

const cs = comfySize('16:9', '1K');
if (cs.width !== 1024 || cs.height % 8 !== 0 || cs.height >= cs.width) throw new Error('comfySize 16:9 broken');
const csP = comfySize('3:4', '2K');
if (csP.height !== 1536 || csP.width % 8 !== 0 || csP.width >= csP.height) throw new Error('comfySize portrait broken');
console.log('--- comfySize 16:9 1K ->', `${cs.width}x${cs.height}`, '| 3:4 2K ->', `${csP.width}x${csP.height}`);

const comfySettings = {
  comfyBaseUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: 'sd_xl_base_1.0.safetensors',
  comfySteps: 30,
  comfyCfg: 6,
  pollIntervalMs: 1
};
const wf = buildComfyWorkflow({ prompt: 'a cat', width: 1024, height: 1024 }, comfySettings);
if (wf[4].inputs.ckpt_name !== comfySettings.comfyCheckpoint) throw new Error('workflow checkpoint broken');
if (wf[3].inputs.steps !== 30 || wf[3].inputs.cfg !== 6) throw new Error('workflow sampler params broken');
if (wf[6].inputs.text !== 'a cat' || !wf[7].inputs.text) throw new Error('workflow prompts broken');

let comfyPollCount = 0;
let comfySubmitBody = null;
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/prompt')) {
    comfySubmitBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ prompt_id: 'comfy_1' }) };
  }
  if (url.includes('/history/comfy_1')) {
    comfyPollCount++;
    if (comfyPollCount < 2) return { ok: true, status: 200, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        comfy_1: {
          status: { completed: true, messages: [] },
          outputs: { 9: { images: [{ filename: 'PromptLens_0001.png', subfolder: '', type: 'output' }] } }
        }
      })
    };
  }
  if (url.includes('/view?')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new TextEncoder().encode('img').buffer
    };
  }
  throw new Error('unexpected comfy url: ' + url);
};
let comfySubmittedId = '';
const comfyRes = await generateImageComfy(
  {
    prompt: 'a cat',
    aspectRatio: '1:1',
    imageSize: '1K',
    onTaskSubmitted: (id) => {
      comfySubmittedId = id;
    }
  },
  comfySettings
);
console.log(
  '--- comfy submit graph nodes:',
  Object.keys(comfySubmitBody.prompt).length,
  '| polls:',
  comfyPollCount,
  '| images:',
  comfyRes.images.length
);
if (comfySubmittedId !== 'comfy_1' || comfyRes.images.length !== 1) throw new Error('comfy flow broken');

// execution error propagates the node's message
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'comfy_2' }) };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      comfy_2: { status: { completed: false, messages: [['execution_error', { exception_message: '显存不足' }]] }, outputs: {} }
    })
  };
};
try {
  await generateImageComfy({ prompt: 'p', aspectRatio: '1:1', imageSize: '1K' }, comfySettings);
  throw new Error('should have thrown');
} catch (e) {
  console.log('--- comfy execution error surfaced:', e.message);
  if (!e.message.includes('显存不足')) throw e;
}

// missing checkpoint is a friendly config error
try {
  await generateImageComfy({ prompt: 'p', aspectRatio: '1:1', imageSize: '1K' }, { ...comfySettings, comfyCheckpoint: '' });
  throw new Error('should have thrown');
} catch (e) {
  if (!e.message.includes('未配置 ComfyUI 模型')) throw e;
  console.log('--- comfy missing checkpoint guarded');
}

// pending timeout keeps e.pending
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
try {
  await pollComfyHistory('comfy_3', comfySettings, { deadlineMs: 5 });
  throw new Error('should have thrown pending');
} catch (e) {
  console.log('--- comfy pending timeout, e.pending =', e.pending === true);
  if (e.pending !== true) throw e;
}

// 11b. Z-Image Turbo: dedicated graph (UNETLoader + lumina2 CLIP + Flux AE)
const { isZImageModel, buildZImageWorkflow } = await import('../lib/comfy.js');

if (!isZImageModel('z_image_turbo_bf16.safetensors')) throw new Error('isZImageModel plain broken');
if (!isZImageModel('z-image\\z-image-turbo-fp8-e4m3fn.safetensors')) throw new Error('isZImageModel subfolder broken');
if (isZImageModel('sd_xl_base_1.0.safetensors')) throw new Error('isZImageModel false positive');

const zSettings = { ...comfySettings, comfyCheckpoint: 'z_image_turbo_bf16.safetensors' };
const zwf = buildZImageWorkflow(
  { prompt: 'a cat', width: 1024, height: 1024, clipName: 'qwen_3_4b.safetensors', vaeName: 'ae.safetensors' },
  zSettings
);
if (zwf[1].class_type !== 'UNETLoader' || zwf[1].inputs.unet_name !== zSettings.comfyCheckpoint)
  throw new Error('zimage unet loader broken');
if (zwf[2].inputs.type !== 'lumina2' || zwf[2].inputs.clip_name !== 'qwen_3_4b.safetensors')
  throw new Error('zimage clip loader broken');
if (zwf[3].inputs.vae_name !== 'ae.safetensors') throw new Error('zimage vae loader broken');
if (zwf[7].class_type !== 'EmptySD3LatentImage') throw new Error('zimage latent broken');
// distilled model: fixed 9 steps / CFG 1, user comfySteps/comfyCfg ignored
if (zwf[8].inputs.steps !== 9 || zwf[8].inputs.cfg !== 1 || zwf[8].inputs.scheduler !== 'simple')
  throw new Error('zimage sampler params broken');
console.log('--- zimage workflow graph ok');

// full flow: aux models auto-resolved from object_info, graph submitted
let zSubmitBody = null;
globalThis.fetch = async (url, opts = {}) => {
  if (url.includes('/object_info/CLIPLoader')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ CLIPLoader: { input: { required: { clip_name: [['umt5-xxl-enc-bf16.safetensors', 'z-image\\qwen_3_4b.safetensors']] } } } })
    };
  }
  if (url.includes('/object_info/VAELoader')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors', 'ae.safetensors']] } } } })
    };
  }
  if (url.endsWith('/prompt')) {
    zSubmitBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ prompt_id: 'z_1' }) };
  }
  if (url.includes('/history/z_1')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        z_1: {
          status: { completed: true, messages: [] },
          outputs: { 10: { images: [{ filename: 'PromptLens_0001.png', subfolder: '', type: 'output' }] } }
        }
      })
    };
  }
  if (url.includes('/view?')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new TextEncoder().encode('img').buffer
    };
  }
  throw new Error('unexpected zimage url: ' + url);
};
const zRes = await generateImageComfy({ prompt: 'a cat', aspectRatio: '1:1', imageSize: '1K' }, zSettings);
const zGraph = zSubmitBody.prompt;
if (zGraph[1].class_type !== 'UNETLoader') throw new Error('zimage flow did not use z graph');
if (zGraph[2].inputs.clip_name !== 'z-image\\qwen_3_4b.safetensors') throw new Error('zimage clip auto-pick broken');
if (zGraph[3].inputs.vae_name !== 'ae.safetensors') throw new Error('zimage vae auto-pick broken');
if (zRes.images.length !== 1) throw new Error('zimage flow broken');
console.log('--- zimage full flow ok (clip:', zGraph[2].inputs.clip_name, '| vae:', zGraph[3].inputs.vae_name + ')');

// 11c. Seedream 5.0 Pro uses its enumerated size list
const V5 = 'bytedance/seedream-v5.0-pro/text-to-image';
if (atlasSize('1:1', '2K', V5) !== '2048*2048') throw new Error('v5 size 1:1 2K broken');
if (atlasSize('3:4', '1K', V5) !== '1328*1776') throw new Error('v5 size 3:4 1.5K broken');
if (atlasSize('16:9', '512', V5) !== '2048*1152') throw new Error('v5 size 16:9 1.5K broken');
if (atlasSize('9:16', '4K', V5) !== '1530*2720') throw new Error('v5 size 9:16 caps at 2K tier');
if (atlasSize('3:4', '2K') !== '1728*2304') throw new Error('v4 size mapping regressed');
if (atlasModelFor(V5, true) !== 'bytedance/seedream-v5.0-pro/edit') throw new Error('v5 edit variant broken');
console.log('--- seedream 5 size mapping ok');

// 12. FlowAgent video: submit -> job id -> poll -> download mp4
const { generateVideoFlow, pollFlowVideoJob } = await import('../lib/flowagent.js');

const flowSettings = { flowagentBaseUrl: 'http://127.0.0.1:8001', pollIntervalMs: 1 };
let flowPollCount = 0;
let flowSubmitBody = null;
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/v1/videos/generations') && opts.method === 'POST') {
    flowSubmitBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ id: 'job_1', status: 'queued' }) };
  }
  if (url.includes('/v1/videos/generations/job_1')) {
    flowPollCount++;
    if (flowPollCount < 2) return { ok: true, status: 200, json: async () => ({ id: 'job_1', status: 'processing' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'job_1', status: 'succeeded', video_url: '/download/out.mp4' })
    };
  }
  if (url.includes('/download/out.mp4')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'video/mp4' },
      arrayBuffer: async () => new TextEncoder().encode('vid').buffer
    };
  }
  throw new Error('unexpected flow url: ' + url);
};
let flowSubmittedId = '';
const flowRes = await generateVideoFlow(
  {
    prompt: 'a cinematic shot',
    imageDataUrl: fakeDataUrl,
    duration: 8,
    onTaskSubmitted: (id) => {
      flowSubmittedId = id;
    }
  },
  flowSettings
);
console.log(
  '--- flow submit duration:',
  flowSubmitBody.duration,
  '| has image:',
  !!flowSubmitBody.image,
  '| polls:',
  flowPollCount,
  '| videos:',
  flowRes.videos.length
);
if (flowSubmittedId !== 'job_1' || !flowRes.videos[0].startsWith('data:video/mp4')) throw new Error('flow video broken');

// failed job surfaces error
globalThis.fetch = async (url, opts = {}) => {
  if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'job_2' }) };
  return { ok: true, status: 200, json: async () => ({ id: 'job_2', status: 'failed', error: 'credits 不足' }) };
};
try {
  await generateVideoFlow({ prompt: 'p' }, flowSettings);
  throw new Error('should have thrown');
} catch (e) {
  console.log('--- flow failed-job error surfaced:', e.message);
  if (!e.message.includes('credits')) throw e;
}

// pending timeout keeps e.pending
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'processing' }) });
try {
  await pollFlowVideoJob('job_3', flowSettings, { deadlineMs: 5 });
  throw new Error('should have thrown pending');
} catch (e) {
  console.log('--- flow pending timeout, e.pending =', e.pending === true);
  if (e.pending !== true) throw e;
}

console.log('ALL OK');
