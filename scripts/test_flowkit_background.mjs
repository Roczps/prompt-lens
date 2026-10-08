import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { canResumeFlowKitVideo } from '../lib/flowkit.js';

// Evaluate the real dispatcher with fully isolated Chrome/provider stubs. No
// extension data, HTTP requests or actual generation are used by this suite.
const backgroundSource = (await readFile(new URL('../background.js', import.meta.url), 'utf8'))
  .replace(/^import\s+.*?;\r?\n/gm, '');
const clone = value => structuredClone(value);
const videoResult = () => ({ videos: ['data:video/mp4;base64,dmlkZW8='], images: [] });
const descriptor = {
  version: 1,
  baseUrl: 'http://127.0.0.1:8111',
  project_id: 'project-test',
  connection_id: 'connection-test',
  state: 'submitted',
  operations: [{ name: 'operation-test' }]
};
const videoGen = patch => ({
  id: 'gen-test', createdAt: Date.now(), status: 'running', kind: 'video',
  provider: 'flowkit', prompt: 'A calm seaside scene', aspectRatio: '16:9',
  imageSize: '720p', duration: 8, refMode: 'none', characterId: '',
  remoteTaskId: '', images: [], videos: [], error: null, ...patch
});
const taskFor = gen => ({
  id: 'task-test', createdAt: Date.now(), status: 'done',
  source: { dataUrl: 'data:image/png;base64,aW1hZ2U=' }, generations: [gen]
});
const flush = async () => {
  // Drain fire-and-forget message/poll promises without waiting on real timers.
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
};

async function harness({ generate, resume, rejectWrite } = {}) {
  const data = { tasks: {} };
  const calls = { generate: [], resume: [], alarms: [], errors: [] };
  const listeners = {};
  const storage = {
    async get(keys) {
      if (keys == null) return clone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return clone(Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])));
      return clone(Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, Object.hasOwn(data, key) ? data[key] : fallback])));
    },
    async set(patch) {
      if (rejectWrite?.(patch)) throw new Error('storage write rejected');
      Object.assign(data, clone(patch));
    }
  };
  const context = vm.createContext({
    console: { error: (...args) => calls.errors.push(args), log() {} },
    chrome: {
      storage: { local: storage, sync: storage },
      runtime: {
        onInstalled: { addListener(fn) { listeners.installed = fn; } },
        onMessage: { addListener(fn) { listeners.message = fn; } }
      },
      alarms: {
        create: (...args) => calls.alarms.push(['create', ...args]),
        clear: (...args) => calls.alarms.push(['clear', ...args]),
        onAlarm: { addListener(fn) { listeners.alarm = fn; } }
      },
      declarativeNetRequest: { async updateDynamicRules() {} }
    },
    fetch() { throw new Error('Live network is forbidden in offline tests'); },
    getSettings: async () => ({ flowkitBaseUrl: 'http://127.0.0.1:8111', videoDuration: 8 }),
    generateVideoFlowKit: async (settings, params) => {
      calls.generate.push({ settings: clone(settings), params });
      if (!generate) throw new Error('Unexpected video submission');
      return generate(settings, params, data);
    },
    resumeFlowKitVideo: async (settings, receipt) => {
      calls.resume.push({ settings: clone(settings), receipt: clone(receipt) });
      return resume ? resume(settings, receipt, data) : videoResult();
    },
    canResumeFlowKitVideo,
    friendlyGenError: error => String(error?.message || error),
    uid: () => 'new-gen-test'
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  await flush();
  return {
    data, calls,
    run: expression => vm.runInContext(expression, context),
    setGen(gen) { data.tasks = { 'task-test': taskFor(clone(gen)) }; },
    gen() { return data.tasks['task-test'].generations[0]; },
    async retry() {
      let response;
      listeners.message({ type: 'RETRY_GEN', payload: { taskId: 'task-test', genId: 'gen-test', provider: 'grok' } }, {}, result => { response = result; });
      await flush();
      assert.equal(response.ok, true);
    }
  };
}

{
  const h = await harness();
  h.setGen(videoGen({ provider: 'retired-video', remoteTaskId: 'old-job-id' }));
  await h.run('resumePendingGenerations()');
  await h.retry();
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 0);
  assert.equal(h.gen().status, 'error');
  assert.equal(h.gen().remoteTaskId, 'old-job-id');
  assert.match(h.gen().error, /停用|历史/);
  console.log('--- FlowKit background: retired video preserved without dispatch OK');
}

