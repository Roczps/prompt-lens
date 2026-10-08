import assert from 'node:assert/strict';
import { canResumeFlowKitVideo, generateVideoFlowKit, resumeFlowKitVideo, testFlowKit } from '../lib/flowkit.js';

// No service is contacted: every fetch is replaced, including asset downloads.
const previousFetch = globalThis.fetch;
const settings = { flowkitBaseUrl: 'http://127.0.0.1:8111/', pollIntervalMs: 1 };
const base = 'http://127.0.0.1:8111';
const account = {
  online: true,
  health: { blocked: false },
  free: 1,
  connection_id: 'connection-good',
  project_id: 'project-good'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});
const healthy = () => json({ status: 'ok', extension_connected: true });
const batchStatus = () => json({ transport: 'batch' });
const slots = accounts => json({ accounts });
const videoUrl = 'https://media.example/out.mp4';
const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
// Archived Preview status verification (2026-10-05), normalized operation
// response. This fixture is not evidence of a live Omni account or generation.
const pendingVideo = {
  operations: [{ operation: { name: 'op-video-1' }, status: 'MEDIA_GENERATION_STATUS_PENDING' }]
};
const completedVideo = {
  operations: [{
    operation: { name: 'op-video-1', metadata: { video: { mediaId: '22222222-2222-4222-8222-222222222222', fifeUrl: videoUrl } } },
    status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
  }]
};
const noCredentials = opts => {
  const headers = new Headers(opts.headers);
  assert.equal(headers.has('Authorization'), false);
  assert.equal(headers.has('Cookie'), false);
  assert.equal(headers.has('X-Flow-Key'), false);
};

