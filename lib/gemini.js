const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callGemini(model, body, apiKey) {
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function extractParts(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const images = parts
    .filter((p) => p.inlineData?.data)
    .map((p) => `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}`);
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
  return { images, text };
}

const ANALYZE_INSTRUCTION = `你是一名图像提示词反推专家。仔细观察这张图片，输出一份可以直接用于 AI 生图的提示词。

严格输出以下 JSON（不要输出其他任何内容）：
{
  "prompt": "英文提示词。一段自然语言，细致描述主体、动作、环境、构图视角、光线、色彩氛围、艺术风格与画质关键词，可直接送入生图模型",
  "prompt_zh": "上面英文提示词的中文对照翻译",
  "tags": {
    "subject": ["主体相关的关键词卡，中文，1-4 个"],
    "style": ["艺术风格/媒介关键词，中文，1-4 个"],
    "composition": ["构图/镜头/视角关键词，中文，1-3 个"],
    "color": ["色彩与光线关键词，中文，1-3 个"],
    "mood": ["情绪/氛围/动态关键词，中文，1-3 个"]
  },
  "palette": ["#RRGGBB 格式的主色卡，按画面占比排序，4-6 个"]
}`;

function parseJsonLoose(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw new Error('模型返回的内容无法解析为 JSON');
  }
}

export async function reversePrompt({ base64, mimeType }, settings) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: ANALYZE_INSTRUCTION }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json'
    }
  };

  let data;
  try {
    data = await callGemini(settings.analysisModel, body, settings.apiKey);
  } catch (e) {
    // Some models reject responseMimeType; retry as plain text once.
    if (e.status === 400) {
      delete body.generationConfig.responseMimeType;
      data = await callGemini(settings.analysisModel, body, settings.apiKey);
    } else {
      throw e;
    }
  }

  const { text } = extractParts(data);
  if (!text) throw new Error('模型没有返回分析结果');
  const parsed = parseJsonLoose(text);
  return {
    prompt: parsed.prompt || '',
    promptZh: parsed.prompt_zh || '',
    tags: parsed.tags || {},
    palette: Array.isArray(parsed.palette) ? parsed.palette : []
  };
}

export async function generateImage({ prompt, aspectRatio, imageSize, refPart }, settings) {
  const parts = [];
  if (refPart) {
    parts.push(refPart);
    parts.push({ text: `参考这张图片的风格与氛围（不要照抄内容），根据以下提示词生成新图：\n${prompt}` });
  } else {
    parts.push({ text: prompt });
  }

  const base = { contents: [{ role: 'user', parts }] };
  const imageOpts = { aspectRatio, imageSize };

  // Newer image models use generationConfig.responseFormat; older ones use
  // imageConfig. Try in order and fall back on schema-related 400 errors.
  const attempts = [
    { responseModalities: ['TEXT', 'IMAGE'], responseFormat: { image: imageOpts } },
    { responseModalities: ['TEXT', 'IMAGE'], imageConfig: imageOpts },
    { responseModalities: ['TEXT', 'IMAGE'] }
  ];

  let lastError;
  for (const generationConfig of attempts) {
    try {
      const data = await callGemini(settings.imageModel, { ...base, generationConfig }, settings.apiKey);
      return extractParts(data);
    } catch (e) {
      lastError = e;
      if (e.status !== 400) throw e;
    }
  }
  throw lastError;
}

export async function testApiKey(apiKey) {
  const res = await fetch(`${API_BASE}/models?pageSize=1`, {
    headers: { 'x-goog-api-key': apiKey }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return true;
}
