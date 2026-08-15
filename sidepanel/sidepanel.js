import { getSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

const AXIS_LABELS = {
  subject: '主体',
  style: '风格',
  composition: '构图',
  lighting: '光线',
  color: '色彩',
  mood: '氛围'
};

const ANALYSIS_LABELS = {
  subject: '主体',
  pose: '姿势',
  environment: '环境',
  composition: '构图',
  lighting: '光线',
  color: '色彩',
  style: '风格',
  details: '细节',
  mood: '氛围'
};

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

const REF_MODE_LABELS = { pose: '姿势复刻', style: '风格参考', none: '' };
const PROVIDER_LABELS = { gemini: 'Gemini', openai: 'GPT-Image' };

async function loadState() {
  const { tasks = {}, activeTaskId = null } = await chrome.storage.local.get(['tasks', 'activeTaskId']);
  state = { tasks, activeTaskId };
}

function activeTask() {
  return state.activeTaskId ? state.tasks[state.activeTaskId] : null;
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

function render() {
  const task = activeTask();
  $('empty-state').classList.toggle('hidden', !!task);
  $('task-view').classList.toggle('hidden', !task);
  renderHistory();
  if (!task) {
    renderedTaskId = null;
    return;
  }

  // Avoid clobbering the prompt textarea while the user edits it: only
  // re-render task details when the task actually changed.
  const stamp = JSON.stringify([task.id, task.status, task.error, task.generations.map((g) => [g.id, g.status])]);
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

  const errEl = $('task-error');
  errEl.classList.toggle('hidden', !task.error);
  errEl.textContent = task.error || '';

  const hasResult = !!task.result;
  $('result-block').classList.toggle('hidden', !hasResult);
  if (hasResult) {
    // Fill the textarea the first time this task's result appears (including
    // the analyzing -> done transition), but never afterwards, so user edits
    // survive re-renders triggered by generation status updates.
    if (renderedResultFor !== task.id) {
      $('prompt-en').value = task.result.prompt || '';
      renderedResultFor = task.id;
    }
    $('prompt-zh').textContent = task.result.promptZh || '（无）';
    const typeBadge = $('image-type');
    typeBadge.textContent = task.result.imageType || '';
    typeBadge.classList.toggle('hidden', !task.result.imageType);
    renderAnalysis(task.result.analysis || {});
    renderTags(task.result.tags || {});
    renderPalette(task.result.palette || []);
    renderGenerations(task);
  }
}

function renderAnalysis(analysis) {
  const box = $('analysis');
  box.innerHTML = '';
  for (const [key, label] of Object.entries(ANALYSIS_LABELS)) {
    const text = analysis[key];
    if (!text) continue;
    const row = document.createElement('div');
    row.className = 'ana-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'ana-label';
    labelEl.textContent = label;
    const textEl = document.createElement('span');
    textEl.className = 'ana-text';
    textEl.textContent = text;
    textEl.title = '点击复制';
    textEl.addEventListener('click', () => navigator.clipboard.writeText(text));
    row.append(labelEl, textEl);
    box.appendChild(row);
  }
  box.classList.toggle('hidden', !box.children.length);
}

function renderTags(tags) {
  const box = $('tags');
  box.innerHTML = '';
  for (const [axis, label] of Object.entries(AXIS_LABELS)) {
    const items = tags[axis];
    if (!Array.isArray(items) || !items.length) continue;
    const group = document.createElement('div');
    group.className = 'tag-group';
    const axisEl = document.createElement('div');
    axisEl.className = 'tag-axis';
    axisEl.textContent = label;
    const row = document.createElement('div');
    row.className = 'tag-row';
    for (const t of items) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = t;
      chip.title = '点击复制';
      chip.addEventListener('click', () => navigator.clipboard.writeText(t));
      row.appendChild(chip);
    }
    group.append(axisEl, row);
    box.appendChild(group);
  }
}

function renderPalette(palette) {
  const box = $('palette');
  box.innerHTML = '';
  box.classList.toggle('hidden', !palette.length);
  for (const hex of palette) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = hex;
    sw.dataset.hex = hex;
    sw.title = '点击复制色值';
    sw.addEventListener('click', () => navigator.clipboard.writeText(hex));
    box.appendChild(sw);
  }
}