{
  const h = await harness();
  h.setGen(videoGen());
  await h.run('resumePendingGenerations()');
  assert.equal(h.gen().status, 'running');
  assert.equal(h.gen().flowkitNoResubmit, undefined);
  assert.equal(h.gen().error, null);
  assert.equal(h.calls.generate.length + h.calls.resume.length, 0);
  console.log('--- FlowKit background: fresh queued video is not marked uncertain OK');
}

for (const receiptOnly of [false, true]) {
  const h = await harness();
  h.setGen(videoGen({ status: 'error', ...(receiptOnly ? {} : { remoteTaskId: descriptor, flowkitNoResubmit: true }) }));
  if (receiptOnly) h.data['flowkitVideo:gen-test'] = clone(descriptor);
  await h.retry();
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 1);
  assert.deepEqual(h.calls.resume[0].receipt, descriptor);
  assert.equal(h.gen().status, 'done');
  assert.deepEqual(h.gen().videos, videoResult().videos);
  assert.equal(h.gen().provider, 'flowkit');
  console.log(`--- FlowKit background: RETRY_GEN queries ${receiptOnly ? 'independent receipt despite stale task' : 'saved descriptor'} only OK`);
}

{
  const h = await harness();
  h.setGen(videoGen());
  h.data['flowkitVideo:gen-test'] = clone(descriptor);
  await h.run('executeGeneration("task-test", "gen-test")');
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 1);
  assert.deepEqual(h.calls.resume[0].receipt, descriptor);
  console.log('--- FlowKit background: stale executor snapshot cannot replay a receipted video OK');
}

{
  let persistedBeforeAdapterContinues = false;
  const h = await harness({
    async generate(_settings, params, data) {
      const submitting = { ...descriptor, state: 'submitting' };
      delete submitting.operations;
      await params.onTaskCreated(submitting);
      assert.deepEqual(data['flowkitVideo:gen-test'], submitting);
      const storedGen = data.tasks['task-test'].generations[0];
      assert.equal(storedGen.flowkitNoResubmit, true);
      assert.deepEqual(storedGen.remoteTaskId, submitting);
      persistedBeforeAdapterContinues = true;
      await params.onTaskCreated(descriptor);
      assert.deepEqual(data['flowkitVideo:gen-test'], descriptor);
      return videoResult();
    }
  });
  h.setGen(videoGen());
  await h.run('executeGeneration("task-test", "gen-test")');
  assert.equal(persistedBeforeAdapterContinues, true);
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.gen().status, 'done');
  assert.equal(h.run('activePolls.size'), 0);
  console.log('--- FlowKit background: submission callback awaits durable receipt OK');
}

{
  const h = await harness({
    generate: async () => { throw new Error('preflight failed'); },
    rejectWrite: patch => patch.tasks?.['task-test']?.generations[0]?.status === 'error'
  });
  h.setGen(videoGen());
  await assert.rejects(h.run('executeGeneration("task-test", "gen-test")'), /storage write rejected/);
  assert.equal(h.run('activePolls.has("gen-test")'), false);
  console.log('--- FlowKit background: video lock released when error persistence fails OK');
}

{
  const uploadingReceipt = {
    version: 1, baseUrl: descriptor.baseUrl, project_id: descriptor.project_id,
    serverOwnedPolling: true, state: 'uploading', scene_id: 'task-test:gen-test'
  };
  const h = await harness({
    resume: async (_settings, receipt) => {
      assert.deepEqual(receipt, uploadingReceipt);
      const error = new Error('上传结果不明，禁止重复上传或提交');
      error.noResubmit = true;
      error.uncertain = true;
      error.descriptor = receipt;
      throw error;
    }
  });
  h.setGen(videoGen({ refMode: 'source' }));
  h.data['flowkitVideo:gen-test'] = clone(uploadingReceipt);
  await h.run('resumePendingGenerations()');
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 0);
  assert.equal(h.gen().status, 'error');
  assert.equal(h.gen().flowkitNoResubmit, true);
  // Simulate a stale task snapshot overwriting gen fields after the durable
  // receipt was written. RETRY_GEN must still consult the separate receipt.
  h.setGen(videoGen({ status: 'error', refMode: 'source' }));
  await h.retry();
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 1);
  assert.deepEqual(h.calls.resume[0].receipt, uploadingReceipt);
  assert.deepEqual(h.data['flowkitVideo:gen-test'], uploadingReceipt);
  assert.equal(h.gen().status, 'error');
  assert.equal(h.gen().provider, 'flowkit');
  assert.equal(h.gen().flowkitNoResubmit, true);
  console.log('--- FlowKit background: independent uploading receipt prevents restart/retry reupload OK');
}

