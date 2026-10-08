# Prompt Lens — 开发交接文档（给 AI 助手）

自用 Chrome 插件（Manifest V3，纯原生 JS，无构建步骤）：反推网页图片的提示词，并用 Gemini / GPT-Image / Seedream / Grok2API 生成新图、多模型对比、批量生成社交平台组图、FlowKit 生成视频。灵感来自 viko.fun。当前版本 **1.9.0**，git 历史完整（中文提交信息）。

## 开发约定

- **无构建、无依赖**：全部是原生 ES Module，直接改文件、在 `chrome://extensions` 刷新插件即可验证。不要引入打包器或 npm 依赖。
- **测试**：`node scripts/test_gemini.mjs` 是离线测试套件（stub fetch，覆盖 Gemini/OpenAI/APIMart/FlowKit 协议、分镜策划、预设注入、错误映射）。改动 lib/ 或 background.js 后必须跑通它，并对改动文件跑 `node --check`。
- **每完成一个功能**：更新 README 功能列表、manifest.json 版本号（+0.1.0），用中文提交。
- **UI 语言**是中文；发给生图模型的提示词是英文；给分析/策划模型的指令是中文。

## v1.9.0 FlowKit 视频（优先于旧视频说明）

- 本机 API 默认 `http://127.0.0.1:8111`，设置为 `flowkitBaseUrl`；不需要 API Key、Google Cookie 或 Flow Key。旧视频后端的地址、模型及 Key 配置不参与新请求；旧视频资产保留，旧远程视频任务不能传给新后端查询或重新提交。
- 依次 GET `/health`、`/api/flow/status`、`/api/slots`。要求 `extension_connected=true`、`transport=batch`，账号必须 `online=true`、`health.blocked=false`、`free>0` 且连接和项目齐全。文生视频将同一账号的 `connection_id` 与 `project_id` 成对传入；I2V 使用下述服务端归属规则，不把预检账号冒充首帧 owner。
- Omni Flash 文生视频已实现 POST `/api/flow/generate-video-omni-text`，支持 4/6/8/10 秒，本扩展使用 720p。当前只完成离线验证，尚未实机验收。
- 首帧图生视频：POST `/api/flow/upload-image`，JSON 包含纯 `image_base64`、`mime_type`、`file_name`、逻辑 `project_id`；返回顶层 `media_id`。POST `/api/flow/generate-video` 使用 `start_image_media_id`、`scene_id`、`prompt`、原上传 `project_id`、`model_family=veo`、`video_model=veo_3_1_i2v_lite`、`aspect_ratio`。固定 8 秒、720p；与 Shotline 一致不传 Veo 不使用的 `duration_s/resolution`。上传和 I2V 均不传 `connection_id`，由服务端按上传记录的 `media_owner` 调度。画布和侧栏已恢复原图/成图入口，指定成图通过 `refGenId/refImageIndex` 精确选择，缺图不能降级为文生视频。
- POST `/api/flow/check-status` 只查询原任务：I2V 回执带 `serverOwnedPolling=true`，只传原始 `operations`，由服务端恢复原 operation 归属并核对返回 operation；Omni 将 `flowkitPolling.workflows` 传入 `workflows`，保留提交时的账号、项目标识。存在原始 `operations` 时优先查询它。`uncertain`、超时或断网都不证明未上传/未提交，不自动重传或重提。
- 接口静态核对依据为 Shotline `server/src/flow/shot-fallback.ts`、`preview-assets.ts`、`preview.ts`；浏览器 base64 上传与 Omni 补充依据为 FlowKit `agent/api/flow.py`、`agent/services/omni_flash.py`，竖版枚举见 `CALLING-GUIDE-20260929.md`。完成字段为 `operations[].operation.metadata.video.fifeUrl` 和 `workflows[].media.url`。当前实例尚未端到端验收；只做离线 stub 测试，不启动服务或提交真实生成，不能把离线通过写成实际生成已验收。
- 上传前和视频提交前持久化独立回执 `flowkitVideo:<genId>`，执行和恢复时优先读取；即使 `tasks` 被并发旧快照覆盖，也不能因此重传首帧或重提视频。保留上传响应、媒体 ID、提交请求及原始轮询句柄。上传成功但流程中断且没有 operation 时，也停在回执待核对，不自动继续提交。
- 旧本机 Origin 剥除规则 101/102 退役；`host_permissions` 的 `<all_urls>` 已覆盖本机 8111，无需重复添加端口权限。

