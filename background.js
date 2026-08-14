import { getSettings } from './lib/settings.js';
import { reversePrompt, generateImage, describeCharacter } from './lib/gemini.js';
import { uid, fetchImageData, dataUrlToBytes, dataUrlToInlinePart, makeThumbnail } from './lib/util.js';

const MAX_TASKS = 50;

async function getTasks() {
  const { tasks = {} } = await chrome.storage.local.get('tasks');
  return tasks;
}

async function saveTask(task, { activate = false } = {}) {
  const tasks = await getTasks();
  tasks[task.id] = task;
  const ids = Object.values(tasks)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => t.id);
  for (const id of ids.slice(MAX_TASKS)) delete tasks[id];
  const patch = { tasks };
  if (activate) patch.activeTaskId = task.id;
  await chrome.storage.local.set(patch);
}

async function startAnalysis(source) {
  const task = {
    id: uid(),
    createdAt: Date.now(),
    status: 'fetching',
    source,
    result: null,
    error: null,
    generations: []
  };
  await saveTask(task, { activate: true });

  try {
    let bytes, mime;
    if (source.kind === 'url') {
      ({ bytes, mime } = await fetchImageData(source.url));
    } else {
      ({ bytes, mime } = dataUrlToBytes(source.dataUrl));
    }
    // 1280px keeps enough fine detail (fabric texture, small text, faces)
    // for a faithful reverse-prompt without blowing up token usage.
    const thumb = await makeThumbnail(bytes, mime, 1280);
    task.source = { ...source, dataUrl: thumb.dataUrl };

    task.status = 'analyzing';
    await saveTask(task);

    const settings = await getSettings();
    if (!settings.apiKey) {
      throw new Error('未配置 API Key。请点击插件图标 → 设置，填入 Gemini API Key。');
    }
    task.result = await reversePrompt({ base64: thumb.base64, mimeType: thumb.mimeType }, settings);
    task.status = 'done';
  } catch (e) {
    task.status = 'error';
    task.error = String(e?.message || e);
  }
  await saveTask(task);
}

async function startGeneration({ taskId, prompt, aspectRatio, imageSize, refMode = 'none', characterId = '' }) {
  const tasks = await getTasks();
  const task = tasks[taskId];
  if (!task) throw new Error('任务不存在');

  const gen = {
    id: uid(),
    createdAt: Date.now(),
    status: 'running',
    prompt,
    aspectRatio,
    imageSize,
    refMode,
    characterName: '',
    images: [],
    error: null
  };

  let charPart = null;
  let charDesc = '';
  if (characterId) {
    const { characters = {} } = await chrome.storage.local.get('characters');
    const char = characters[characterId];
    if (char?.dataUrl) {
      charPart = dataUrlToInlinePart(char.dataUrl);
      charDesc = char.desc || '';
      gen.characterName = char.name || '';
    }
  }

  task.generations.unshift(gen);
  await saveTask(task);

  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error('未配置 API Key');
    const sourcePart = task.source?.dataUrl ? dataUrlToInlinePart(task.source.dataUrl) : null;
    const { images, text } = await generateImage(
      {
        prompt,
        aspectRatio,
        imageSize,
        poseRefPart: refMode === 'pose' ? sourcePart : null,
        styleRefPart: refMode === 'style' ? sourcePart : null,
        charPart,
        charDesc
      },
      settings
    );
    if (!images.length) {
      throw new Error(text ? `模型未返回图片：${text.slice(0, 200)}` : '模型未返回图片');
    }
    gen.images = images;
    gen.status = 'done';
  } catch (e) {
    gen.status = 'error';
    gen.error = String(e?.message || e);
  }
  await saveTask(task);
}

async function saveCharacterRecord(char) {
  const { characters = {} } = await chrome.storage.local.get('characters');
  characters[char.id] = char;
  await chrome.storage.local.set({ characters });
}

async function createCharacter({ dataUrl, name }) {
  const char = {
    id: uid(),
    createdAt: Date.now(),
    name: name || '角色',
    dataUrl: '',
    desc: '',
    status: 'analyzing',
    error: null
  };
  try {
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    const thumb = await makeThumbnail(bytes, mime, 1024);
    char.dataUrl = thumb.dataUrl;
    await saveCharacterRecord(char);

    const settings = await getSettings();
    if (settings.apiKey) {
      try {
        char.desc = await describeCharacter({ base64: thumb.base64, mimeType: thumb.mimeType }, settings);
      } catch (e) {
        // Card is still usable without the text description.
        char.error = `外貌识别失败：${e?.message || e}`;
      }
    } else {
      char.error = '未配置 API Key，跳过外貌识别';
    }
    char.status = 'done';
  } catch (e) {
    char.status = 'error';
    char.error = String(e?.message || e);
  }
  await saveCharacterRecord(char);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'ANALYZE_IMAGE': {
      // Must be called synchronously to keep the user-gesture context.
      if (sender.tab?.id != null) {
        chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
      }
      startAnalysis({
        kind: 'url',
        url: msg.payload.srcUrl,
        pageUrl: msg.payload.pageUrl || sender.tab?.url || ''
      });
      sendResponse({ ok: true });
      return false;
    }
    case 'ANALYZE_DATA': {
      startAnalysis({ kind: 'data', dataUrl: msg.payload.dataUrl, name: msg.payload.name || '' });
      sendResponse({ ok: true });
      return false;
    }
    case 'GENERATE': {
      // Run async; progress and errors are written to the gen record in
      // storage, which the side panel re-renders from.
      startGeneration(msg.payload).catch((e) => console.error('generation failed:', e));
      sendResponse({ ok: true });
      return false;
    }
    case 'SAVE_CHARACTER': {
      createCharacter(msg.payload).catch((e) => console.error('save character failed:', e));
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});