{
  const i2vReceipt = {
    version: 1, baseUrl: descriptor.baseUrl, project_id: descriptor.project_id,
    serverOwnedPolling: true, state: 'submitted',
    operations: [{ operation: { name: 'i2v-operation', opaque: 'preserved' } }]
  };
  const h = await harness();
  h.setGen(videoGen({ status: 'error', refMode: 'source' }));
  h.data['flowkitVideo:gen-test'] = clone(i2vReceipt);
  await h.retry();
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 1);
  assert.deepEqual(h.calls.resume[0].receipt, i2vReceipt);
  assert.equal(h.gen().status, 'done');
  console.log('--- FlowKit background: server-owned I2V receipt resumes without client account binding OK');
}

for (const sourceKind of ['source', 'generated-second-image', 'text-only']) {
  const secondImage = 'data:image/jpeg;base64,c2Vjb25kLWltYWdl';
  const h = await harness({ generate: async () => videoResult() });
  h.setGen(videoGen({
    refMode: sourceKind === 'text-only' ? 'none' : 'source',
    ...(sourceKind === 'generated-second-image' ? { refGenId: 'image-gen', refImageIndex: 1 } : {})
  }));
  if (sourceKind === 'generated-second-image') {
    h.data.tasks['task-test'].generations.push({
      id: 'image-gen', kind: 'image', status: 'done', images: ['data:image/png;base64,Zmlyc3Q=', secondImage]
    });
  }
  await h.run('executeGeneration("task-test", "gen-test")');
  assert.equal(h.calls.generate.length, 1);
  const params = h.calls.generate[0].params;
  assert.equal(params.referenceDataUrl, sourceKind === 'text-only' ? ''
    : sourceKind === 'generated-second-image' ? secondImage : h.data.tasks['task-test'].source.dataUrl);
  assert.equal(params.sceneId, 'task-test:gen-test');
  assert.equal(params.duration, 8);
  assert.equal(h.gen().status, 'done');
  console.log(`--- FlowKit background: ${sourceKind} first-frame selection and stable scene ID OK`);
}

for (const missing of ['source', 'generation', 'image-index']) {
  const h = await harness({ generate: async () => videoResult() });
  h.setGen(videoGen({ refMode: 'source',
    ...(missing === 'generation' ? { refGenId: 'missing-image-gen', refImageIndex: 0 } : {}),
    ...(missing === 'image-index' ? { refGenId: 'image-gen', refImageIndex: 1 } : {})
  }));
  if (missing === 'source') h.data.tasks['task-test'].source.dataUrl = '';
  if (missing === 'image-index') {
    h.data.tasks['task-test'].generations.push({
      id: 'image-gen', kind: 'image', status: 'done', images: ['data:image/png;base64,Zmlyc3Q=']
    });
  }
  await h.run('executeGeneration("task-test", "gen-test")');
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.resume.length, 0);
  assert.equal(h.gen().status, 'error');
  assert.match(h.gen().error, /首帧|图片/);
  console.log(`--- FlowKit background: missing ${missing} blocks video instead of falling back OK`);
}

{
  const h = await harness({ generate: async () => videoResult() });
  h.setGen(videoGen({ id: 'source-image', kind: 'image', images: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='] }));
  await h.run('startVideoGeneration({ taskId: "task-test", prompt: "A gentle camera move", duration: 8, withImage: true, refGenId: "source-image", refImageIndex: 1 })');
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.gen().refImageIndex, 1);
  assert.equal(h.gen().duration, 8);
  assert.equal(h.calls.generate[0].params.referenceDataUrl, 'data:image/png;base64,Yg==');
  assert.equal(h.calls.generate[0].params.sceneId, 'task-test:new-gen-test');
  console.log('--- FlowKit background: I2V entry persists selected image index and 8-second duration OK');
}

console.log('FLOWKIT BACKGROUND ALL OK');