## v1.6.0 当前规则

- `getSettings` 对旧默认 Grok 本机 8011 地址执行一次持久化迁移：8000/v1 + JSON，记录 `grokEndpointRevision=1`。以后手动保存的地址不再覆盖。
- Seedream 有角色卡及原图时仅换脸：原图为图1，角色卡为图2，英文硬约束保留非面部区域；不注入角色卡体型/服装文字，不以旧成图替代角色卡。其他渠道沿用原逻辑。

## v1.5.0 Grok 网关兼容（优先于旧说明）

- 默认地址为 `http://127.0.0.1:8000/v1`；不自动覆盖已保存地址。
- `grokEditProtocol` 默认 `json`：Go 版编辑接口只接受 JSON `images:[{url}]`，使用 `size:auto` 及 `aspect_ratio`；`multipart` 适配 Python 版。
- 当前本机服务健康接口在线，但未带客户端 Key 请求 `/v1/models` 返回 401。真实生图尚未验收，不重提交用户的未知结果任务。

## v1.4.0 Seedream 诊断

- `testAtlasKey` 使用 `/public/v1/balance` 只读接口，返回明确的验证范围；余额查询 403 不等于生图无权限。不能用虚构 prediction ID 的 404 当作 Key 有效证据。
- Atlas 错误解析读取 `msg`、`message`、`error.message`，保留 HTTP 状态和 request ID。生成响应兼容 `data.id` / `id`。
- 完整回归 `node scripts/test_gemini.mjs` 包含 `scripts/test_atlas.mjs`；不自动重提交远程失败/未知任务。

## v1.3.0 接入说明（优先于下文旧版 ComfyUI 描述）

- 当前第四生图渠道为 `grok`，适配器 `lib/grok.js`：同步 `/v1/images/generations` 与 multipart `/v1/images/edits`，支持参考图和角色卡。
- 配置：`grokBaseUrl`（默认 `http://127.0.0.1:8011/v1`）、`grokApiKey`、`grokImageModel`、`grokEditModel`。文生图默认 `grok-imagine-image`，编辑默认 `grok-imagine-image-edit`。
- 五档画幅就近映射；不承诺用户所选分辨率。同步请求保活但不支持远程恢复，超时不自动重发。
- ComfyUI 设置/选项和执行路径停用；旧适配器与测试留存，旧任务/图片/配置不删除，旧任务不自动轮询。默认渠道 `comfy` 读取或升级时迁移为 `grok`。旧本机 DNR 规则 101/102 均已退役。
- `node scripts/test_gemini.mjs` 已包含 `scripts/test_grok.mjs`。Grok 设置页测试仅验证模型列表；真实服务生成另行验收。

## 架构速览

