import { getSettings } from './lib/settings.js';
import { reversePrompt, generateImage, describeCharacter, planPostSet } from './lib/gemini.js';
import { generateImageOpenAI, pollApimartTask } from './lib/openai.js';
import { getPreset, NEGATIVE_TAIL } from './lib/presets.js';
import { uid, fetchImageData, dataUrlToBytes, dataUrlToInlinePart, makeThumbnail, friendlyGenError } from './lib/util.js';

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

async function getCharacter(characterId) {
  if (!characterId) return null;
  const { characters = {} } = await chrome.storage.local.get('characters');
  const char = characters[characterId];
  return char?.dataUrl ? char : null;
}

function makeGenRecord(params) {
  return {
    id: uid(),
    createdAt: Date.now(),
    status: 'running',
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    imageSize: params.imageSize,
    refMode: params.refMode,
    provider: params.provider,
    characterId: params.characterId || '',
    characterName: params.characterName || '',
    setId: params.setId || '',
    setLabel: params.setLabel || '',
    setIndex: params.setIndex || 0,
    setTotal: params.setTotal || 0,
    setPreset: params.setPreset || '',
    refGenId: params.refGenId || '',
    apimartTaskId: '',
    images: [],
    error: null
  };
}

/** Execute one persisted generation record (used by single runs, sets, retries). */
async function executeGeneration(taskId, genId) {
  const tasks = await getTasks();
  const task = tasks[taskId];
  const gen = task?.generations.find((g) => g.id === genId);
  if (!task || !gen) return;

  try {
    const settings = await getSettings();
    const char = await getCharacter(gen.characterId);
    let charDataUrl = char?.dataUrl || '';
    let charDesc = char?.desc || '';
    const sourceDataUrl = task.source?.dataUrl || '';
    let poseRefDataUrl = gen.refMode === 'pose' ? sourceDataUrl : '';
    let styleRefDataUrl = gen.refMode === 'style' ? sourceDataUrl : '';

    // Set shots anchored on an earlier generation (e.g. character-swapped
    // image): that image already carries the right face, wardrobe and style,
    // so it becomes the character reference. Drop the card's own image/desc --
    // its outfit usually differs and would fight the anchor.
    if (gen.refGenId) {
      const anchor = task.generations.find((g) => g.id === gen.refGenId && g.images?.[0]);
      if (anchor) {
        charDataUrl = anchor.images[0];
        charDesc = '';
        poseRefDataUrl = '';
        styleRefDataUrl = '';
      }
    }

    let result;
    if (gen.provider === 'openai') {
      if (!settings.openaiApiKey) {
        throw new Error('未配置 GPT-Image 渠道的 API Key。请到设置页填写。');
      }
      result = await generateImageOpenAI(
        {
          prompt: gen.prompt,
          aspectRatio: gen.aspectRatio,
          imageSize: gen.imageSize,
          poseRefDataUrl,
          styleRefDataUrl,
          charDataUrl,
          charDesc,
          onTaskSubmitted: async (apimartTaskId) => {
            await updateGen(taskId, genId, (g) => {
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
          prompt: gen.prompt,
          aspectRatio: gen.aspectRatio,
          imageSize: gen.imageSize,
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
    await updateGen(taskId, genId, (g) => {
      g.images = images;
      g.status = 'done';
    });
  } catch (e) {
    // A pending APIMart task is not a failure: keep it running, the resume
    // alarm keeps polling even if this service worker instance dies.
    if (!e?.pending) {
      await updateGen(taskId, genId, (g) => {
        g.status = 'error';
        g.error = friendlyGenError(e);
      });
    }
  }
  await syncResumeAlarm();
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
  const char = await getCharacter(characterId);
  const gen = makeGenRecord({
    prompt,
    aspectRatio,
    imageSize,
    refMode,
    provider: provider || settings.imageProvider || 'gemini',
    characterId: char ? characterId : '',
    characterName: char?.name || ''
  });
  task.generations.unshift(gen);
  await saveTask(task);
  await executeGeneration(taskId, gen.id);
}

async function retryGeneration({ taskId, genId, provider = '' }) {
  await updateGen(taskId, genId, (g) => {
    g.status = 'running';
    g.error = null;
    g.apimartTaskId = '';
    g.images = [];
    g.createdAt = Date.now();
    if (provider) g.provider = provider;
  });
  await executeGeneration(taskId, genId);
}

async function runWithConcurrency(jobs, limit) {
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await queue.shift()();
    }
  });
  await Promise.all(workers);
}

async function startPostSet({
  taskId,
  platform,
  aspectRatio,
  count,
  characterId = '',
  provider = '',
  imageSize,
  presetId = '',
  anchorGenId = ''
}) {
  const tasks = await getTasks();
  const task = tasks[taskId];
  if (!task) throw new Error('任务不存在');
  if (!task.source?.dataUrl) throw new Error('缺少参考图，无法策划组图');

  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('组图分镜策划需要 Gemini API Key（设置页填写）');

  const char = await getCharacter(characterId);
  const preset = getPreset(presetId);
  const useProvider = provider || settings.imageProvider || 'gemini';

  // Anchor the set on a character-swapped generation when one exists: the
  // swapped image carries the actual person + wardrobe + styling the user
  // approved, which the source image and card description cannot. Explicit
  // anchorGenId wins; otherwise pick the newest done generation made with the
  // selected character (generations are stored newest-first).
  let anchorGen = null;
  if (anchorGenId) {
    anchorGen = task.generations.find((g) => g.id === anchorGenId && g.images?.[0]) || null;
  }
  if (!anchorGen && characterId) {
    anchorGen =
      task.generations.find(
        (g) => g.status === 'done' && g.characterId === characterId && g.images?.[0]
      ) || null;
  }
  const anchorDataUrl = anchorGen ? anchorGen.images[0] : task.source.dataUrl;

  const inline = dataUrlToInlinePart(anchorDataUrl).inlineData;
  const shots = await planPostSet(
    {
      base64: inline.data,
      mimeType: inline.mimeType,
      stylePrompt: anchorGen ? '' : task.result?.prompt || '',
      charDesc: anchorGen ? '' : char?.desc || '',
      platform,
      count: Number(count) || 4,
      preset,
      negativeTail: NEGATIVE_TAIL,
      provider: useProvider,
      anchorIsCharacter: !!anchorGen
    },
    settings
  );

  const setId = uid();
  const gens = shots.map((shot, i) =>
    makeGenRecord({
      prompt: shot.prompt,
      aspectRatio,
      imageSize,
      refMode: anchorGen ? 'none' : 'style',
      provider: useProvider,
      characterId: char ? characterId : '',
      characterName: char?.name || '',
      setId,
      setLabel: shot.label,
      setIndex: i + 1,
      setTotal: shots.length,
      setPreset: preset?.name || '',
      refGenId: anchorGen?.id || ''
    })
  );

  // Persist all shots first (unshift in reverse so shot 1 ends up on top).
  const freshTasks = await getTasks();
  const freshTask = freshTasks[taskId];
  if (!freshTask) throw new Error('任务不存在');
  for (const gen of [...gens].reverse()) freshTask.generations.unshift(gen);
  await chrome.storage.local.set({ tasks: freshTasks, activeTaskId: taskId });

  // Fire and forget: two at a time to stay under provider rate limits.
  runWithConcurrency(
    gens.map((gen) => () => executeGeneration(taskId, gen.id)),
    2
  ).catch((e) => console.error('post set failed:', e));

  return shots.length;
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
    case 'RETRY_GEN': {
      retryGeneration(msg.payload).catch((e) => console.error('retry failed:', e));
      sendResponse({ ok: true });
      return false;
    }
    case 'GENERATE_SET': {
      startPostSet(msg.payload)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
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
