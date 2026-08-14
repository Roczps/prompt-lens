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

const ANALYZE_INSTRUCTION = `你是一名顶级的图像提示词逆向工程专家。你的唯一目标：写出一段提示词，让文生图模型能最大程度**复刻**这张图。禁止泛泛而谈，每个判断都要基于画面中实际可见的证据。

按以下三步工作：

【第一步：判断图像类型】
判断这是：真实摄影 / 电影剧照 / 手绘插画 / 日式动漫 / 美式卡通 / 3D 渲染 / 像素画 / 水彩油画 / 平面海报 / UI 界面 / 产品摄影 / 建筑效果图 等。后续所有维度都要用该类型的专业行话描述。

【第二步：逐维度精细观察】（写入 analysis 字段，每项中文 1-3 句，必须具体可执行）
- subject 主体：数量、身份/物种、年龄气质、外貌发型、服装款式/材质/颜色、姿态动作、表情与视线方向、手持物品
- environment 环境：场景地点、背景可辨认的元素、前景遮挡物、道具陈设、天气与时间
- composition 构图：景别（特写/半身/全身/远景）、相机角度（平视/俯拍/仰拍/荷兰角）、焦段感（广角畸变/标准/长焦压缩）、景深与虚化位置、主体在画面中的位置与占比、对称/三分/引导线
- lighting 光线：主光源类型与方向、软硬程度、色温、高光与阴影落点、特殊光效（逆光轮廓/体积光/霓虹/烛光）
- color 色彩：主色调与辅助色、饱和度与明度倾向、调色风格（胶片感/日系清新/赛博霓虹/莫兰迪…）
- style 风格：艺术媒介与流派，可对标的艺术家/工作室/渲染引擎/胶片型号（如 Studio Ghibli、Octane render、Kodak Portra 400），笔触或渲染质感特征
- details 细节：材质纹理（皮肤毛孔/织物纹理/金属反光）、颗粒或噪点、图中出现的文字或 logo 的内容与位置（如有）、任何标志性小细节
- mood 氛围：情绪基调、叙事感、画面动势

【第三步：融合成最终提示词】
prompt：英文，120-250 词的一段自然语言。开头点明图像类型与整体风格，随后依次织入主体细节、环境、构图与镜头、光线、色彩、材质细节，结尾加画质词。必须具体到可复刻——写"waist-up shot of a woman in her 20s with shoulder-length ash-brown hair, wearing an oversized cream cable-knit sweater"这种精度，而不是"a beautiful woman"。
prompt_zh：上述英文的中文对照。

严格输出以下 JSON（不要输出任何其他内容）：
{
  "image_type": "图像类型，中文短语",
  "analysis": {
    "subject": "…", "environment": "…", "composition": "…", "lighting": "…",
    "color": "…", "style": "…", "details": "…", "mood": "…"
  },
  "prompt": "…",
  "prompt_zh": "…",
  "tags": {
    "subject": ["中文短词卡 2-4 个"],
    "style": ["2-4 个"],
    "composition": ["2-3 个"],
    "lighting": ["2-3 个"],
    "color": ["2-3 个"],
    "mood": ["2-3 个"]
  },
  "palette": ["#RRGGBB 主色，按画面占比排序，4-6 个"]
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
      temperature: 0.3,
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
    imageType: parsed.image_type || '',
    analysis: parsed.analysis || {},
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
    parts.push({ text: `以这张图为参考，延续它的整体风格、构图、光线与色彩氛围，按以下提示词生成新图：\n${prompt}` });
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
