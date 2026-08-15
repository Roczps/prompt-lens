const $ = (id) => document.getElementById(id);

async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  const taskId = params.get('t');
  const genId = params.get('g');
  const index = Number(params.get('i') || 0);
  const isSource = params.get('src') === '1';

  const { tasks = {} } = await chrome.storage.local.get('tasks');
  const task = tasks[taskId];

  let dataUrl = '';
  let prompt = '';
  let title = '';
  let meta = '';
  let filename = 'prompt-lens.png';

  if (task && isSource) {
    dataUrl = task.source?.dataUrl || '';
    prompt = task.result?.prompt || '';
    title = '参考原图';
    filename = `prompt-lens-source-${task.id}.jpg`;
  } else if (task && genId) {
    const gen = task.generations.find((g) => g.id === genId);
    if (gen) {
      dataUrl = gen.images[index] || '';
      prompt = gen.prompt || '';
      title = '生成结果';
      meta = [gen.aspectRatio, gen.imageSize, gen.characterName].filter(Boolean).join(' · ');
      filename = `prompt-lens-${gen.id}${gen.images.length > 1 ? '-' + (index + 1) : ''}.png`;
    }
  }

  if (!dataUrl) {
    $('missing').classList.remove('hidden');
    $('btn-download').disabled = true;
    $('btn-copy').disabled = true;
    return;
  }

  document.title = `Prompt Lens · ${title}`;
  $('title').textContent = title;
  $('meta').textContent = meta;
  const img = $('img');
  img.src = dataUrl;
  img.addEventListener('load', () => {
    $('meta').textContent = [meta, `${img.naturalWidth}×${img.naturalHeight}`].filter(Boolean).join(' · ');
  });

  if (prompt) {
    $('prompt').textContent = prompt;
    $('prompt-box').classList.remove('hidden');
  }

  $('btn-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  });

  $('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(prompt);
    $('btn-copy').textContent = '已复制';
    setTimeout(() => ($('btn-copy').textContent = '复制提示词'), 1200);
  });
}

init();
