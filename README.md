# Prompt Lens

自用 Chrome 插件：反推网页图片的提示词，并用 Gemini 直接生成新图。灵感来自 [Viko](https://viko.fun)。

## 功能

- **悬浮球反推**：鼠标悬停在网页图片上出现悬浮球，点击即可反推提示词，结果显示在浏览器侧边栏
- **弹窗入口**：点击插件图标，粘贴 / 拖入 / 上传本地图片进行反推
- **画面解构**：反推结果按「主体 / 风格 / 构图 / 色彩 / 氛围」拆成词卡，附主色色卡，点击即复制
- **中英双语提示词**：英文提示词可直接编辑后送去生图，附中文对照
- **侧边栏生图**：选择画幅（1:1 到 21:9）与分辨率（512 / 1K / 2K / 4K），可勾选「带参考图」延续原图风格
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
| 生成图片 | `gemini-3.1-flash-image` | Nano Banana 2，支持 4K 与多种画幅 |

两个模型都可以在设置页修改。API Key 只保存在浏览器本地（`chrome.storage.sync`），请求直接发往 Google API，不经过任何第三方服务器。

## 项目结构

```
manifest.json          MV3 清单
background.js          服务工作线程：任务调度、调用 Gemini API
lib/
  gemini.js            Gemini API 封装（反推 + 生图 + Key 测试）
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
