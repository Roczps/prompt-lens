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
- subject 主体：数量、身份/物种、年龄气质、外貌发型、服装款式/材质/颜色、表情与视线方向、手持物品
- pose 姿势：这是复刻的重中之重，必须精确到关节级——头部朝向与倾斜角度、肩膀朝向、躯干扭转、双臂各自的位置（抬起/下垂/叉腰/交叉，肘部弯曲程度）、双手的动作与位置（插兜/托腮/持物/自然下垂）、重心与站坐姿、双腿姿态、整体身体朝向与相机的关系（正面/四分之三侧/侧面/背面）
- environment 环境：场景地点、背景可辨认的元素、前景遮挡物、道具陈设、天气与时间
- composition 构图：必须写清三件事——①景别与裁切线：画框从人物身体的哪个部位裁切（如"膝盖以上"/"腰部以上"/"全身含脚"）；②主体占比与位置：人物高度约占画面高度的百分之多少，位于画面左/中/右哪个区域，头顶留白多少；③相机角度（平视/俯拍/仰拍）与焦段感（广角畸变/标准/长焦压缩）、景深与虚化位置
- lighting 光线：主光源类型与方向、软硬程度、色温、高光与阴影落点、特殊光效（逆光轮廓/体积光/霓虹/烛光）
- color 色彩：主色调与辅助色、饱和度与明度倾向、调色风格（胶片感/日系清新/赛博霓虹/莫兰迪…）
- style 风格：艺术媒介与流派，可对标的艺术家/工作室/渲染引擎/胶片型号（如 Studio Ghibli、Octane render、Kodak Portra 400），笔触或渲染质感特征
- details 细节：材质纹理（皮肤毛孔/织物纹理/金属反光）、颗粒或噪点、图中出现的文字或 logo 的内容与位置（如有）、任何标志性小细节
- mood 氛围：情绪基调、叙事感、画面动势

【第三步：融合成最终提示词】
prompt：英文，150-300 词的一段自然语言，按以下顺序组织：
①开头第一句就锁定构图与姿势："<图像类型/风格>, <景别与裁切> of <主体>, <身体朝向与完整姿势描述>, subject occupying about <N>% of the frame height, positioned <画面位置>, camera at <角度>"。
②然后展开主体外貌与服装细节、环境背景、光线、色彩、材质与画质词。
姿势与构图的每个要点（头、肩、手臂、手、腿、裁切线、占比、相机角度）都必须出现在 prompt 里，不允许省略——生图模型只能看到这段文字，文字里没写的姿势信息就会丢失。写"three-quarter view, head tilted slightly left, right hand raised touching the brim of her hat, left arm relaxed at her side, framed from mid-thigh up, subject centered occupying roughly 70% of frame height"这种精度。
prompt_zh：上述英文的中文对照。

