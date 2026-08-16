# Prompt Lens

自用 Chrome 插件：反推网页图片的提示词，并用多个模型直接生成新图。灵感来自 [Viko](https://viko.fun)。

## 功能

- **悬浮球反推**：鼠标悬停在网页图片上出现悬浮球，点击即可反推提示词，结果显示在浏览器侧边栏
- **弹窗入口**：点击插件图标，粘贴 / 拖入 / 上传本地图片进行反推
- **多维度画面解构**：图像类型 + 主体 / 姿势 / 环境 / 构图 / 光线 / 色彩 / 风格 / 细节 / 氛围逐项分析，附词卡与主色色卡，点击即复制
- **中英双语提示词**：英文提示词可直接编辑后送去生图，附中文对照
- **四生图渠道**：Gemini（Nano Banana 2）、GPT-Image（gpt-image-2，默认走 APIMart 异步协议，兼容 OpenAI 官方同步接口）、Seedream（Atlas Cloud 中转，带参考图时自动切 edit 变体）、本地 ComfyUI（开源模型，内置 txt2img 工作流，checkpoint/步数/CFG 可配置）
- **画布工作台**：侧边栏保持快速反推定位，点顶栏画布按钮在新标签页打开全屏工作台——左栏源图与提示词编辑，右侧勾选多个渠道后同一提示词并行发给所有渠道，结果按批次排成对比网格，每格独立重试/下载
- **FlowAgent 视频**：接入本机 FlowAgent 服务（Google Flow 桥接，OpenAI 兼容接口），在画布中文生视频或以当前图为参考图生视频（4/6/8/10 秒），结果卡片内嵌播放器，可下载 mp4
- **侧边栏生图**：选择画幅（1:1 到 21:9）与分辨率（512 / 1K / 2K / 4K，自动映射为各渠道支持的尺寸）
- **姿势复刻**：生成时把原图作为姿态与构图约束送入模型，锁定人物姿势、裁切与画面占比（也可切换为风格参考 / 纯提示词）
- **角色卡替换**：从反推图或上传图保存角色卡（自动识别外貌特征），生成时选择角色卡即可把画面人物替换为该角色
- **组图创作**：以当前图为风格锚，AI 先策划分镜（每张场景/景别/姿势不同、角色与风格统一），再按小红书（3:4）或 Instagram（4:5 / 1:1）画幅批量生成 4-6 张 post 图；每张独立记录、失败可单张重试。选了角色卡时自动锚定该角色最新一张换角色成图——人物五官、服装穿搭、整体风格都以成图为准，而不是只读角色卡
- **内容预设库**：内置 8 个从优质提示词库蒸馏的组图预设（咖啡探店 plog、OOTD 街拍、居家氛围感、旅行 plog、Clean Girl 极简、Editorial 杂志街拍、胶片 Film Look、运动 Lifestyle），每个预设带英文风格锚、分镜节奏与平台规则（小红书封面自动留标题空位），并自动追加防水印/防乱码/防坏手负面词
- **历史记录**：本地保留最近 50 个任务，可随时回看、重新生成；点击任意图片在新标签页查看大图并下载
- **断点续传**：APIMart / Atlas Cloud / ComfyUI / FlowAgent 的远程任务号都会持久化，插件后台被浏览器回收后自动恢复轮询（启动时 / 每 30 秒闹钟 / 打开侧边栏或画布时），不丢结果

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
| 生成图片（Seedream 渠道） | `bytedance/seedream-v4.5` | Atlas Cloud 异步协议（提交 → 轮询 prediction）；Key 在 [Atlas Cloud 控制台](https://www.atlascloud.ai/console/api-keys) 创建 |
| 生成图片（ComfyUI 渠道） | 本地 checkpoint | 连本机 `http://127.0.0.1:8188`，设置页测试连通后可直接选模型 |
| 生成视频（FlowAgent） | 服务默认模型 | 连本机 `http://127.0.0.1:8000` 的 FlowAgent（Google Flow 桥接），无需 API Key |

模型都可以在设置页修改。API Key 只保存在浏览器本地（`chrome.storage.sync`），请求直接发往对应官方 API（或你自己填的中转地址），不经过其他第三方服务器。

## 项目结构

```
manifest.json          MV3 清单
background.js          服务工作线程：任务调度、五渠道分发、断点恢复
lib/
  gemini.js            Gemini API 封装（反推 + 生图 + 分镜策划 + Key 测试）
  openai.js            GPT-Image 渠道封装（generations / edits + APIMart 异步协议）
  atlas.js             Seedream 渠道封装（Atlas Cloud 提交/轮询 + 尺寸预设）
  comfy.js             本地 ComfyUI 渠道封装（txt2img 工作流 + history 轮询）
  flowagent.js         FlowAgent 视频封装（提交/轮询/health 检查）
  presets.js           组图内容预设库（风格锚 + 分镜节奏 + 平台规则）
  settings.js          设置读写与默认值
  util.js              图片抓取、缩略图、base64 工具
content/               网页内容脚本（悬浮球 + toast）
sidepanel/             侧边栏：快速反推、生图、历史
canvas/                画布工作台：多模型对比生图 + FlowAgent 视频
popup/                 插件弹窗：上传/粘贴图片入口
options/               设置页（五渠道配置与连通测试）
viewer/                大图查看页
scripts/gen_icons.py   图标生成脚本（纯 Python 标准库）
```

## 注意

- 生图使用你自己的 Gemini API 配额，按 Google 的价格计费（免费额度内免费）
- 少数网站的图片有防盗链，直接抓取会失败；可以把图片另存后从弹窗上传
