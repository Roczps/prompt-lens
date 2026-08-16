import { getSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

const PROVIDER_LABELS = {
  gemini: 'Gemini',
  openai: 'GPT-Image',
  seedream: 'Seedream',
  comfy: 'ComfyUI',
  flowagent: 'FlowAgent 视频'
};
const REF_MODE_LABELS = { pose: '姿势复刻', style: '风格参考', none: '', source: '图生视频' };
const STATUS_TEXT = {
  fetching: '获取图片中',
  analyzing: '反推提示词中',
  done: '反推完成',
  error: '出错了'
};

let state = { tasks: {}, activeTaskId: null };
let chars = {};
let renderedTaskId = null;
let renderedStamp = '';
let renderedResultFor = null;

function activeTask() {
  return state.activeTaskId ? state.tasks[state.activeTaskId] : null;
}

async function loadState() {
  const { tasks = {}, activeTaskId = null } = await chrome.storage.local.get(['tasks', 'activeTaskId']);
  state = { tasks, activeTaskId };
}

async function loadChars() {
  const { characters = {} } = await chrome.storage.local.get('characters');
  chars = characters;
}

function openViewer(taskId, extra) {
  const p = new URLSearchParams({ t: taskId, ...extra });
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/viewer.html#${p.toString()}`) });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function flashButton(btn, text = '已复制') {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

// ---- rendering ----

function render() {
  const task = activeTask();
  $('empty-state').classList.toggle('hidden', !!task);
  $('workspace').classList.toggle('hidden', !task);
  renderTaskStrip();
  if (!task) {
    renderedTaskId = null;
    return;
  }

  // Skip re-render when nothing this page cares about changed, so prompt
  // textarea edits survive storage-driven refreshes.
  const stamp = JSON.stringify([
    task.id,
    task.status,
    task.error,
    task.generations.map((g) => [g.id, g.status])
  ]);
  if (task.id === renderedTaskId && stamp === renderedStamp) return;
  renderedTaskId = task.id;
  renderedStamp = stamp;

  $('source-img').src = task.source?.dataUrl || '';
  const statusEl = $('task-status');
  statusEl.textContent = STATUS_TEXT[task.status] || task.status;
  statusEl.classList.toggle('running', task.status === 'fetching' || task.status === 'analyzing');

  const link = $('source-link');
  if (task.source?.pageUrl) {
    link.href = task.source.pageUrl;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  showError('task-error', task.error);

  if (task.result) {
    if (renderedResultFor !== task.id) {
      $('prompt-en').value = task.result.prompt || '';
      renderedResultFor = task.id;
    }
    $('prompt-zh').textContent = task.result.promptZh || '（无）';
  }
  renderPalette(task.result?.palette || []);
  renderResults(task);
}

function renderPalette(palette) {
  const box = $('palette');
  box.innerHTML = '';
  box.classList.toggle('hidden', !palette.length);
  for (const hex of palette) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = hex;
    sw.title = `${hex} · 点击复制`;
    sw.addEventListener('click', () => navigator.clipboard.writeText(hex));
    box.appendChild(sw);
  }
}

function renderTaskStrip() {
  const strip = $('task-strip');
  strip.innerHTML = '';
  const arr = Object.values(state.tasks).sort((a, b) => b.createdAt - a.createdAt);
  strip.classList.toggle('hidden', arr.length < 2);
  for (const t of arr) {
    const item = document.createElement('button');
    item.className = 'strip-item' + (t.id === state.activeTaskId ? ' active' : '');
    item.title = t.result?.prompt?.slice(0, 120) || STATUS_TEXT[t.status] || '';
    const img = document.createElement('img');
    img.src = t.source?.dataUrl || '';
    item.appendChild(img);
    item.addEventListener('click', () => chrome.storage.local.set({ activeTaskId: t.id }));
    strip.appendChild(item);
  }
}

/**
 * Group generations for the comparison grid: one row per compare batch or
 * post set, standalone generations get a row of their own. `generations` is
 * stored newest-first, which keeps groups ordered newest-first too.
 */
function groupGenerations(task) {
  const groups = new Map();
  for (const gen of task.generations) {
    const key = gen.compareId || gen.setId || gen.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(gen);
  }
  // Within a compare batch keep a stable provider order; sets keep setIndex.
  for (const gens of groups.values()) {
    if (gens[0]?.setId) gens.sort((a, b) => a.setIndex - b.setIndex);
    else gens.reverse(); // unshift order -> submission order
  }
  return [...groups.values()];
}

function genKindBadge(gen) {
  if (gen.kind === 'video') return PROVIDER_LABELS.flowagent;
  return PROVIDER_LABELS[gen.provider] || gen.provider;
}

function renderResults(task) {
  const box = $('results');
  box.innerHTML = '';
  for (const gens of groupGenerations(task)) {
    const first = gens[0];
    const batch = document.createElement('div');
    batch.className = 'card batch';

    const head = document.createElement('div');
    head.className = 'batch-head';
    const kindText = first.setId
      ? `组图 · ${first.setPreset || '自动'}`
      : first.compareId
        ? `对比 · ${gens.length} 个渠道`
        : first.kind === 'video'
          ? '视频'
          : '单张生成';
    const metaBits = [
      kindText,
      first.aspectRatio && first.imageSize ? `${first.aspectRatio} · ${first.imageSize}` : '',
      first.kind === 'video' && first.duration ? `${first.duration} 秒` : '',
      REF_MODE_LABELS[first.refMode] || '',
      first.characterName || '',
      fmtTime(first.createdAt)
    ].filter(Boolean);
    const title = document.createElement('span');
    title.className = 'batch-title';
    title.textContent = metaBits.join(' · ');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'chip-btn';
    copyBtn.textContent = '复制提示词';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(first.prompt);
      flashButton(copyBtn);
    });
    head.append(title, copyBtn);
    batch.appendChild(head);

    const prompt = document.createElement('div');
    prompt.className = 'batch-prompt dim';
    prompt.textContent = first.prompt;
    batch.appendChild(prompt);

    const cells = document.createElement('div');
    cells.className = 'cells';
    for (const gen of gens) cells.appendChild(renderCell(task, gen));
    batch.appendChild(cells);
    box.appendChild(batch);
  }
}

