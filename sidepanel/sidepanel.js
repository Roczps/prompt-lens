import { getSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

const AXIS_LABELS = {
  subject: '主体',
  style: '风格',
  composition: '构图',
  color: '色彩',
  mood: '氛围'
};

const STATUS_TEXT = {
  fetching: '获取图片中',
  analyzing: '反推提示词中',
  done: '反推完成',
  error: '出错了'
};

let state = { tasks: {}, activeTaskId: null };
let renderedTaskId = null;
let renderedStamp = '';

async function loadState() {
  const { tasks = {}, activeTaskId = null } = await chrome.storage.local.get(['tasks', 'activeTaskId']);
  state = { tasks, activeTaskId };
}

function activeTask() {
  return state.activeTaskId ? state.tasks[state.activeTaskId] : null;
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
  const taskChanged = task.id !== renderedTaskId;
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
    if (taskChanged) $('prompt-en').value = task.result.prompt || '';
    $('prompt-zh').textContent = task.result.promptZh || '（无）';
    renderTags(task.result.tags || {});
    renderPalette(task.result.palette || []);
    renderGenerations(task);
  }
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
    meta.innerHTML = `<span>${gen.aspectRatio} · ${gen.imageSize}</span><span>${statusText} · ${fmtTime(gen.createdAt)}</span>`;
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

async function init() {
  const settings = await getSettings();
  $('gen-aspect').value = settings.aspectRatio;
  $('gen-size').value = settings.imageSize;

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
    const task = activeTask();
    if (!task) return;
    const prompt = $('prompt-en').value.trim();
    if (!prompt) return;
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
          useRef: $('gen-useref').checked
        }
      });
      if (res && !res.ok) alert(res.error);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('确定清空所有历史记录？')) return;
    await chrome.storage.local.set({ tasks: {}, activeTaskId: null });
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.tasks || changes.activeTaskId) {
      await loadState();
      render();
    }
  });

  await loadState();
  render();
}

init();
