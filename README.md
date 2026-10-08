# Prompt Lens

自用 Chrome 插件：反推网页图片的提示词，并用多个模型直接生成新图。灵感来自 [Viko](https://viko.fun)。

## 功能

- **悬浮球反推**：鼠标悬停在网页图片上出现悬浮球，点击即可反推提示词，结果显示在浏览器侧边栏
- **弹窗入口**：点击插件图标，粘贴 / 拖入 / 上传本地图片进行反推
- **多维度画面解构**：图像类型 + 主体 / 姿势 / 环境 / 构图 / 光线 / 色彩 / 风格 / 细节 / 氛围逐项分析，附词卡与主色色卡，点击即复制
- **中英双语提示词**：英文提示词可直接编辑后送去生图，附中文对照
- **四生图渠道**：Gemini、GPT-Image（APIMart / OpenAI）、Seedream（Atlas Cloud）、Grok（grok2api，支持文生图及参考图编辑）。ComfyUI 暂停使用，历史图片和旧配置保留。
- **画布工作台**：侧边栏保持快速反推定位，点顶栏画布按钮在新标签页打开全屏工作台——左栏源图与提示词编辑，右侧勾选多个渠道后同一提示词并行发给所有渠道，结果按批次排成对比网格，每格独立重试/下载
- **FlowKit 视频**：Omni Flash 文生视频（4/6/8/10 秒、720p）及 Veo 3.1 Lite 首帧图生视频（固定 8 秒、720p），支持查询、播放和下载。画布与侧栏可从原图或指定成图发起图生视频。目前仅通过离线验证，尚未实机验收。
- **侧边栏生图**：选择画幅（1:1 到 21:9）与分辨率（512 / 1K / 2K / 4K，自动映射为各渠道支持的尺寸）
- **姿势复刻**：生成时把原图作为姿态与构图约束送入模型，锁定人物姿势、裁切与画面占比（也可切换为风格参考 / 纯提示词）
- **角色卡替换**：从反推图或上传图保存角色卡（自动识别外貌特征），生成时选择角色卡即可把画面人物替换为该角色
- **组图创作**：以当前图为风格锚，AI 先策划分镜（每张场景/景别/姿势不同、角色与风格统一），再按小红书（3:4）或 Instagram（4:5 / 1:1）画幅批量生成 4-6 张 post 图；每张独立记录、失败可单张重试。选了角色卡时自动锚定该角色最新一张换角色成图——人物五官、服装穿搭、整体风格都以成图为准，而不是只读角色卡
- **组图配套文案（爆款方法论）**：组图生成的同时自动写好发布文案，指令内置各平台爆款打法——小红书：五选一标题公式（数字清单/痛点提问/反差反常识/结果前置/身份+场景+结果）+「信任建立→价值传递→行动引导」三段种草正文（含真实感小缺点与互动钩子）+ 核心词/长尾词/泛流量词三层话题标签；Instagram：125 字符截断线内的 hook 首行 + 个人视角 caption + save/comment CTA + 大流量/精准/社群三层 hashtags。分镜策划同步注入平台规则：小红书封面强制真人出镜、主体突出、顶部 15% 留白，Instagram 按 carousel 叙事弧（hook→细节→场景→变化→CTA 收尾）编排。文案可一键复制、不满意可重新生成
- **内容预设库**：内置 8 个从优质提示词库蒸馏的组图预设（咖啡探店 plog、OOTD 街拍、居家氛围感、旅行 plog、Clean Girl 极简、Editorial 杂志街拍、胶片 Film Look、运动 Lifestyle），每个预设带英文风格锚、分镜节奏与平台规则（小红书封面自动留标题空位），并自动追加防水印/防乱码/防坏手负面词
- **历史记录**：本地保留最近 50 个任务，可随时回看、重新生成；点击任意图片在新标签页查看大图并下载
- **断点续传**：APIMart / Atlas Cloud 持久化远程任务号；FlowKit 保存原始轮询句柄，文生视频保留账号、项目，图生视频由服务端恢复原 operation 归属。上传或提交结果不明（`uncertain`）、超时或断网不自动重传或重新生成。Grok 为同步请求，不支持远程任务恢复。旧视频与 ComfyUI 任务保留，旧远程视频任务不会交给 FlowKit 查询或重新提交。

## v1.9.0：本机 FlowKit 文生视频与首帧图生视频

- 视频设置改为 FlowKit 地址，默认 `http://127.0.0.1:8111`，无需 API Key、Google Cookie 或 Flow Key。旧视频服务的地址、模型和 Key 设置不参与新请求，已有视频资产继续保留。
- 设置页连通测试与生成前预检依次读取 `/health`、`/api/flow/status`、`/api/slots`；要求插件已连接、`transport=batch`，并有在线、未阻断、有空槽且连接与项目齐全的账号。文生视频将该账号的 `connection_id` 和 `project_id` 成对传入。连通测试不消耗生成额度，也不证明视频生成成功。
- 文生视频走 `/api/flow/generate-video-omni-text`，原任务查询走 `/api/flow/check-status`，保留提交响应中的 `operations` 或 `flowkitPolling.workflows`。提交前另存独立的 `flowkitVideo:<genId>` 回执；即使任务列表被并发旧快照覆盖，重试仍读取该回执，禁止重新提交。`uncertain` 只保留证据，有查询句柄时查询原任务。
- 首帧通过 `/api/flow/upload-image` 上传纯 `image_base64`、`mime_type`、`file_name` 和逻辑 `project_id`，读取顶层 `media_id`；随后向 `/api/flow/generate-video` 传 `start_image_media_id`，模型为 `veo_3_1_i2v_lite`。上传与 I2V 不指定 `connection_id`，由服务端按 `media_owner` 调度同一账号；轮询只传原始 `operations`，由服务端恢复原 operation 的归属。Veo 固定 8 秒，提交体与 Shotline 一致，不传 Omni 的可变时长/分辨率参数。
- 上传前和视频提交前均保存独立 `flowkitVideo:<genId>` 回执，保留上传响应、媒体 ID、提交请求和原始轮询句柄。上传结果不明时不重传、不提交视频；上传已确认但流程中断且尚无 operation 时也保留回执待核对，不自动继续提交。已有 operation 只查询原任务，缺少所选首帧时明确报错。
- 接口已静态对照 Shotline `shot-fallback.ts`、`preview-assets.ts`、`preview.ts` 和 FlowKit `agent/api/flow.py`、`agent/services/omni_flash.py`。Veo 完成字段为 `operations[].operation.metadata.video.fifeUrl`，Omni 为 `workflows[].media.url`；两者均通过 `/api/flow/check-status` 查询。横版来源于 Shotline，竖版枚举补充依据 `CALLING-GUIDE-20260929.md`。本次不启动服务、不发起真实生成；当前运行实例及最终下载的端到端验收仍待另行执行。

## v1.7.0：网页悬浮入口连接提示

- 悬浮按钮检查后台确认，不再无条件显示“已开始反推”。扩展更新后旧网页脚本连接失效时，提示刷新当前网页；后台拒绝或无响应时显示失败。
- 重载插件后，请同时刷新要取图的网页。旧网页仍运行更新前注入的脚本，刷新后才会加载新版。

## v1.6.0：旧地址迁移与 Seedream 只换脸

- 首次读取旧本机默认地址 `127.0.0.1:8011` / `localhost:8011` 时，迁移到 `http://127.0.0.1:8000/v1` 和 JSON 编辑协议；不覆盖其他地址，迁移后手动修改也不会再次被覆盖。
- Seedream 选角色卡时以原图为第一张参考、角色卡为第二张参考，只替换脸部身份。原图的身体、姿势、构图、衣服、发型及背景保持不变，角色卡中的穿搭和体型描述不注入。
- 该规则优先于纯提示词/风格参考模式；带角色卡的 Seedream 组图也以原图锁定非面部区域。真实模型的换脸效果仍需人工查看生成结果。

## v1.5.0：本机 Grok 网关兼容

- 默认 Grok 地址修正为 `http://127.0.0.1:8000/v1`。已保存的自定义地址不自动覆盖；旧 8011 配置请在设置页修改并保存。
- 参考图协议可选 JSON（当前 Go 网关，默认）或 Multipart（Python 版）。JSON 使用 `images:[{url}]` 与 `size:auto` / `aspect_ratio`。
- 本机网关启用了鉴权，需要客户端 API Key；401 明确提示鉴权失败。连接错误显示实际地址及提交/下载阶段，避免把下载失败误认为尚未生成。

## v1.4.0：Seedream 鉴权诊断

- Seedream 测试改用官方只读 `/public/v1/balance`；只在成功响应时通过，404/429/500 不再误报成功。余额接口需要账户余额读取权限，403 不能直接判定生图权限。
- 提交/轮询错误保留 HTTP 状态、官方 `msg` / `error.message` 和 request ID，区分鉴权、余额、权限及限流；错误中隐藏回显的密钥。
- Key 自动清理首尾空白及误粘贴的 Bearer 前缀，提示公开 ID 误填。设置页测试使用输入框内容，但不会保存，修改后需要保存设置。
- 支持生成接口的 `data.id` 与直接 `id` 两种任务号响应。离线回归覆盖见 `scripts/test_atlas.mjs`。
- 接口核对依据：[官方错误说明](https://www.atlascloud.ai/docs/errors)、[官方鉴权与余额接口](https://www.atlascloud.ai/docs/public-api)。真实账户生成需在浏览器中另行验证。

## v1.3.0：Grok 接入

- 在设置页配置 Grok 服务地址和 API Key；未开启服务鉴权时 Key 可留空。测试按钮只验证模型列表，不消耗生成额度，也不代表真实生成成功。
- 单张、画布对比和组图均可选择 Grok；有参考图或角色卡时自动使用编辑模型。原默认渠道为 ComfyUI 时切换为 Grok，不删除旧数据。
- Grok 画幅按最近比例映射到 1:1、16:9、9:16、3:2、2:3，512/1K/2K/4K 选项不控制 Grok 输出分辨率，实际尺寸由后端决定。
- 重载扩展后需刷新已打开的画布和侧边栏。

## 安装

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目文件夹
4. 点击插件图标 → 设置，填入 Gemini API Key（在 [Google AI Studio](https://aistudio.google.com/apikey) 免费创建）

## 使用的模型

| 用途 | 默认模型 | 说明 |
| --- | --- | --- |
| 反推提示词 | `gemini-flash-latest` | 稳定别名，自动指向最新 Flash 模型 |
| 生成图片（Gemini 渠道） | `gemini-3.1-flash-image` | Nano Banana 2，支持 4K 与多种画幅 |
| 生成图片（GPT-Image 渠道） | `gpt-image-2` | 默认 APIMart 异步协议（提交任务 → 轮询 → 下载）；切到 OpenAI 官方时走同步 `generations`/`edits` 接口 |
| 生成图片（Seedream 渠道） | `bytedance/seedream-v5.0-pro/text-to-image` | Atlas Cloud 异步协议（提交 → 轮询 prediction）；约 $0.045/张（1.5K 档，2K 满档 $0.09），edit 首张参考图免费、之后每张 +$0.003；Key 在 [Atlas Cloud 控制台](https://www.atlascloud.ai/console/api-keys) 创建 |
| 生成图片（Grok 渠道） | `grok-imagine-image` / `grok-imagine-image-edit` | 默认 `http://127.0.0.1:8000/v1`，地址、Key、生成和编辑模型均可修改 |
| 生成视频（FlowKit） | Omni Flash / Veo 3.1 Lite | 本机 `http://127.0.0.1:8111`，无需 API Key；支持文生视频和首帧图生视频；尚未实机验收 |

生图模型可以在设置页修改。API Key 只保存在浏览器本地（`chrome.storage.sync`），请求直接发往对应官方 API（或你自己填的中转地址），不经过其他第三方服务器。FlowKit 视频只配置本机服务地址，不使用 Key。

## 项目结构

```
manifest.json          MV3 清单
background.js          服务工作线程：任务调度、五渠道分发、断点恢复
lib/
  gemini.js            Gemini API 封装（反推 + 生图 + 分镜策划 + Key 测试）
  openai.js            GPT-Image 渠道封装（generations / edits + APIMart 异步协议）
  atlas.js             Seedream 渠道封装（Atlas Cloud 提交/轮询 + v4/v5 尺寸预设）
  grok.js             Grok2API 文生图 / 参考图编辑（同步 OpenAI Images 接口）
  comfy.js            保留的旧适配器，当前产品不再调用
  flowkit.js           FlowKit 视频封装（health/status/slots 预检、首帧上传、提交及原任务查询）
  presets.js           组图内容预设库（风格锚 + 分镜节奏 + 平台规则）
  settings.js          设置读写与默认值
  util.js              图片抓取、缩略图、base64 工具
content/               网页内容脚本（悬浮球 + toast）
sidepanel/             侧边栏：快速反推、生图、历史
canvas/                画布工作台：多模型对比生图 + FlowKit 视频
popup/                 插件弹窗：上传/粘贴图片入口
options/               设置页（五渠道配置与连通测试）
viewer/                大图查看页
scripts/gen_icons.py   图标生成脚本（纯 Python 标准库）
```

## 注意

- 生图使用你自己的 Gemini API 配额，按 Google 的价格计费（免费额度内免费）
- 少数网站的图片有防盗链，直接抓取会失败；可以把图片另存后从弹窗上传
