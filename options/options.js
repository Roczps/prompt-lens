import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.js';
import { testApiKey } from '../lib/gemini.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['apiKey', 'analysisModel', 'imageModel', 'aspectRatio', 'imageSize', 'minImageSize'];

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) $(f).value = s[f];
  $('ballEnabled').checked = s.ballEnabled;
}

async function save() {
  const patch = { ballEnabled: $('ballEnabled').checked };
  for (const f of FIELDS) {
    let v = $(f).value.trim();
    if (f === 'minImageSize') v = Math.max(40, Number(v) || DEFAULT_SETTINGS.minImageSize);
    if ((f === 'analysisModel' || f === 'imageModel') && !v) v = DEFAULT_SETTINGS[f];
    patch[f] = v;
  }
  await saveSettings(patch);
  const el = $('save-result');
  el.textContent = '已保存';
  el.className = 'hint ok';
  setTimeout(() => (el.textContent = ''), 2000);
}

async function test() {
  const el = $('test-result');
  el.textContent = '测试中…';
  el.className = 'hint';
  try {
    await testApiKey($('apiKey').value.trim());
    el.textContent = '连接成功，Key 可用';
    el.className = 'hint ok';
  } catch (e) {
    el.textContent = `连接失败：${e.message}`;
    el.className = 'hint err';
  }
}

$('btn-save').addEventListener('click', save);
$('btn-test').addEventListener('click', test);
load();