```
manifest.json     MV3 清单（permissions: storage/unlimitedStorage/sidePanel/downloads/alarms 等）
background.js     Service Worker：任务调度中枢，所有 API 调用都在这里发起（五渠道分发）
lib/
  settings.js     设置默认值 + chrome.storage.sync 读写
  gemini.js       Gemini 封装：reversePrompt(多维解构) / generateImage / describeCharacter / planPostSet(组图分镜策划)
  openai.js       GPT-Image 渠道：OpenAI 官方同步协议 + APIMart 异步任务协议（提交→轮询→下载）
  atlas.js        Seedream 渠道（Atlas Cloud）：generateImage 提交→轮询 prediction；参考图自动切 /edit 模型变体；默认 Seedream 5.0 Pro（只接受枚举尺寸表，v4 用宽高预设）
  comfy.js        本地 ComfyUI 渠道：checkpoint txt2img 工作流 + Z-Image Turbo 专属工作流（模型名匹配 z[-_]?image 自动切换：UNETLoader + lumina2 CLIP(qwen_3_4b) + Flux AE，固定 9 步 CFG 1.0）→POST /prompt→轮询 /history→/view 取图
  flowkit.js      FlowKit 视频：health/status/slots 预检→首帧上传或文生视频→查询原始 operations/workflows→下载视频
  presets.js      8 个组图内容预设（英文风格锚 + 中文分镜节奏 + 平台规则）+ NEGATIVE_TAIL 负面词
  util.js         uid / base64 / 缩略图（OffscreenCanvas, 1280px JPEG）/ urlToDataUrl / friendlyGenError
content/          悬浮球内容脚本（悬停网页图片→反推）
popup/            弹窗：上传/粘贴图片入口（注意：openSidePanel 必须在用户手势同步调用）
sidepanel/        快速反推主界面：画面解构、生图控制、组图创作、角色卡、历史；顶栏可跳画布
canvas/           画布工作台（新标签页）：左栏源图+提示词编辑，右侧多渠道对比网格 + FlowKit 视频
options/          设置页：五渠道配置（Key/地址/模型）与连通测试
viewer/           大图查看页（新标签页打开，下载/复制提示词）
scripts/          test_gemini.mjs（离线测试）、gen_icons.py（图标生成）
```

## 关键数据模型（chrome.storage.local）

- `tasks`：{ id → task }，上限 50 个。task = { id, createdAt, source:{dataUrl,...}, status, result:{prompt, promptZh, imageType, analysis, tags, palette}, generations:[gen] }
- gen = { id, status(running/done/error), kind(image/video), prompt, aspectRatio, imageSize, refMode(pose/style/none/source), provider(gemini/openai/seedream/grok/flowkit；旧 comfy 记录保留), characterId/Name, setId/setLabel/setIndex/setTotal/setPreset（组图字段）, compareId（对比批次）, duration（视频秒数）, remoteTaskId（远程恢复标识；FlowKit 需保留原始轮询句柄及账号/项目，旧记录用 apimartTaskId）, images:[dataUrl], videos:[dataUrl], error }
- `flowkitVideo:<genId>`：独立的视频提交回执，保存提交前状态与后续轮询描述，不依赖 `tasks` 快照保留禁止重提标记；恢复时以该回执为优先依据。
- `task.postCopies`：{ setId → {status, platform(xhs/ins), presetName, title, body, tags:[], error} }，组图的配套发布文案（writePostCopy 生成，画布展示/复制/重新生成，消息 REGENERATE_COPY）
- `characters`：角色卡 { id → {name, dataUrl, desc, status, error} }，desc 由 describeCharacter 自动识别
- 设置在 `chrome.storage.sync`（API Key 等，见 lib/settings.js 的 DEFAULTS）

## 必须知道的坑（都踩过）

1. **Service Worker 会被回收**：APIMart 异步任务靠三重保险恢复轮询——gen 上持久化 apimartTaskId + chrome.alarms 每 30 秒 watchdog（syncResumeAlarm/resumePendingGenerations）+ 侧边栏打开时发 RESUME_PENDING。轮询期间定时调 chrome.runtime.getPlatformInfo 保活。
2. **并发写覆盖**：更新单条 gen 必须用 background.js 的 `updateGen(taskId, genId, mutate)`（读-改-写单条记录），不要整个 task 对象覆盖写。
3. **chrome.sidePanel.open() 必须在用户手势的同步调用栈里**，不能放在 FileReader 回调等异步后。
4. **GPT-Image 内容审核比 Gemini 严格得多**：写实人物的裸露/内衣描述会被拒（"rejected by the content safety system"）。已做：planPostSet 在 provider==='openai' 时注入着装硬约束；friendlyGenError 把审核错误翻译成带建议的中文；失败 gen 可用面板当前渠道重试（RETRY_GEN 带 provider 覆盖）。
5. **Gemini 生图 API 的 responseFormat 字段**：部分模型版本报 400，callGemini 有降级重试逻辑（responseFormat → imageConfig → 移除）；区分 schema 错误和语义错误（isSchemaError），别把真实错误吞了。
6. APIMart 的 `/v1/images/generations` 用 `size` 传画幅比例字符串（如 "3:4"）、`resolution` 传 "1k/2k/4k"、参考图用 `image_urls`（dataURL 数组）；响应是 `data[0].task_id`，轮询 `/v1/tasks/{id}`。
7. **不要把旧视频任务交给新后端**：FlowKit 只恢复属于自身的原始轮询上下文；旧视频资产保持可见，旧远程任务停止自动恢复。提交结果不明时保留原始响应、账号、项目及 operation/workflow 标识，不清空后重新生成。