function renderCell(task, gen) {
  const cell = document.createElement('div');
  cell.className = 'cell';

  const label = document.createElement('div');
  label.className = 'cell-label';
  const name = document.createElement('span');
  name.textContent = gen.setLabel ? `${gen.setIndex}. ${gen.setLabel}` : genKindBadge(gen);
  const status = document.createElement('span');
  status.className = 'cell-status ' + gen.status;
  status.textContent = gen.status === 'running' ? '生成中…' : gen.status === 'error' ? '失败' : '完成';
  label.append(name, status);
  cell.appendChild(label);

  if (gen.status === 'running') {
    const ph = document.createElement('div');
    ph.className = 'cell-placeholder running';
    ph.textContent = gen.kind === 'video' ? '视频生成中，通常需要 1-3 分钟…' : '生成中…';
    cell.appendChild(ph);
  } else if (gen.status === 'error') {
    const err = document.createElement('div');
    err.className = 'error cell-error';
    err.textContent = gen.error || '生成失败';
    cell.appendChild(err);
    const retry = document.createElement('button');
    retry.className = 'chip-btn';
    retry.textContent = '重试';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      chrome.runtime.sendMessage({
        type: 'RETRY_GEN',
        payload: { taskId: task.id, genId: gen.id, provider: gen.provider }
      });
    });
    cell.appendChild(retry);
  }

  (gen.videos || []).forEach((dataUrl, i) => {
    const video = document.createElement('video');
    video.src = dataUrl;
    video.controls = true;
    video.loop = true;
    video.className = 'cell-video';
    cell.appendChild(video);
    cell.appendChild(makeDownloadRow(dataUrl, `prompt-lens-${gen.id}${gen.videos.length > 1 ? '-' + (i + 1) : ''}.mp4`));
  });

  (gen.images || []).forEach((dataUrl, i) => {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'cell-img';
    img.title = '点击查看大图';
    img.addEventListener('click', () => openViewer(task.id, { g: gen.id, i: String(i) }));
    cell.appendChild(img);
    cell.appendChild(makeDownloadRow(dataUrl, `prompt-lens-${gen.id}${gen.images.length > 1 ? '-' + (i + 1) : ''}.png`));
  });

  return cell;
}

