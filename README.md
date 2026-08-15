# Prompt Lens

自用 Chrome 插件：反推网页图片的提示词，并用 Gemini 直接生成新图。灵感来自 [Viko](https://viko.fun)。

## 功能

- **悬浮球反推**：鼠标悬停在网页图片上出现悬浮球，点击即可反推提示词，结果显示在浏览器侧边栏
- **弹窗入口**：点击插件图标，粘贴 / 拖入 / 上传本地图片进行反推
- **多维度画面解构**：图像类型 + 主体 / 姿势 / 环境 / 构图 / 光线 / 色彩 / 风格 / 细节 / 氛围逐项分析，附词卡与主色色卡，点击即复制
- **中英双语提示词**：英文提示词可直接编辑后送去生图，附中文对照
- **双生图渠道**：Gemini（Nano Banana 2）与 GPT-Image（gpt-image-2），逐次生成时可切换；GPT-Image 默认走 APIMart（异步任务自动轮询取图），也兼容 OpenAI 官方同步接口和其他中转站
- **侧边栏生图**：选择画幅（1:1 到 21:9）与分辨率（512 / 1K / 2K / 4K，自动映射为各渠道支持的尺寸）
- **姿势复刻**：生成时把原图作为姿态与构图约束送入模型，锁定人物姿势、裁切与画面占比（也可切换为风格参考 / 纯提示词）
- **角色卡替换**：从反推图或上传图保存角色卡（自动识别外貌特征），生成时选择角色卡即可把画面人物替换为该角色
- **历史记录**：本地保留最近 50 个任务，可随时回看、重新生成、下载

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

模型都可以在设置页修改。API Key 只保存在浏览器本地（`chrome.storage.sync`），请求直接发往对应官方 API（或你自己填的中转地址），不经过其他第三方服务器。

## 项目结构

```
manifest.json          MV3 清单
background.js          服务工作线程：任务调度、调用 Gemini API
lib/
  gemini.js            Gemini API 封装（反推 + 生图 + Key 测试）
  openai.js            GPT-Image 渠道封装（generations / edits + 尺寸映射）
  settings.js          设置读写与默认值
  util.js              图片抓取、缩略图、base64 工具
content/               网页内容脚本（悬浮球 + toast）
sidepanel/             侧边栏：结果展示、生图、历史
popup/                 插件弹窗：上传/粘贴图片入口
options/               设置页
scripts/gen_icons.py   图标生成脚本（纯 Python 标准库）
```

## 注意

- 生图使用你自己的 Gemini API 配额，按 Google 的价格计费（免费额度内免费）
- 少数网站的图片有防盗链，直接抓取会失败；可以把图片另存后从弹窗上传