function renderGenerations(task) {
  const box = $('generations');
  box.innerHTML = '';
  for (const gen of task.generations) {
    const item = document.createElement('div');
    item.className = 'gen-item';

    const meta = document.createElement('div');
    meta.className = 'gen-meta';
    const statusText = gen.status === 'running' ? '生成中…' : gen.status === 'error' ? '失败' : '完成';
    const modeText = [PROVIDER_LABELS[gen.provider] || '', REF_MODE_LABELS[gen.refMode] || '', gen.characterName || '']
      .filter(Boolean)
      .join(' · ');
    meta.innerHTML = `<span>${gen.aspectRatio} · ${gen.imageSize}${modeText ? ' · ' + modeText : ''}</span><span>${statusText} · ${fmtTime(gen.createdAt)}</span>`;
    item.appendChild(meta);

    if (gen.status === 'error') {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = gen.error || '生成失败';
      item.appendChild(err);
    }

    gen.images.forEach((dataUrl, i) => {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.title = '点击查看大图';
      img.classList.add('zoomable');
      img.addEventListener('click', () => openViewer(task.id, { g: gen.id, i: String(i) }));
      item.appendChild(img);

      const actions = document.createElement('div');
      actions.className = 'gen-actions';
      const dl = document.createElement('button');
      dl.className = 'chip-btn';
      dl.textContent = '下载';
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `prompt-lens-${gen.id}${gen.images.length > 1 ? '-' + (i + 1) : ''}.png`;
        a.click();
      });
      const cp = document.createElement('button');
      cp.className = 'chip-btn';
      cp.textContent = '复制提示词';
      cp.addEventListener('click', () => {
        navigator.clipboard.writeText(gen.prompt);
        flashButton(cp);
      });
      actions.append(dl, cp);
      item.appendChild(actions);
    });

    box.appendChild(item);
  }
}

function renderHistory() {
  const ids = Object.values(state.tasks)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => t.id);
  $('history-section').classList.toggle('hidden', !ids.length);
  const list = $('history-list');
  list.innerHTML = '';
  for (const id of ids) {
    const t = state.tasks[id];
    const item = document.createElement('div');
    item.className = 'history-item' + (id === state.activeTaskId ? ' active' : '');

    const img = document.createElement('img');
    img.src = t.source?.dataUrl || '';

    const text = document.createElement('div');
    text.className = 'h-text';
    const p = document.createElement('div');
    p.className = 'h-prompt';
    p.textContent = t.result?.prompt || t.error || STATUS_TEXT[t.status] || '';
    const time = document.createElement('div');
    time.className = 'h-time';
    time.textContent = fmtTime(t.createdAt) + (t.generations.length ? ` · ${t.generations.length} 次生成` : '');
    text.append(p, time);

    const del = document.createElement('button');
    del.className = 'h-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      delete state.tasks[id];
      const patch = { tasks: state.tasks };
      if (state.activeTaskId === id) {
        state.activeTaskId = null;
        patch.activeTaskId = null;
      }
      await chrome.storage.local.set(patch);
    });

    item.append(img, text, del);
    item.addEventListener('click', () => chrome.storage.local.set({ activeTaskId: id }));
    list.appendChild(item);
  }
}

async function loadChars() {
  const { characters = {} } = await chrome.storage.local.get('characters');
  chars = characters;
}