function makeDownloadRow(dataUrl, filename) {
  const row = document.createElement('div');
  row.className = 'cell-actions';
  const dl = document.createElement('button');
  dl.className = 'chip-btn';
  dl.textContent = '下载';
  dl.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  });
  row.appendChild(dl);
  return row;
}

function renderChars() {
  const sel = $('gen-character');
  const prev = sel.value;
  sel.innerHTML = '<option value="">不替换</option>';
  for (const c of Object.values(chars).sort((a, b) => a.createdAt - b.createdAt)) {
    if (!c.dataUrl) continue;
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ---- actions ----

function analyzeDataUrl(dataUrl, name = '') {
  chrome.runtime.sendMessage({ type: 'ANALYZE_DATA', payload: { dataUrl, name } });
}

function selectedProviders() {
  return [...document.querySelectorAll('.prov:checked')].map((el) => el.value);
}

async function generateCompare() {
  showError('gen-error', '');
  const task = activeTask();
  if (!task) return;
  const prompt = $('prompt-en').value.trim();
  if (!prompt) {
    showError('gen-error', '提示词为空，请先反推或手动填写提示词');
    return;
  }
  const providers = selectedProviders();
  if (!providers.length) {
    showError('gen-error', '请至少勾选一个生图渠道');
    return;
  }
  const btn = $('btn-generate');
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_COMPARE',
      payload: {
        taskId: task.id,
        prompt,
        aspectRatio: $('gen-aspect').value,
        imageSize: $('gen-size').value,
        refMode: $('gen-refmode').value,
        characterId: $('gen-character').value,
        providers
      }
    });
    if (res && !res.ok) showError('gen-error', res.error);
  } finally {
    btn.disabled = false;
  }
}

async function generateVideo() {
  showError('video-error', '');
  const task = activeTask();
  if (!task) return;
  const prompt = $('video-prompt').value.trim() || $('prompt-en').value.trim();
  if (!prompt) {
    showError('video-error', '视频提示词为空');
    return;
  }
  const btn = $('btn-generate-video');
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_VIDEO',
      payload: {
        taskId: task.id,
        prompt,
        duration: Number($('video-duration').value),
        withImage: $('video-with-image').checked
      }
    });
    if (res && !res.ok) showError('video-error', res.error);
  } finally {
    btn.disabled = false;
  }
}

// ---- init ----

async function init() {
  const settings = await getSettings();
  $('gen-aspect').value = settings.aspectRatio;
  $('gen-size').value = settings.imageSize;
  $('video-duration').value = String(settings.videoDuration || 8);
  const checkedDefault = document.querySelector(`.prov[value="${settings.imageProvider}"]`);
  if (checkedDefault) checkedDefault.checked = true;

  // Deep link from the side panel: ?t=<taskId> selects that task.
  const urlTaskId = new URLSearchParams(location.search).get('t');
  if (urlTaskId) await chrome.storage.local.set({ activeTaskId: urlTaskId });

  $('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    const file = $('file-input').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => analyzeDataUrl(reader.result, file.name);
    reader.readAsDataURL(file);
    $('file-input').value = '';
  });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const reader = new FileReader();
    reader.onload = () => analyzeDataUrl(reader.result);
    reader.readAsDataURL(item.getAsFile());
  });

  $('btn-copy-en').addEventListener('click', () => {
    navigator.clipboard.writeText($('prompt-en').value);
    flashButton($('btn-copy-en'));
  });
  $('btn-reanalyze').addEventListener('click', () => {
    const task = activeTask();
    if (task?.source?.dataUrl) analyzeDataUrl(task.source.dataUrl);
  });
  $('source-img').addEventListener('click', () => {
    const task = activeTask();
    if (task?.source?.dataUrl) openViewer(task.id, { src: '1' });
  });

  $('btn-generate').addEventListener('click', generateCompare);
  $('btn-generate-video').addEventListener('click', generateVideo);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.tasks || changes.activeTaskId) {
      await loadState();
      render();
    }
    if (changes.characters) {
      chars = changes.characters.newValue || {};
      renderChars();
    }
  });

  // Wake the service worker so interrupted remote polls resume.
  chrome.runtime.sendMessage({ type: 'RESUME_PENDING' }).catch(() => {});

  await Promise.all([loadState(), loadChars()]);
  render();
  renderChars();
}

init();
