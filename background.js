import { getSettings } from './lib/settings.js';
import { reversePrompt, generateImage, describeCharacter } from './lib/gemini.js';
import { generateImageOpenAI, pollApimartTask } from './lib/openai.js';
import { uid, fetchImageData, dataUrlToBytes, dataUrlToInlinePart, makeThumbnail } from './lib/util.js';

const MAX_TASKS = 50;

// One-time migration: earlier versions defaulted the GPT-Image base URL to
// api.openai.com. If the user never configured a key, move them to the new
// APIMart default so the channel works out of the box.
chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(['openaiApiKey', 'openaiBaseUrl']);
  if (!s.openaiApiKey && s.openaiBaseUrl === 'https://api.openai.com/v1') {
    await chrome.storage.sync.set({ openaiBaseUrl: 'https://api.apimart.ai/v1' });
  }
});

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

/**
 * Read-modify-write a single generation record. Generations run for minutes;
 * writing back a stale whole-task snapshot would clobber concurrent updates
 * (e.g. a second generation started meanwhile).
 */
async function updateGen(taskId, genId, mutate) {
  const tasks = await getTasks();
  const gen = tasks[taskId]?.generations.find((g) => g.id === genId);
  if (!gen) return;
  mutate(gen);
  await chrome.storage.local.set({ tasks });
}

async function startGeneration({
  taskId,
  prompt,
  aspectRatio,
  imageSize,
  refMode = 'none',
  characterId = '',
  provider = ''
}) {
  const tasks = await getTasks();
  const task = tasks[taskId];
  if (!task) throw new Error('任务不存在');

  const settings = await getSettings();
  const useProvider = provider || settings.imageProvider || 'gemini';

  const gen = {
    id: uid(),
    createdAt: Date.now(),
    status: 'running',
    prompt,
    aspectRatio,
    imageSize,
    refMode,
    provider: useProvider,
    characterName: '',
    apimartTaskId: '',
    images: [],
    error: null
  };

  let charDataUrl = '';
  let charDesc = '';
  if (characterId) {
    const { characters = {} } = await chrome.storage.local.get('characters');
    const char = characters[characterId];
    if (char?.dataUrl) {
      charDataUrl = char.dataUrl;
      charDesc = char.desc || '';
      gen.characterName = char.name || '';
    }
  }

  task.generations.unshift(gen);
  await saveTask(task);

  try {
    const sourceDataUrl = task.source?.dataUrl || '';
    const poseRefDataUrl = refMode === 'pose' ? sourceDataUrl : '';
    const styleRefDataUrl = refMode === 'style' ? sourceDataUrl : '';

    let result;
    if (useProvider === 'openai') {
      if (!settings.openaiApiKey) {
        throw new Error('未配置 GPT-Image 渠道的 API Key。请到设置页填写。');
      }
      result = await generateImageOpenAI(
        {
          prompt,
          aspectRatio,
          imageSize,
          poseRefDataUrl,
          styleRefDataUrl,
          charDataUrl,
          charDesc,
          onTaskSubmitted: async (apimartTaskId) => {
            await updateGen(taskId, gen.id, (g) => {
              g.apimartTaskId = apimartTaskId;
            });
            await syncResumeAlarm();
          }
        },
        settings
      );
    } else {
      if (!settings.apiKey) throw new Error('未配置 Gemini API Key');
      result = await generateImage(
        {
          prompt,
          aspectRatio,
          imageSize,
          poseRefPart: poseRefDataUrl ? dataUrlToInlinePart(poseRefDataUrl) : null,
          styleRefPart: styleRefDataUrl ? dataUrlToInlinePart(styleRefDataUrl) : null,
          charPart: charDataUrl ? dataUrlToInlinePart(charDataUrl) : null,
          charDesc
        },
        settings
      );
    }
    const { images, text } = result;
    if (!images.length) {
      throw new Error(text ? `模型未返回图片：${text.slice(0, 200)}` : '模型未返回图片');
    }
    await updateGen(taskId, gen.id, (g) => {
      g.images = images;
      g.status = 'done';
    });
  } catch (e) {
    // A pending APIMart task is not a failure: keep it running, the resume
    // alarm keeps polling even if this service worker instance dies.
    if (!e?.pending) {
      await updateGen(taskId, gen.id, (g) => {
        g.status = 'error';
        g.error = String(e?.message || e);
      });
    }
  }
  await syncResumeAlarm();
}

// ---- Recovery for in-flight APIMart tasks across service worker restarts ----

const activePolls = new Set();

async function syncResumeAlarm() {
  const tasks = await getTasks();
  const hasPending = Object.values(tasks).some((t) =>
    t.generations.some((g) => g.status === 'running' && g.apimartTaskId)
  );
  if (hasPending) {
    chrome.alarms.create('plens-resume', { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear('plens-resume');
  }
}

async function resumePendingGenerations() {
  const tasks = await getTasks();
  const settings = await getSettings();
  for (const task of Object.values(tasks)) {
    for (const gen of task.generations) {
      if (gen.status !== 'running') continue;
      if (gen.apimartTaskId) {
        if (activePolls.has(gen.id)) continue;
        activePolls.add(gen.id);
        pollApimartTask(gen.apimartTaskId, settings)
          .then(({ images }) =>
            updateGen(task.id, gen.id, (g) => {
              g.images = images;
              g.status = 'done';
            })
          )
          .catch((e) => {
            if (e?.pending) return; // alarm will re-enter later
            return updateGen(task.id, gen.id, (g) => {
              g.status = 'error';
              g.error = String(e?.message || e);
            });
          })
          .finally(() => {
            activePolls.delete(gen.id);
            syncResumeAlarm();
          });
      } else if (Date.now() - gen.createdAt > 10 * 60 * 1000) {
        // Non-resumable run (Gemini or pre-submit) whose worker died.
        await updateGen(task.id, gen.id, (g) => {
          g.status = 'error';
          g.error = '生成中断（浏览器回收了插件后台），请重试';
        });
      }
    }
  }
  await syncResumeAlarm();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'plens-resume') resumePendingGenerations();
});

// Runs on every service worker start-up (including after Chrome reclaims it).
resumePendingGenerations();

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
    case 'RESUME_PENDING': {
      resumePendingGenerations();
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});