function renderChars() {
  const arr = Object.values(chars).sort((a, b) => a.createdAt - b.createdAt);
  $('chars-empty').classList.toggle('hidden', !!arr.length);

  const list = $('char-list');
  list.innerHTML = '';
  for (const c of arr) {
    const item = document.createElement('div');
    item.className = 'char-item';

    const img = document.createElement('img');
    img.src = c.dataUrl;
    img.title = c.desc || '';

    const info = document.createElement('div');
    info.className = 'char-info';
    const name = document.createElement('span');
    name.className = 'char-name';
    name.textContent = c.name;
    // setAttribute never throws, unlike the property setter on older Chromes.
    name.setAttribute('contenteditable', 'plaintext-only');
    name.spellcheck = false;
    name.title = '点击修改名称';
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      }
    });
    name.addEventListener('blur', async () => {
      const v = name.textContent.trim();
      if (v && v !== c.name) {
        chars[c.id].name = v;
        await chrome.storage.local.set({ characters: chars });
      } else {
        name.textContent = c.name;
      }
    });
    const hint = document.createElement('span');
    hint.className = 'char-hint';
    if (c.status === 'analyzing') {
      hint.textContent = '识别外貌中…';
    } else if (c.error) {
      hint.textContent = c.error;
      hint.classList.add('char-hint-error');
    } else {
      hint.textContent = c.desc || '';
    }
    info.append(name, hint);

    const del = document.createElement('button');
    del.className = 'h-del';
    del.textContent = '✕';
    del.title = '删除角色卡';
    del.addEventListener('click', async () => {
      if (!confirm(`删除角色卡「${c.name}」？`)) return;
      delete chars[c.id];
      await chrome.storage.local.set({ characters: chars });
    });

    item.append(img, info, del);
    list.appendChild(item);
  }

  const sel = $('gen-character');
  const prev = sel.value;
  sel.innerHTML = '<option value="">不替换</option>';
  for (const c of arr) {
    if (!c.dataUrl) continue;
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function createCharacter(dataUrl) {
  const count = Object.keys(chars).length + 1;
  chrome.runtime.sendMessage({
    type: 'SAVE_CHARACTER',
    payload: { dataUrl, name: `角色 ${count}` }
  });
}

async function init() {
  const settings = await getSettings();
  $('gen-aspect').value = settings.aspectRatio;
  $('gen-size').value = settings.imageSize;
  $('gen-provider').value = settings.imageProvider || 'gemini';

  $('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('btn-copy-en').addEventListener('click', () => {
    navigator.clipboard.writeText($('prompt-en').value);
    flashButton($('btn-copy-en'));
  });
  $('btn-copy-zh').addEventListener('click', () => {
    navigator.clipboard.writeText($('prompt-zh').textContent);
    flashButton($('btn-copy-zh'));
  });

  $('btn-generate').addEventListener('click', async () => {
    const genErr = $('gen-error');
    genErr.classList.add('hidden');
    const task = activeTask();
    if (!task) return;
    const prompt = $('prompt-en').value.trim();
    if (!prompt) {
      genErr.textContent = '提示词为空，请先反推或手动填写提示词';
      genErr.classList.remove('hidden');
      return;
    }
    const btn = $('btn-generate');
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE',
        payload: {
          taskId: task.id,
          prompt,
          aspectRatio: $('gen-aspect').value,
          imageSize: $('gen-size').value,
          refMode: $('gen-refmode').value,
          characterId: $('gen-character').value,
          provider: $('gen-provider').value
        }
      });
      if (res && !res.ok) {
        genErr.textContent = res.error;
        genErr.classList.remove('hidden');
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('确定清空所有历史记录？')) return;
    await chrome.storage.local.set({ tasks: {}, activeTaskId: null });
  });

  $('btn-char-from-task').addEventListener('click', () => {
    const task = activeTask();
    if (!task?.source?.dataUrl) return;
    createCharacter(task.source.dataUrl);
  });
  $('btn-char-upload').addEventListener('click', () => $('char-file').click());
  $('char-file').addEventListener('change', () => {
    const file = $('char-file').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => createCharacter(reader.result);
    reader.readAsDataURL(file);
    $('char-file').value = '';
  });

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

  $('source-img').addEventListener('click', () => {
    const task = activeTask();
    if (task?.source?.dataUrl) openViewer(task.id, { src: '1' });
  });

  // Wake the service worker so it resumes polling any in-flight APIMart
  // generations that were interrupted by a worker restart.
  chrome.runtime.sendMessage({ type: 'RESUME_PENDING' }).catch(() => {});

  await Promise.all([loadState(), loadChars()]);
  render();
  renderChars();
}

init();
