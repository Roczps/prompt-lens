import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.js';
import { testApiKey } from '../lib/gemini.js';
import { testOpenAIKey } from '../lib/openai.js';
import { testAtlasKey } from '../lib/atlas.js';
import { testComfy } from '../lib/comfy.js';
import { testFlowAgent } from '../lib/flowagent.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'apiKey',
  'analysisModel',
  'imageModel',
  'openaiApiKey',
  'openaiBaseUrl',
  'openaiImageModel',
  'openaiProtocol',
  'atlasApiKey',
  'atlasImageModel',
  'comfyBaseUrl',
  'comfyCheckpoint',
  'comfySteps',
  'comfyCfg',
  'comfyNegative',
  'flowagentBaseUrl',
  'flowagentModel',
  'videoDuration',
  'imageProvider',
  'aspectRatio',
  'imageSize',
  'minImageSize'
];

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) $(f).value = s[f];
  $('ballEnabled').checked = s.ballEnabled;
}

async function save() {
  const patch = { ballEnabled: $('ballEnabled').checked };
  const fallbackToDefault = [
    'analysisModel',
    'imageModel',
    'openaiBaseUrl',
    'openaiImageModel',
    'atlasImageModel',
    'comfyBaseUrl',
    'flowagentBaseUrl'
  ];
  for (const f of FIELDS) {
    let v = $(f).value.trim();
    if (f === 'minImageSize') v = Math.max(40, Number(v) || DEFAULT_SETTINGS.minImageSize);
    if (f === 'comfySteps') v = Math.min(150, Math.max(1, Number(v) || DEFAULT_SETTINGS.comfySteps));
    if (f === 'comfyCfg') v = Math.min(30, Math.max(1, Number(v) || DEFAULT_SETTINGS.comfyCfg));
    if (f === 'videoDuration') v = Number(v) || DEFAULT_SETTINGS.videoDuration;
    if (fallbackToDefault.includes(f) && !v) v = DEFAULT_SETTINGS[f];
    patch[f] = v;
  }
  await saveSettings(patch);
  const el = $('save-result');
  el.textContent = '已保存';
  el.className = 'hint ok';
  setTimeout(() => (el.textContent = ''), 2000);
}

/** Run a connectivity check and paint the result into a hint element. */
async function runTest(resultId, fn, okText = '连接成功，Key 可用') {
  const el = $(resultId);
  el.textContent = '测试中…';
  el.className = 'hint';
  try {
    const result = await fn();
    el.textContent = typeof result === 'string' ? result : okText;
    el.className = 'hint ok';
  } catch (e) {
    el.textContent = `连接失败：${e.message}`;
    el.className = 'hint err';
  }
}

$('btn-save').addEventListener('click', save);
$('btn-test').addEventListener('click', () =>
  runTest('test-result', () => testApiKey($('apiKey').value.trim()))
);
$('btn-test-openai').addEventListener('click', () =>
  runTest('test-openai-result', () =>
    testOpenAIKey($('openaiBaseUrl').value.trim(), $('openaiApiKey').value.trim())
  )
);
$('btn-test-atlas').addEventListener('click', () =>
  runTest('test-atlas-result', () => testAtlasKey('', $('atlasApiKey').value.trim()))
);
$('btn-test-comfy').addEventListener('click', () =>
  runTest('test-comfy-result', async () => {
    const { checkpoints, diffusionModels } = await testComfy($('comfyBaseUrl').value.trim());
    const all = [...checkpoints, ...diffusionModels];
    const list = $('comfy-checkpoints');
    list.innerHTML = '';
    for (const name of all) {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    }
    return all.length
      ? `连接成功，发现 ${all.length} 个模型（点模型输入框可选；Z-Image 系列自动用专属工作流）`
      : '连接成功，但没有发现可用模型';
  })
);
$('btn-test-flow').addEventListener('click', () =>
  runTest('test-flow-result', async () => {
    await testFlowAgent($('flowagentBaseUrl').value.trim());
    return '连接成功，FlowAgent 服务在线';
  })
);
load();
