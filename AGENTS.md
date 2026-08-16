# Prompt Lens — 开发交接文档（给 AI 助手）

自用 Chrome 插件（Manifest V3，纯原生 JS，无构建步骤）：反推网页图片的提示词，并用 Gemini / GPT-Image / Seedream / 本地 ComfyUI 生成新图、多模型对比、批量生成社交平台组图、FlowAgent 生成视频。灵感来自 viko.fun。当前版本 **0.9.0**，git 历史完整（中文提交信息）。

## 开发约定

- **无构建、无依赖**：全部是原生 ES Module，直接改文件、在 `chrome://extensions` 刷新插件即可验证。不要引入打包器或 npm 依赖。
- **测试**：`node scripts/test_gemini.mjs` 是离线测试套件（stub fetch，覆盖 Gemini/OpenAI/APIMart 协议、分镜策划、预设注入、错误映射）。改动 lib/ 或 background.js 后必须跑通它，并对改动文件跑 `node --check`。
- **每完成一个功能**：更新 README 功能列表、manifest.json 版本号（+0.1.0），用中文提交。
- **UI 语言**是中文；发给生图模型的提示词是英文；给分析/策划模型的指令是中文。

## 架构速览

```
manifest.json     MV3 清单（permissions: storage/unlimitedStorage/sidePanel/downloads/alarms 等）
background.js     Service Worker：任务调度中枢，所有 API 调用都在这里发起（五渠道分发）
lib/
  settings.js     设置默认值 + chrome.storage.sync 读写
  gemini.js       Gemini 封装：reversePrompt(多维解构) / generateImage / describeCharacter / planPostSet(组图分镜策划)
  openai.js       GPT-Image 渠道：OpenAI 官方同步协议 + APIMart 异步任务协议（提交→轮询→下载）
  atlas.js        Seedream 渠道（Atlas Cloud）：generateImage 提交→轮询 prediction；参考图自动切 /edit 模型变体
  comfy.js        本地 ComfyUI 渠道：内置 txt2img 工作流图→POST /prompt→轮询 /history→/view 取图
  flowagent.js    FlowAgent 视频（本机 Google Flow 桥接，OpenAI 兼容）：提交→轮询 job→下载 mp4；响应解析容错多种 fork
  presets.js      8 个组图内容预设（英文风格锚 + 中文分镜节奏 + 平台规则）+ NEGATIVE_TAIL 负面词
  util.js         uid / base64 / 缩略图（OffscreenCanvas, 1280px JPEG）/ urlToDataUrl / friendlyGenError
content/          悬浮球内容脚本（悬停网页图片→反推）
popup/            弹窗：上传/粘贴图片入口（注意：openSidePanel 必须在用户手势同步调用）
sidepanel/        快速反推主界面：画面解构、生图控制、组图创作、角色卡、历史；顶栏可跳画布
canvas/           画布工作台（新标签页）：左栏源图+提示词编辑，右侧多渠道对比网格 + FlowAgent 视频
options/          设置页：五渠道配置（Key/地址/模型）与连通测试
viewer/           大图查看页（新标签页打开，下载/复制提示词）
scripts/          test_gemini.mjs（离线测试）、gen_icons.py（图标生成）
```

## 关键数据模型（chrome.storage.local）

- `tasks`：{ id → task }，上限 50 个。task = { id, createdAt, source:{dataUrl,...}, status, result:{prompt, promptZh, imageType, analysis, tags, palette}, generations:[gen] }
- gen = { id, status(running/done/error), kind(image/video), prompt, aspectRatio, imageSize, refMode(pose/style/none/source), provider(gemini/openai/seedream/comfy/flowagent), characterId/Name, setId/setLabel/setIndex/setTotal/setPreset（组图字段）, compareId（对比批次）, duration（视频秒数）, remoteTaskId（统一远程任务号，旧记录用 apimartTaskId）, images:[dataUrl], videos:[dataUrl], error }
- `characters`：角色卡 { id → {name, dataUrl, desc, status, error} }，desc 由 describeCharacter 自动识别
- 设置在 `chrome.storage.sync`（API Key 等，见 lib/settings.js 的 DEFAULTS）

## 必须知道的坑（都踩过）