try {
  // A failed health request must stop before slot lookup or submission.
  let calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    assert.equal(url, `${base}/health`);
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(generateVideoFlowKit(settings, { prompt: 'A quiet coastal landscape' }), /FlowKit|服务|连接/);
  assert.deepEqual(calls, [`${base}/health`]);
  console.log('--- FlowKit health failure: no submission OK');

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    return json({ detail: 'backend unavailable' }, 503);
  };
  await assert.rejects(generateVideoFlowKit(settings, { prompt: 'A quiet coastal landscape' }), /503|服务|连接/);
  assert.deepEqual(calls, [`${base}/health`]);
  console.log('--- FlowKit unhealthy HTTP response: no submission OK');

  // Connected transport is required before looking for a usable account.
  for (const connected of [undefined, false]) {
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      assert.equal(url, `${base}/health`);
      return json({ status: 'ok', extension_connected: connected });
    };
    await assert.rejects(generateVideoFlowKit(settings, { prompt: 'A quiet coastal landscape' }), /连接|extension_connected/);
    assert.deepEqual(calls, [`${base}/health`]);
  }
  console.log('--- FlowKit disconnected/missing extension: stopped before account lookup OK');

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    if (url === `${base}/health`) return healthy();
    assert.equal(url, `${base}/api/flow/status`);
    return json({ transport: 'other' });
  };
  await assert.rejects(generateVideoFlowKit(settings, { prompt: 'A quiet coastal landscape' }), /batch|传输/);
  assert.deepEqual(calls, [`${base}/health`, `${base}/api/flow/status`]);
  console.log('--- FlowKit non-batch transport: stopped before account lookup OK');

  // Offline, blocked, occupied and incompletely identified accounts are not usable.
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    if (url === `${base}/health`) return healthy();
    if (url === `${base}/api/flow/status`) return batchStatus();
    assert.equal(url, `${base}/api/slots`);
    return slots([
      { ...account, online: false },
      { ...account, health: { blocked: true } },
      { ...account, free: 0 },
      { ...account, connection_id: '' },
      { ...account, project_id: '' }
    ]);
  };
  await assert.rejects(generateVideoFlowKit(settings, { prompt: 'A quiet coastal landscape' }), /账号|槽位/);
  assert.deepEqual(calls, [`${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`]);
  console.log('--- FlowKit unavailable slots: no submission OK');

  // Settings connectivity checks are read-only and report their limited scope.
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    assert.equal(opts.method || 'GET', 'GET');
    if (url === `${base}/health`) return healthy();
    if (url === `${base}/api/flow/status`) return batchStatus();
    assert.equal(url, `${base}/api/slots`);
    return slots([account]);
  };
  assert.match(await testFlowKit(settings), /健康|槽位|未生成/);
  assert.deepEqual(calls, [`${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`]);
  console.log('--- FlowKit connectivity check: health then status then slots only OK');

  const firstFrame = 'data:image/png;base64,aW1hZ2U=';
  const uploadedMediaId = '11111111-1111-4111-8111-111111111111';
  const uploaded = { media_id: uploadedMediaId, opaque: { ownerEvidence: 'kept' } };
  const imageOperations = [{
    operation: { name: 'op-video-1', opaque: { preserve: ['original', 'handle'] } },
    status: 'MEDIA_GENERATION_STATUS_PENDING', opaque: { preserve: true }
  }];
  const imageSubmission = { operations: imageOperations, opaque: { submissionEvidence: 'kept' } };

  // Shotline uploads without connection_id. The server owns media/account
  // routing; polling preserves the complete operation and never selects slots.
  calls = [];
  const imageDescriptors = [];
  const imagePollBodies = [];
  let uploadBody;
  let imageBody;
  let imagePolls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    assert.equal(opts.credentials, 'omit');
    if (url === `${base}/health`) return healthy();
    if (url === `${base}/api/flow/status`) return batchStatus();
    if (url === `${base}/api/slots`) return slots([account]);
    if (url === `${base}/api/flow/upload-image`) {
      assert.equal(opts.method, 'POST');
      assert.equal(imageDescriptors.at(-1).state, 'uploading');
      uploadBody = JSON.parse(opts.body);
      return json(uploaded);
    }
    if (url === `${base}/api/flow/generate-video`) {
      assert.equal(opts.method, 'POST');
      assert.equal(imageDescriptors.at(-1).state, 'submitting');
      assert.deepEqual(imageDescriptors.at(-1).uploadResponse, uploaded);
      imageBody = JSON.parse(opts.body);
      return json(imageSubmission);
    }
    if (url === `${base}/api/flow/check-status`) {
      assert.equal(opts.method, 'POST');
      assert.equal(imageDescriptors.at(-1).state, 'submitted');
      imagePollBodies.push(JSON.parse(opts.body));
      // A successful unrelated workflow must not complete a pending I2V.
      return json(++imagePolls === 1 ? {
        ...pendingVideo, workflows: [{
          name: 'unrelated-workflow', done: true, status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
          media: { url: videoUrl }
        }]
      } : completedVideo);
    }
    assert.equal(url, videoUrl);
    return new Response(videoBytes, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const imageResult = await generateVideoFlowKit(settings, {
    prompt: 'The coastline moves slowly past the camera', aspectRatio: '9:16', duration: 8,
    referenceDataUrl: firstFrame, sceneId: 'scene-i2v-test',
    onTaskCreated: async receipt => { imageDescriptors.push(structuredClone(receipt)); }
  });
  assert.deepEqual(uploadBody, {
    image_base64: 'aW1hZ2U=', mime_type: 'image/png', file_name: 'first-frame.png', project_id: account.project_id
  });
  assert.deepEqual(imageBody, {
    prompt: 'The coastline moves slowly past the camera', project_id: account.project_id,
    start_image_media_id: uploadedMediaId, scene_id: 'scene-i2v-test',
    model_family: 'veo', video_model: 'veo_3_1_i2v_lite', aspect_ratio: 'VIDEO_ASPECT_RATIO_PORTRAIT'
  });
  assert.deepEqual(calls, [
    `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`,
    `${base}/api/flow/upload-image`, `${base}/api/flow/generate-video`,
    `${base}/api/flow/check-status`, `${base}/api/flow/check-status`, videoUrl
  ]);
  assert.deepEqual(imageDescriptors.map(receipt => receipt.state), ['uploading', 'uploaded', 'submitting', 'submitted']);
  for (const receipt of imageDescriptors) {
    assert.equal(receipt.serverOwnedPolling, true);
    assert.equal(Object.hasOwn(receipt, 'connection_id'), false);
  }
  assert.equal(imageDescriptors.at(-1).start_image_media_id, uploadedMediaId);
  assert.deepEqual(imageDescriptors.at(-1).submission, imageSubmission);
  assert.deepEqual(imageDescriptors.at(-1).operations, imageOperations);
  assert.deepEqual(imagePollBodies, [{ operations: imageOperations }, { operations: imageOperations }]);
  assert.deepEqual(imageResult.videos, [`data:video/mp4;base64,${Buffer.from(videoBytes).toString('base64')}`]);
  assert.deepEqual(imageResult.evidence, completedVideo);
  assert.equal(canResumeFlowKitVideo(imageDescriptors.at(-1)), true);
  console.log('--- FlowKit I2V: upload, server-owned submit, original operation polling and download OK');

  calls = [];
  globalThis.fetch = async url => { calls.push(url); throw new Error('Unexpected network request'); };
  for (const duration of [4, 6, 10]) {
    await assert.rejects(generateVideoFlowKit(settings, {
      prompt: 'A quiet coastal landscape', referenceDataUrl: firstFrame, duration
    }), /8|时长/);
  }
  assert.deepEqual(calls, []);
  console.log('--- FlowKit I2V unsupported duration: blocked before upload OK');

  // Loss of the upload response, uncertain status, or an unusable media_id
  // leaves a durable no-replay receipt. No generation or second upload is safe.
  for (const mode of ['uncertain', 'lost', 'missing-media-id', 'invalid-media-id']) {
    calls = [];
    const receipts = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/health`) return healthy();
      if (url === `${base}/api/flow/status`) return batchStatus();
      if (url === `${base}/api/slots`) return slots([account]);
      assert.equal(url, `${base}/api/flow/upload-image`);
      assert.equal(receipts.at(-1).state, 'uploading');
      if (mode === 'lost') throw new TypeError('Failed to fetch');
      return json(mode === 'uncertain' ? { uncertain: true, media_id: uploadedMediaId, detail: 'Upload outcome unknown' }
        : mode === 'invalid-media-id' ? { media_id: 'not-a-media-uuid' } : { uploaded: true });
    };
    let failure;
    await assert.rejects(generateVideoFlowKit(settings, {
      prompt: 'A quiet coastal landscape', referenceDataUrl: firstFrame,
      onTaskCreated: async receipt => { receipts.push(structuredClone(receipt)); }
    }), error => {
      failure = error;
      assert.equal(error.noResubmit, true);
      assert.equal(error.uncertain, true);
      assert.ok(error.descriptor);
      return true;
    });
    assert.deepEqual(calls, [
      `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`, `${base}/api/flow/upload-image`
    ]);
    assert.equal(receipts[0].state, 'uploading');
    assert.equal(canResumeFlowKitVideo(failure.descriptor), false);
    if (mode === 'uncertain') assert.equal(failure.evidence.uncertain, true);
    calls = [];
    globalThis.fetch = async url => { calls.push(url); throw new Error('Unexpected network request'); };
    await assert.rejects(resumeFlowKitVideo(settings, receipts[0]), error => error.noResubmit === true);
    await assert.rejects(resumeFlowKitVideo(settings, failure.descriptor), error => error.noResubmit === true);
    assert.deepEqual(calls, []);
    console.log(`--- FlowKit I2V ${mode} upload: original receipt blocks upload and submission replay OK`);
  }

  for (const lostResponse of [false, true]) {
    calls = [];
    const receipts = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/health`) return healthy();
      if (url === `${base}/api/flow/status`) return batchStatus();
      if (url === `${base}/api/slots`) return slots([account]);
      if (url === `${base}/api/flow/upload-image`) return json(uploaded);
      assert.equal(url, `${base}/api/flow/generate-video`);
      assert.equal(receipts.at(-1).state, 'submitting');
      if (lostResponse) throw new TypeError('Failed to fetch');
      return json({ status: 'uncertain', detail: 'Submitted, outcome unknown' });
    };
    let failure;
    await assert.rejects(generateVideoFlowKit(settings, {
      prompt: 'A quiet coastal landscape', referenceDataUrl: firstFrame,
      onTaskCreated: async receipt => { receipts.push(structuredClone(receipt)); }
    }), error => {
      failure = error;
      assert.equal(error.noResubmit, true);
      assert.equal(error.uncertain, true);
      assert.equal(error.descriptor.start_image_media_id, uploadedMediaId);
      assert.deepEqual(error.descriptor.uploadResponse, uploaded);
      return true;
    });
    assert.deepEqual(calls, [
      `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`,
      `${base}/api/flow/upload-image`, `${base}/api/flow/generate-video`
    ]);
    calls = [];
    globalThis.fetch = async url => { calls.push(url); throw new Error('Unexpected network request'); };
    await assert.rejects(resumeFlowKitVideo(settings, failure.descriptor), error => error.noResubmit === true);
    assert.deepEqual(calls, []);
    console.log(`--- FlowKit I2V ${lostResponse ? 'lost' : 'uncertain'} submission: no reupload or resubmit OK`);
  }

  // A storage failure on either side of upload must stop before the next
  // mutating request. Recovery can inspect the original response without replay.
  for (const failAt of ['uploading', 'uploaded', 'submitting', 'submitted']) {
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/health`) return healthy();
      if (url === `${base}/api/flow/status`) return batchStatus();
      if (url === `${base}/api/slots`) return slots([account]);
      if (url === `${base}/api/flow/upload-image`) return json(uploaded);
      assert.equal(url, `${base}/api/flow/generate-video`);
      return json(imageSubmission);
    };
    await assert.rejects(generateVideoFlowKit(settings, {
      prompt: 'A quiet coastal landscape', referenceDataUrl: firstFrame,
      onTaskCreated: async receipt => { if (receipt.state === failAt) throw new Error('Storage write failed'); }
    }), error => {
      assert.match(error.message, /Storage write failed/);
      if (failAt !== 'uploading') {
        assert.equal(error.noResubmit, true);
        assert.deepEqual(error.descriptor.uploadResponse, uploaded);
      }
      if (failAt === 'submitted') {
        assert.deepEqual(error.descriptor.operations, imageOperations);
        assert.deepEqual(error.evidence, imageSubmission);
      }
      return true;
    });
    assert.deepEqual(calls, [
      `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`,
      ...(failAt === 'uploading' ? [] : [`${base}/api/flow/upload-image`]),
      ...(failAt === 'submitted' ? [`${base}/api/flow/generate-video`] : [])
    ]);
    console.log(`--- FlowKit I2V receipt failure at ${failAt}: no later mutating request OK`);
  }

  // The I2V protocol identifies an operation by its nested name. Refuse an
  // invented legacy-style ID before any request, and a mismatched terminal
  // operation before downloading an unrelated result.
  const ownerDescriptor = imageDescriptors.at(-1);
  assert.equal(canResumeFlowKitVideo({ ...ownerDescriptor, operations: [{ name: 'not-a-nested-operation' }] }), false);
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    assert.equal(url, `${base}/api/flow/check-status`);
    assert.deepEqual(JSON.parse(opts.body), { operations: imageOperations });
    return json({ operations: [{
      operation: { name: 'unrelated-operation', metadata: { video: { fifeUrl: videoUrl } } },
      status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
    }] });
  };
  await assert.rejects(resumeFlowKitVideo(settings, ownerDescriptor), error => error.noResubmit === true);
  assert.deepEqual(calls, [`${base}/api/flow/check-status`]);
  console.log('--- FlowKit I2V mismatched operation: unrelated video download rejected OK');

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    assert.equal(url, `${base}/api/flow/check-status`);
    assert.deepEqual(JSON.parse(opts.body), { operations: imageOperations });
    const invalidMedia = structuredClone(completedVideo);
    invalidMedia.operations[0].operation.metadata.video.mediaId = 'not-a-media-uuid';
    return json(invalidMedia);
  };
  await assert.rejects(resumeFlowKitVideo(settings, ownerDescriptor), error => error.noResubmit === true);
  assert.deepEqual(calls, [`${base}/api/flow/check-status`]);
  console.log('--- FlowKit I2V invalid result media ID: video download rejected OK');

  // Text generation uses a single available account. Poll using the original
  // full workflows payload. Terminal shape follows the archived Omni check-
  // status response; this offline fixture does not verify the current service.
  calls = [];
  const workflowHandles = [{ name: 'workflows/video-1', opaque: { preserve: true } }];
  const textSubmission = {
    flowkitPolling: { workflows: workflowHandles, opaque: { keep: 'poll metadata' } },
    opaque: { keep: 'submission evidence' }
  };
  const workflowPending = {
    done: false, status: 'PENDING',
    workflows: [{ name: 'workflows/video-1', done: false, status: 'MEDIA_GENERATION_STATUS_PENDING' }]
  };
  const workflowCompleted = {
    done: true, status: 'COMPLETED',
    workflows: [{
      name: 'workflows/video-1', primary_media_id: 'video-media-1', project_id: account.project_id,
      done: true, status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL', error: null,
      media: { media_id: 'video-media-1', url: videoUrl, encoded_video_available: false, resolved_via: 'as29s' }
    }]
  };
  const textDescriptors = [];
  const pollBodies = [];
  let textBody;
  let textPolls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    assert.equal(opts.credentials, 'omit');
    if (url === `${base}/health`) return healthy();
    if (url === `${base}/api/flow/status`) return batchStatus();
    if (url === `${base}/api/slots`) return slots([
      { ...account, online: false, connection_id: 'offline-connection', project_id: 'offline-project' },
      { ...account, health: { blocked: true }, connection_id: 'blocked-connection', project_id: 'blocked-project' },
      { ...account, free: 0, connection_id: 'busy-connection', project_id: 'busy-project' },
      account
    ]);
    if (url === `${base}/api/flow/generate-video-omni-text`) {
      assert.equal(textDescriptors.at(-1).state, 'submitting');
      assert.equal(opts.method, 'POST');
      textBody = JSON.parse(opts.body);
      return json(textSubmission);
    }
    if (url === `${base}/api/flow/check-status`) {
      assert.equal(textDescriptors.at(-1).state, 'submitted');
      assert.equal(opts.method, 'POST');
      pollBodies.push(JSON.parse(opts.body));
      textPolls++;
      return json(textPolls === 1 ? workflowPending : workflowCompleted);
    }
    assert.equal(url, videoUrl);
    return new Response(videoBytes, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const textResult = await generateVideoFlowKit(settings, {
    prompt: 'A quiet coastal landscape', aspectRatio: '16:9', duration: 4,
    onTaskCreated: async descriptor => { textDescriptors.push(structuredClone(descriptor)); }
  });
  assert.deepEqual(textBody, {
    prompt: 'A quiet coastal landscape', project_id: account.project_id, connection_id: account.connection_id,
    duration_s: 4, resolution: '720p', aspect_ratio: 'VIDEO_ASPECT_RATIO_LANDSCAPE'
  });
  assert.deepEqual(calls, [
    `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`, `${base}/api/flow/generate-video-omni-text`,
    `${base}/api/flow/check-status`, `${base}/api/flow/check-status`, videoUrl
  ]);
  assert.equal(textDescriptors.length, 2);
  assert.deepEqual(textDescriptors[1].submission, textSubmission);
  assert.deepEqual(textDescriptors[1].flowkitPolling, textSubmission.flowkitPolling);
  assert.deepEqual(textDescriptors[1].workflows, workflowHandles);
  assert.deepEqual(pollBodies, [1, 2].map(() => ({
    project_id: account.project_id, connection_id: account.connection_id, workflows: workflowHandles
  })));
  assert.deepEqual(textResult.videos, [`data:video/mp4;base64,${Buffer.from(videoBytes).toString('base64')}`]);
  assert.deepEqual(textResult.evidence, workflowCompleted);
  console.log('--- FlowKit text video: submit, workflow pending/success status, credential-free download OK');

  for (const changedField of ['name', 'primary_media_id']) {
    const workflowReceipt = {
      version: 1, baseUrl: base, project_id: account.project_id, connection_id: account.connection_id,
      state: 'submitted', workflows: [{ name: 'workflows/video-1', primary_media_id: 'video-media-1' }]
    };
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      assert.equal(url, `${base}/api/flow/check-status`);
      assert.deepEqual(JSON.parse(opts.body).workflows, workflowReceipt.workflows);
      const changedWorkflow = structuredClone(workflowCompleted);
      changedWorkflow.workflows[0][changedField] = 'unrelated-result';
      return json(changedWorkflow);
    };
    await assert.rejects(resumeFlowKitVideo(settings, workflowReceipt), error => {
      assert.equal(error.noResubmit, true);
      assert.equal(error.uncertain, true);
      return true;
    });
    assert.deepEqual(calls, [`${base}/api/flow/check-status`]);
    console.log(`--- FlowKit text workflow changed ${changedField}: unrelated video download rejected OK`);
  }

  const completedDescriptor = {
    version: 1, baseUrl: base, project_id: account.project_id, connection_id: account.connection_id,
    state: 'submitted', operations: pendingVideo.operations
  };
  calls = [];
  let resumeBody;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(url);
    noCredentials(opts);
    assert.equal(opts.credentials, 'omit');
    if (url === `${base}/api/flow/check-status`) {
      resumeBody = JSON.parse(opts.body);
      return json(completedVideo);
    }
    assert.equal(url, videoUrl);
    return new Response(videoBytes, { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  const resumeResult = await resumeFlowKitVideo(settings, completedDescriptor);
  assert.deepEqual(calls, [`${base}/api/flow/check-status`, videoUrl]);
  assert.deepEqual(resumeBody, {
    project_id: account.project_id, connection_id: account.connection_id, operations: pendingVideo.operations
  });
  assert.deepEqual(resumeResult.videos, textResult.videos);
  console.log('--- FlowKit operations resume: completed video download without generation POST OK');

  for (const htmlDownload of [false, true]) {
    calls = [];
    const terminalResponse = htmlDownload ? completedVideo : {
      operations: [{
        operation: { name: 'op-video-1', error: { message: '账号额度不足' } },
        status: 'MEDIA_GENERATION_STATUS_FAILED'
      }]
    };
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/api/flow/check-status`) return json(terminalResponse);
      assert.equal(url, videoUrl);
      return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
    };
    await assert.rejects(resumeFlowKitVideo(settings, completedDescriptor), error => {
      assert.equal(error.noResubmit, true);
      assert.notEqual(error.pending, true);
      assert.deepEqual(error.descriptor, completedDescriptor);
      assert.deepEqual(error.evidence, terminalResponse);
      assert.match(error.message, htmlDownload ? /非视频/ : /额度不足/);
      return true;
    });
    assert.deepEqual(calls, [`${base}/api/flow/check-status`, ...(htmlDownload ? [videoUrl] : [])]);
    console.log(`--- FlowKit ${htmlDownload ? 'HTML download rejected' : 'failed video status'}: original task retained, no replay OK`);
  }

  // An uncertain response or lost submission response must never cause another
  // generate request. Persistence happens before POST to protect worker restarts.
  for (const lostResponse of [false, true]) {
    calls = [];
    const descriptors = [];
    let submissionBody;
    let descriptorBeforePost;
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/health`) return healthy();
      if (url === `${base}/api/flow/status`) return batchStatus();
      if (url === `${base}/api/slots`) return slots([account]);
      assert.equal(url, `${base}/api/flow/generate-video-omni-text`);
      assert.equal(opts.method, 'POST');
      submissionBody = JSON.parse(opts.body);
      descriptorBeforePost = descriptors.at(-1);
      if (lostResponse) throw new TypeError('Failed to fetch');
      return json({ status: 'uncertain', detail: 'Submitted, result not yet known' });
    };
    let failure;
    try {
      await generateVideoFlowKit(settings, {
        prompt: 'A quiet coastal landscape',
        aspectRatio: '9:16',
        duration: 6,
        onTaskCreated: async descriptor => { descriptors.push(structuredClone(descriptor)); }
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'uncertain submission should produce a recoverable diagnostic');
    assert.equal(failure.noResubmit, true);
    assert.equal(failure.uncertain, true);
    assert.notEqual(failure.pending, true);
    assert.match(failure.message, /不明|未知|uncertain/);
    assert.deepEqual(calls, [
      `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`, `${base}/api/flow/generate-video-omni-text`
    ]);
    assert.equal(submissionBody.project_id, account.project_id);
    assert.equal(submissionBody.connection_id, account.connection_id);
    assert.equal(submissionBody.duration_s, 6);
    assert.equal(submissionBody.aspect_ratio, 'VIDEO_ASPECT_RATIO_PORTRAIT');
    assert.equal(submissionBody.resolution, '720p');
    assert.equal(descriptorBeforePost.state, 'submitting');
    assert.equal(descriptorBeforePost.baseUrl, base);
    assert.equal(descriptorBeforePost.project_id, account.project_id);
    assert.equal(descriptorBeforePost.connection_id, account.connection_id);
    assert.ok(failure.descriptor);
    if (!lostResponse) assert.equal(failure.evidence.status, 'uncertain');

    // There is no polling handle, so recovery must reject without any network
    // request, even if a different service address is now in settings.
    calls = [];
    globalThis.fetch = async url => { calls.push(url); throw new Error('Unexpected network request'); };
    await assert.rejects(resumeFlowKitVideo({ ...settings, flowkitBaseUrl: 'http://127.0.0.1:8999' }, failure.descriptor));
    assert.deepEqual(calls, []);
    console.log(`--- FlowKit ${lostResponse ? 'lost response' : 'uncertain response'}: persisted before POST, no replay OK`);
  }

  // Polling descriptors carry the original opaque handles and account binding.
  // These handle contents test preservation, not an undocumented remote schema.
  for (const handleKind of ['operations', 'workflows']) {
    const handles = [{ name: `${handleKind}/test-1`, opaque: { preserve: ['all', 'fields'] } }];
    const descriptor = {
      version: 1, baseUrl: base, project_id: account.project_id,
      connection_id: account.connection_id, state: 'submitted', [handleKind]: handles
    };
    const descriptorBefore = structuredClone(descriptor);
    assert.equal(canResumeFlowKitVideo(descriptor), true);
    calls = [];
    let pollBody;
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      assert.equal(opts.method, 'POST');
      pollBody = JSON.parse(opts.body);
      return json({ status: 'uncertain', detail: 'Query result remains uncertain' });
    };
    await assert.rejects(
      resumeFlowKitVideo({ ...settings, flowkitBaseUrl: 'http://127.0.0.1:8999' }, descriptor),
      error => error.uncertain === true && error.noResubmit === true
    );
    assert.deepEqual(calls, [`${base}/api/flow/check-status`]);
    assert.deepEqual(pollBody, {
      project_id: account.project_id, connection_id: account.connection_id, [handleKind]: handles
    });
    assert.deepEqual(descriptor, descriptorBefore);
    console.log(`--- FlowKit resume ${handleKind}: original account/base/opaque handles preserved, no submission OK`);
  }
  assert.equal(canResumeFlowKitVideo('old-video-task-id'), false);
  assert.equal(canResumeFlowKitVideo({ version: 1, ...account, baseUrl: base }), false);

  const pendingDescriptor = {
    version: 1, baseUrl: base, project_id: account.project_id,
    connection_id: account.connection_id, operations: [{ name: 'operations/pending' }]
  };
  calls = [];
  globalThis.fetch = async url => { calls.push(url); throw new Error('Unexpected network request'); };
  await assert.rejects(resumeFlowKitVideo(settings, pendingDescriptor, { deadlineMs: 0 }), error => {
    assert.equal(error.pending, true);
    assert.equal(error.noResubmit, true);
    assert.deepEqual(error.descriptor, pendingDescriptor);
    return true;
  });
  assert.deepEqual(calls, []);
  console.log('--- FlowKit poll deadline: pending original task retained OK');

  // Storage failure before POST must prevent submission; after POST it must keep
  // the complete response/handles so a caller can recover without a replay.
  for (const failAfterSubmission of [false, true]) {
    calls = [];
    let callbackCount = 0;
    const submission = { operations: [{ name: 'operations/persist-test', opaque: { retain: true } }] };
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(url);
      noCredentials(opts);
      if (url === `${base}/health`) return healthy();
      if (url === `${base}/api/flow/status`) return batchStatus();
      if (url === `${base}/api/slots`) return slots([account]);
      return json(submission);
    };
    await assert.rejects(generateVideoFlowKit(settings, {
      prompt: 'A quiet coastal landscape',
      onTaskCreated: async () => {
        callbackCount++;
        if (callbackCount === (failAfterSubmission ? 2 : 1)) throw new Error('Storage write failed');
      }
    }), error => {
      assert.match(error.message, /Storage write failed/);
      if (failAfterSubmission) {
        assert.equal(error.noResubmit, true);
        assert.deepEqual(error.descriptor.operations, submission.operations);
        assert.deepEqual(error.evidence, submission);
      }
      return true;
    });
    assert.deepEqual(calls, [
      `${base}/health`, `${base}/api/flow/status`, `${base}/api/slots`,
      ...(failAfterSubmission ? [`${base}/api/flow/generate-video-omni-text`] : [])
    ]);
    console.log(`--- FlowKit persistence failure ${failAfterSubmission ? 'after' : 'before'} submission: no replay OK`);
  }
} finally {
  globalThis.fetch = previousFetch;
}