严格输出以下 JSON（不要输出任何其他内容）：
{
  "image_type": "图像类型，中文短语",
  "analysis": {
    "subject": "…", "pose": "…", "environment": "…", "composition": "…",
    "lighting": "…", "color": "…", "style": "…", "details": "…", "mood": "…"
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
    const starts = [stripped.indexOf('{'), stripped.indexOf('[')].filter((i) => i >= 0);
    if (starts.length) {
      const start = Math.min(...starts);
      const closer = stripped[start] === '[' ? ']' : '}';
      const end = stripped.lastIndexOf(closer);
      if (end > start) return JSON.parse(stripped.slice(start, end + 1));
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

/**
 * Plan a cohesive social-media post set (4-6 shots) anchored on the reference
 * image's character and style. Returns [{ label, prompt }].
 *
 * anchorIsCharacter: the reference image IS the target character (e.g. a
 * character-swapped generation) -- appearance AND wardrobe must be read from
 * the image itself instead of a card description.
 */
export async function planPostSet(
  {
    base64,
    mimeType,
    stylePrompt,
    charDesc,
    platform,
    count,
    preset = null,
    negativeTail = '',
    provider = '',
    anchorIsCharacter = false
  },
  settings
) {
  const platformGuide =
    platform === 'xhs'
      ? '小红书（生活方式种草社区，双列信息流里封面决定点击率；真实生活感与氛围感，竖版构图）'
      : 'Instagram（视觉美学社区，整体 feed 色调统一、构图讲究、高级感；组图按 carousel 叙事编排）';

  // Platform-native viral structure, distilled from current XHS cover
  // conventions and IG carousel narrative-arc practice.
  const platformShotRules =
    platform === 'xhs'
      ? `- 小红书爆款封面规则（第 1 张必须全部满足）：真人出镜、主体占画面比例大、背景干净且画面元素不超过 3 个、顶部约 15% 高度留干净留白（信息流会盖渐变蒙版，也方便后期加标题字）
- 整组统一色调与影调，像同一次拍摄产出，翻图体验连贯`
      : `- Instagram 组图按叙事弧编排：第 1 张是 hook（整组最强视觉、主体突出、留标题空间）→ 中间依次覆盖 细节特写 / 真实场景生活照 / 换角度或景别的变化 → 最后一张是收尾（构图最干净、留大量负空间，适合叠加 CTA 文字）
- 整组保持同一个视觉锚（主体、色调或取景手法），翻页时能一眼认出是一组`;

  const styleRules = preset
    ? `- 内容主题预设：${preset.name}
- 整组风格锚（每张 prompt 都必须完整、原样包含以下英文风格描述，作为统一风格基调）：${preset.styleAnchor}
- 分镜节奏参考（结合参考图人物可微调，但整体遵循这个编排）：${preset.rhythm}${
        preset.coverNote ? `\n- 封面（第 1 张）要求：${preset.coverNote}` : ''
      }
- 参考图用于锁定角色${anchorIsCharacter ? '外貌与服装穿搭' : '外貌与气质'}；场景、光线、色调以上述预设为准`
    : `- 艺术风格、色调、光线氛围与参考图一致，整组放在一起视觉统一、像同一次拍摄
- 每张的场景、景别、姿势、构图必须彼此明显不同，按内容组图的节奏编排（例如：封面全身、半身特写、侧影、背影回眸、手部或物品细节、场景互动）${
        stylePrompt ? `\n- 参考图的风格提示词（用作风格锚定素材）：${stylePrompt}` : ''
      }`;

  const instruction = `你是社交媒体内容策划兼摄影指导。仔细观察这张参考图的人物与风格，为 ${platformGuide} 策划一组 ${count} 张的系列 post 图。

整组硬性要求：
- 同一角色贯穿全部 ${count} 张：五官、发型发色、体型、穿搭风格必须一致、高度可识别${
    anchorIsCharacter
      ? `\n- 参考图中的人物就是这个角色本人：五官、发型发色、体型、以及身上的服装穿搭都以参考图实际画面为准。每张 prompt 都必须先完整描述参考图人物的外貌与服装（款式/颜色/材质），再写本张特有的场景与姿势`
      : charDesc
        ? `\n- 角色外貌锚定（每张 prompt 都必须原样包含这些特征）：${charDesc}`
        : ''
  }
${platformShotRules}
${styleRules}
- 每张的场景、景别、姿势、构图必须彼此明显不同，不允许两张雷同${
    provider === 'openai'
      ? '\n- 内容安全硬约束（生图渠道审核严格，违反会全部生成失败）：所有 prompt 中角色必须穿着得体完整的服装，严禁裸上身、内衣、泳装、湿身等描述；若参考图着装暴露，改为符合角色气质的休闲或运动服装'
      : ''
  }

严格输出 JSON 数组（不要输出其他任何内容），每项格式：
{"label": "中文短标签，如 封面·全身街拍", "prompt": "英文完整生图提示词：完整的角色外貌锚定 + 统一的风格色调光线锚定 + 本张特有的场景/景别/姿势/构图描述，80-150 词"}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: base64 } }, { text: instruction }]
      }
    ],
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' }
  };

  let data;
  try {
    data = await callGemini(settings.analysisModel, body, settings.apiKey);
  } catch (e) {
    if (e.status === 400) {
      delete body.generationConfig.responseMimeType;
      data = await callGemini(settings.analysisModel, body, settings.apiKey);
    } else {
      throw e;
    }
  }
  const { text } = extractParts(data);
  if (!text) throw new Error('分镜策划没有返回结果');
  const parsed = parseJsonLoose(text);
  const shots = (Array.isArray(parsed) ? parsed : parsed.shots || [])
    .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
    .map((s, i) => ({
      label: String(s.label || `第${i + 1}张`),
      prompt: s.prompt.trim() + (negativeTail ? ` ${negativeTail}` : '')
    }));
  if (!shots.length) throw new Error('分镜策划结果为空');
  return shots.slice(0, count);
}

/**
 * Write platform-native caption copy for a post set. Returns
 * { title, body, tags: [string] }. XHS copy is Chinese (种草 tone);
 * Instagram copy is an English caption with hashtags.
 */
export async function writePostCopy(
  { base64, mimeType, platform, presetName = '', shots = [] },
  settings
) {
  const shotList = shots.length ? `\n本组分镜（按顺序）：${shots.join('、')}` : '';
  const platformRules =
    platform === 'xhs'
      ? `平台：小红书。按爆款方法论逐项执行：
- title：14-20 个字，必须包含内容的核心关键词，从以下爆款公式中选最贴合的一种——数字清单（数字+价值承诺）/ 痛点提问（痛点场景+提问）/ 反差反常识（对比或颠覆认知+结果）/ 结果前置（时间或投入+结果）/ 身份+场景+结果；可带 1-2 个贴合的 emoji；严禁硬广叫卖词（上新、促销、满减、速抢）
- body：按「信任建立→价值传递→行动引导」三段写，共 120-220 字、分 4-6 个短行（用换行分隔）：开头 1-2 行用第一人称真实经历带出场景（像朋友分享，不能有广告腔）；中间以感官体验和场景效果为主、不堆参数，并自然带出一个无伤大雅的小缺点或注意点（增强真实感）；结尾给一句明确的行动建议 + 一句提问式互动钩子引导评论；适度穿插 emoji
- tags：8-12 个话题标签（中文，不带 # 号），三层搭配：2-3 个核心内容词、3-5 个长尾场景词、2-3 个与内容匹配的泛流量词（如 plog、氛围感、生活方式）`
      : `平台：Instagram。按爆款方法论逐项执行：
- title：一句英文 hook（caption 首行，用户在截断线前只能看到约 125 字符），60-100 字符，做一个具体、可感的承诺或强共鸣点，与封面图呼应但不重复画面内容；严禁 generic 标题
- body：120-200 词的英文 caption：先承接 hook 展开个人视角的故事或场景细节（有 personality，不复述图片）；中段 2-3 句给出价值、体验或心得；结尾一句 call-to-action（save this 或 comment 提问，二选一）+ 一个引导评论的问题；句组之间空行，可带少量 emoji
- tags：10-15 个英文 hashtag（不带 # 号），三层搭配：3-4 个大流量词（百万级帖量）、6-8 个精准小众词、1-3 个风格或社群词`;

  const instruction = `你是资深社交媒体运营。根据这张参考图${presetName ? `与内容主题「${presetName}」` : ''}，为一组系列 post 图撰写发布文案。${shotList}

${platformRules}

严格输出 JSON 对象（不要输出其他任何内容）：
{"title": "...", "body": "...", "tags": ["...", "..."]}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: base64 } }, { text: instruction }]
      }
    ],
    generationConfig: { temperature: 0.9, responseMimeType: 'application/json' }
  };

  let data;
  try {
    data = await callGemini(settings.analysisModel, body, settings.apiKey);
  } catch (e) {
    if (e.status === 400) {
      delete body.generationConfig.responseMimeType;
      data = await callGemini(settings.analysisModel, body, settings.apiKey);
    } else {
      throw e;
    }
  }
  const { text } = extractParts(data);
  if (!text) throw new Error('文案生成没有返回结果');
  const parsed = parseJsonLoose(text);
  const title = String(parsed.title || '').trim();
  const bodyText = String(parsed.body || '').trim();
  const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
    .map((t) => String(t).replace(/^#/, '').trim())
    .filter(Boolean);
  if (!title && !bodyText) throw new Error('文案生成结果为空');
  return { title, body: bodyText, tags };
}

const DESCRIBE_CHAR_INSTRUCTION = `用中文精确描述图中主要角色的外貌，目的是在其他图片中还原这个角色。涵盖：性别与大致年龄、脸型与五官特点、发型与发色、肤色体型、服装（款式/颜色/材质/配饰）、任何标志性特征（痣、眼镜、纹身、饰品等）。输出一段 60-120 字的紧凑描述，不要分条、不要输出其他内容。`;

export async function describeCharacter({ base64, mimeType }, settings) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: base64 } }, { text: DESCRIBE_CHAR_INSTRUCTION }]
      }
    ],
    generationConfig: { temperature: 0.3 }
  };
  const data = await callGemini(settings.analysisModel, body, settings.apiKey);
  const { text } = extractParts(data);
  return text.trim();
}

/**
 * Shared instruction builder for both providers. Reference images (pose,
 * style, character -- in that order) are numbered 图1/图2/... matching the
 * order they are attached to the request.
 */
export function buildGenInstruction({ hasPose, hasStyle, hasChar, charDesc, prompt }) {
  const lines = [];
  let idx = 1;
  if (hasPose) {
    lines.push(
      `图${idx++}是姿势与构图参考：严格复刻图中人物的姿势、头部朝向、身体朝向、四肢与手的位置、构图裁切线、主体在画面中的占比和位置，不得重新构图、不得改变姿势。`
    );
  }
  if (hasStyle) {
    lines.push(`图${idx++}是风格参考：延续它的艺术风格、光线与色彩氛围（不必照抄画面内容）。`);
  }
  if (hasChar) {
    lines.push(
      `图${idx++}是角色参考：画面中的人物必须替换为这个角色，忠实保留该角色的脸部特征、发型发色、体型与服装特征。` +
        (charDesc ? `角色特征补充：${charDesc}` : '')
    );
  }
  if (!lines.length) {
    return (
      'Generate an image. Strictly follow every pose, framing, crop line, camera angle and subject-proportion detail described below — do not re-compose or change the pose:\n' +
      prompt
    );
  }
  lines.push(`其余画面内容按以下提示词生成：\n${prompt}`);
  return lines.join('\n');
}

export async function generateImage(
  { prompt, aspectRatio, imageSize, poseRefPart, styleRefPart, charPart, charDesc },
  settings
) {
  const parts = [];
  if (poseRefPart) parts.push(poseRefPart);
  if (styleRefPart) parts.push(styleRefPart);
  if (charPart) parts.push(charPart);
  parts.push({
    text: buildGenInstruction({
      hasPose: !!poseRefPart,
      hasStyle: !!styleRefPart,
      hasChar: !!charPart,
      charDesc,
      prompt
    })
  });

  const base = { contents: [{ role: 'user', parts }] };
  const imageOpts = { aspectRatio, imageSize };

  // Newer image models use generationConfig.responseFormat; older ones use
  // imageConfig. Try in order and fall back on schema-related 400 errors.
  const attempts = [
    { responseModalities: ['TEXT', 'IMAGE'], responseFormat: { image: imageOpts } },
    { responseModalities: ['TEXT', 'IMAGE'], imageConfig: imageOpts },
    { responseModalities: ['TEXT', 'IMAGE'] }
  ];

  // Only fall through on schema-shape errors (unknown field names between API
  // versions). Real 400s -- safety blocks, bad sizes, quota -- must surface
  // their original message instead of being retried and masked.
  const isSchemaError = (e) =>
    e.status === 400 &&
    /unknown name|invalid json payload|cannot find field|responseformat|response_format|imageconfig|image_config/i.test(
      e.message || ''
    );

  let lastError;
  for (const generationConfig of attempts) {
    try {
      const data = await callGemini(settings.imageModel, { ...base, generationConfig }, settings.apiKey);
      return extractParts(data);
    } catch (e) {
      if (!isSchemaError(e)) throw e;
      lastError = e;
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