1. **Service Worker 会被回收**：APIMart 异步任务靠三重保险恢复轮询——gen 上持久化 apimartTaskId + chrome.alarms 每 30 秒 watchdog（syncResumeAlarm/resumePendingGenerations）+ 侧边栏打开时发 RESUME_PENDING。轮询期间定时调 chrome.runtime.getPlatformInfo 保活。
2. **并发写覆盖**：更新单条 gen 必须用 background.js 的 `updateGen(taskId, genId, mutate)`（读-改-写单条记录），不要整个 task 对象覆盖写。
3. **chrome.sidePanel.open() 必须在用户手势的同步调用栈里**，不能放在 FileReader 回调等异步后。
4. **GPT-Image 内容审核比 Gemini 严格得多**：写实人物的裸露/内衣描述会被拒（"rejected by the content safety system"）。已做：planPostSet 在 provider==='openai' 时注入着装硬约束；friendlyGenError 把审核错误翻译成带建议的中文；失败 gen 可用面板当前渠道重试（RETRY_GEN 带 provider 覆盖）。
5. **Gemini 生图 API 的 responseFormat 字段**：部分模型版本报 400，callGemini 有降级重试逻辑（responseFormat → imageConfig → 移除）；区分 schema 错误和语义错误（isSchemaError），别把真实错误吞了。
6. APIMart 的 `/v1/images/generations` 用 `size` 传画幅比例字符串（如 "3:4"）、`resolution` 传 "1k/2k/4k"、参考图用 `image_urls`（dataURL 数组）；响应是 `data[0].task_id`，轮询 `/v1/tasks/{id}`。

## 生图流程（background.js）

单张：startGeneration → makeGenRecord → executeGeneration（统一执行器：解析角色卡/参考图 → 按 provider 分发 gemini/openai/seedream/comfy，kind==='video' 走 flowagent → updateGen 落结果）。
组图：startPostSet → planPostSet（Gemini 视觉模型看参考图出分镜 JSON 数组，注入预设风格锚 + 平台规则 + NEGATIVE_TAIL）→ 批量建 gen（带 setId）→ runWithConcurrency 并发 2 执行。
对比：startCompareGeneration（GENERATE_COMPARE 消息）→ 每个勾选渠道各建一条 gen（同 compareId）→ Promise.all 并行执行（不同后端无共享限流）。
视频：startVideoGeneration（GENERATE_VIDEO 消息）→ kind='video' 的 gen → generateVideoFlow（withImage 时把当前图作为参考）。
重试：retryGeneration 重置 gen 状态后走 executeGeneration，可覆盖 provider（视频 gen 不换渠道）。
断点恢复：所有异步渠道的远程任务号统一存 gen.remoteTaskId（读取时兼容旧 apimartTaskId），resumePendingGenerations 按 provider/kind 选择对应轮询函数。

## 用户使用配置（换机后需重新配置）

- API Key 存在浏览器 chrome.storage.sync，不在仓库里。PC 上加载插件后要在设置页重新填：Gemini API Key（必须，反推和策划都用它）、APIMart Key（可选，GPT-Image 渠道，baseUrl 默认 https://api.apimart.ai/v1）、Atlas Cloud Key（可选，Seedream 渠道）。
- 本地服务（可选）：ComfyUI 默认 http://127.0.0.1:8188（设置页测试连通后可下拉选 checkpoint）；FlowAgent 默认 http://127.0.0.1:8001（视频，无需 Key；8001 是共享后端桥的 OpenAI 兼容端口）。
- 加载方式：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选本文件夹。

## 已知待办 / 可能的下一步

- 组图创作目前每张只出 1 图；可考虑失败自动降级换渠道重试。
- 组图的分镜策划强依赖 Gemini Key；可考虑支持用 OpenAI 兼容的文本模型做策划。
- 历史记录上限 50 个任务，图片是 dataURL 全量存储，长期可考虑清理策略或 IndexedDB。
- 角色卡目前只有外貌描述文本 + 单张参考图；可考虑多参考图角色卡。
- 预设库（lib/presets.js）可继续扩充；来源参考：GitHub 上 YouMind-OpenLab/awesome-nano-banana-pro-prompts、ZaynJarvis/aesthetics。
