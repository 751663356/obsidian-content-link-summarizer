# 内容链接总结

这是一个本地 Obsidian 插件，用来把小红书和 B 站链接整理成 Markdown 笔记。

它可以提取网页正文、下载并转写视频/音频、识别图片文字，然后调用大模型生成结构化总结，最后按大类放进 Obsidian。

## 使用

1. 把插件文件夹放到 Obsidian 仓库的 `.obsidian/plugins/xiaohongshu-summarizer`。
2. 在 Obsidian 设置里启用第三方插件 `内容链接总结`。
3. 打开命令面板，运行 `内容链接总结：导入链接并总结`。
4. 粘贴小红书/B 站网页链接，或 App 分享出来的整段文案。

也可以使用：

- `内容链接总结：从剪贴板导入链接并总结`
- `内容链接总结：批量导入链接并排队总结`
- `内容链接总结：继续处理批量导入队列`

生成的笔记默认放在：

- 小红书：`笔记/小红书/分类名`
- B 站：`笔记/B站/分类名`

下载到的视频或音频会在转写后归档到：

- 小红书：`附件/小红书`
- B 站：`附件/B站`

生成的笔记里会自动加入媒体文件链接。

## 自动分类

默认只使用少量大类，避免文件夹无限变碎：

- 技术与工具
- 面试与求职
- 职场与沟通
- 学习与认知
- 生活与健康
- 财务与商业
- 情感与关系
- 娱乐与灵感
- 未分类

你也可以在插件设置里自定义分类候选。AI 只会从候选里选择，不会自由创建新分类。

## 视频转写、图片识别和 AI 总结

- 插件默认使用本地 `whisper-cpp` 转写视频，准确优先模型是 `models/ggml-large-v3.bin`。
- 若设置里填写兼容 `chat/completions` 的总结接口，插件会把网页正文、图片文字、视频转写稿交给你配置的模型生成结构化总结。
- 纯图片笔记可以使用你配置的图文理解接口识别图片文字；失败时回退到本地 RapidOCR/Tesseract。
- B 站视频会优先使用视频自带字幕/自动字幕；没有字幕时才下载音频并用本地 Whisper 转写。
- 若没有填完整总结 API Key、API 地址和模型名，插件仍会保存网页能提取到的内容和本地转写稿，并生成基础摘要。
- 若视频下载失败，通常是登录态、平台限制或链接不是单条笔记导致的。建议先在浏览器中登录小红书，再导入单条笔记详情链接。

## 批量队列

批量导入时，插件会把链接加入本地队列，逐条处理。

队列状态会写入：

```text
收集箱/内容链接批量导入队列.md
```

失败的链接会记录错误原因，不会阻塞后续链接。你可以重新运行 `继续处理批量导入队列` 接着处理。

## 本地依赖

插件目录内需要一个用于下载媒体的本地 Python 环境：

```bash
cd ".obsidian/plugins/xiaohongshu-summarizer"
/usr/bin/python3 -m venv .venv
.venv/bin/python -m pip install -U pip yt-dlp rapidocr_onnxruntime pillow
```

本地视频转写需要：

```bash
brew install ffmpeg whisper-cpp
mkdir -p ".obsidian/plugins/xiaohongshu-summarizer/models"
```

准确优先建议使用 `large-v3`。可以直接在插件设置里点击 `下载 large-v3`，模型会保存到：

```text
models/ggml-large-v3.bin
```

也可以手动下载：

```bash
curl -L -o ".obsidian/plugins/xiaohongshu-summarizer/models/ggml-large-v3.bin" \
  "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true"
```

## 隐私

插件不会保存小红书账号密码。需要登录态时，请用浏览器手动登录，小红书的 Cookie 由本机浏览器管理。

本仓库不会提交 `data.json`、`.venv/` 和 `models/`：

- `data.json` 可能包含 API Key 和本地队列。
- `.venv/` 是本地 Python 环境。
- `models/` 里是本地 Whisper 模型文件，体积很大。