## 生图流程（background.js）

单张：startGeneration → makeGenRecord → executeGeneration（统一执行器：解析角色卡/参考图 → 按 provider 分发 gemini/openai/seedream/grok，kind==='video' 走 flowkit → updateGen 落结果）。
组图：startPostSet → planPostSet（Gemini 视觉模型看参考图出分镜 JSON 数组，注入预设风格锚 + 平台规则 + NEGATIVE_TAIL）→ 批量建 gen（带 setId）→ runWithConcurrency 并发 2 执行；同时 runPostCopy 用锚图 + 分镜标签调 writePostCopy 生成平台文案（小红书标题/正文/标签，ins 英文 caption+hashtags），存 task.postCopies[setId]，画布可重新生成（REGENERATE_COPY）。侧边栏和画布都能发起组图（画布入口带独立渠道下拉）。
对比：startCompareGeneration（GENERATE_COMPARE 消息）→ 每个勾选渠道各建一条 gen（同 compareId）→ Promise.all 并行执行（不同后端无共享限流）。
视频：startVideoGeneration（GENERATE_VIDEO 消息）→ kind='video'、provider='flowkit' 的 gen → FlowKit 客户端。withImage 首帧路线先上传原图或 `refGenId/refImageIndex` 指定成图，再提交 Veo I2V；无首帧走 Omni 文生视频。缺少指定首帧时报错，不回退其他图片或文生视频。
重试：retryGeneration 重置 gen 状态后走 executeGeneration，可覆盖生图 provider。FlowKit 视频先读取独立回执，已提交任务只查询原句柄，不清空回执重新生成。
断点恢复：异步渠道的远程标识存 gen.remoteTaskId（读取时兼容旧 apimartTaskId）；FlowKit 另有独立的 flowkitVideo:<genId> 回执，优先据此恢复。resumePendingGenerations 按 provider/kind 选择对应轮询函数。

## 用户使用配置（换机后需重新配置）

- API Key 存在浏览器 chrome.storage.sync，不在仓库里。PC 上加载插件后要在设置页重新填：Gemini API Key（必须，反推和策划都用它）、APIMart Key（可选，GPT-Image 渠道，baseUrl 默认 https://api.apimart.ai/v1）、Atlas Cloud Key（可选，Seedream 渠道）。
- 本地服务（可选）：FlowKit 默认 http://127.0.0.1:8111（视频，无需 Key，设置页只检查 health/status/slots）；Grok 默认 http://127.0.0.1:8000/v1（生图，按服务配置填写客户端 Key）。ComfyUI 的旧配置保留，但产品不再调用。
- 加载方式：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选本文件夹。

## 已知待办 / 可能的下一步

- 对当前 FlowKit 实例完成文生视频、图生视频及最终下载的端到端验收（需另行授权真实生成，离线通过不代表实机验收）。
- 组图创作目前每张只出 1 图；可考虑失败自动降级换渠道重试。
- 组图的分镜策划强依赖 Gemini Key；可考虑支持用 OpenAI 兼容的文本模型做策划。
- 历史记录上限 50 个任务，图片是 dataURL 全量存储，长期可考虑清理策略或 IndexedDB。
- 角色卡目前只有外貌描述文本 + 单张参考图；可考虑多参考图角色卡。
- 预设库（lib/presets.js）可继续扩充；来源参考：GitHub 上 YouMind-OpenLab/awesome-nano-banana-pro-prompts、ZaynJarvis/aesthetics。
