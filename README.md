# 内容链接总结

这是一个本地 Obsidian 插件，用来把你主动分享的小红书和 B 站链接转录、识别，并整理成可复习的 Markdown 笔记。

它的定位不是爬虫，也不是收藏夹抓取器，而是个人转录和知识整理助手：你粘贴一条自己要整理的链接，插件优先处理字幕、音频转录和图片文字识别，再生成摘要、要点、行动清单，并自动放进 Obsidian 分类文件夹。

## 小白安装

macOS 用户可以用安装脚本把插件放进 Obsidian 仓库：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/751663356/obsidian-content-link-summarizer/main/install.sh)"
```

Windows 用户用 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/751663356/obsidian-content-link-summarizer/main/install.ps1 | iex"
```

安装脚本只负责安装插件本体。启用插件后，再到插件设置页点击：

1. `一键安装`：准备本地依赖。
2. `下载 small`：下载本地 Whisper 转录模型。
3. 在 Chrome 登录小红书或 B 站。
4. `检查登录态`：确认插件可以临时读取本机浏览器登录态。

也可以手动把插件文件夹放到 Obsidian 仓库的 `.obsidian/plugins/xiaohongshu-summarizer`。

## 日常使用

1. 在 Chrome 登录小红书或 B 站。
2. 在 Obsidian 命令面板运行 `内容链接总结：转录链接并整理`。
3. 粘贴小红书/B 站链接，网页链接和 App 分享链接都可以。
4. 等插件完成转录、识别和结构化整理。

也可以运行 `内容链接总结：从剪贴板转录链接并整理`。

生成的笔记默认放在：

- 小红书：`笔记/小红书/分类名`
- B 站：`笔记/B站/分类名`

小红书视频会用于转录，转录后可归档到：

- 小红书：`附件/小红书`

B 站优先使用字幕；没有字幕时会临时提取音频做转录，转录完成后会自动删除临时音频，不会归档音频文件。

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

## 视频转录、图片识别和 AI 总结

- 插件默认使用本地 Whisper 转录视频，默认模型是 `models/ggml-small.bin`。
- 若设置里填写兼容 `chat/completions` 的总结接口，插件会把网页正文、图片文字、视频转录结果交给你配置的模型生成结构化总结。
- 纯图片笔记可以使用你配置的图文理解接口识别图片文字；失败时回退到本地 RapidOCR/Tesseract。
- B 站视频会优先使用视频自带字幕/自动字幕；没有字幕时才临时提取音频并用本地 Whisper 转录。
- 笔记默认只保存摘要和少量来源线索，不保存整段逐字稿或原始字幕。
- 若没有填完整总结 API Key、API 地址和模型名，插件仍会保存网页能提取到的内容，并生成基础摘要。
- 若视频转录失败，通常是登录态、平台限制或链接不是单条笔记导致的。建议先在浏览器中登录小红书，再导入单条笔记详情链接。

## 登录态增强

插件主打的顺手体验是 `临时读取 Chrome 登录态`：你在 Chrome 正常登录小红书或 B 站，插件在导入链接时临时读取本机浏览器 Cookie，用于访问你已经能看的内容。

插件不会要求你粘贴 Cookie，也不会把 Cookie 写进插件配置。设置页里的 `检查登录态` 只检查本机工具能不能读取 Chrome 登录态。不开启登录态时，公开链接仍可能可用，但内容完整度和稳定性会差一些。

## 本地依赖

插件现在可以直接在设置页里帮你安装大部分依赖：

- `一键安装`：会安装当前系统需要的基础依赖和插件目录自己的 Python 依赖。
- `安装 Python 依赖`：会创建 `.venv`，并按 `requirements.txt` 安装 `yt-dlp`、`rapidocr_onnxruntime`、`pillow`、`whisper.cpp-cli`。
- `安装系统依赖`：macOS 通过 Homebrew 安装 Node.js、`ffmpeg`、`whisper-cpp`、`tesseract`；Windows 通过 winget 安装 Node.js、Python、`ffmpeg`、Tesseract。
- `下载 small`：会下载本地 Whisper 模型。

设置页点击 `下载 small` 后，模型会保存到：

```text
models/ggml-small.bin
```

如果你更习惯手动装，仍然可以这样做：

macOS：

```bash
cd ".obsidian/plugins/xiaohongshu-summarizer"
/usr/bin/python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -U -r requirements.txt
brew install node ffmpeg whisper-cpp tesseract
curl -L -o ".obsidian/plugins/xiaohongshu-summarizer/models/ggml-small.bin" \
  "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true"
```

Windows：

```powershell
cd ".obsidian\plugins\xiaohongshu-summarizer"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -U -r requirements.txt
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Gyan.FFmpeg --exact
winget install --id UB-Mannheim.TesseractOCR --exact
```

## 免责声明

本插件主打单条链接的转录和个人知识整理，仅用于个人学习、研究和复盘。请只导入你有权访问和整理的内容，不要用于批量抓取、转载、搬运、传播原始视频、音频、图片、字幕或任何侵犯他人权益的用途。

使用本插件时，请自行遵守小红书、B 站等平台规则和相关法律法规。插件生成的摘要不代表原作者授权，也不改变原内容的版权归属。

## 隐私

插件不会保存小红书账号密码，也不会保存 Cookie 内容。需要登录态时，请用浏览器手动登录，小红书和 B 站的 Cookie 由本机浏览器管理。

本仓库不会提交 `data.json`、`.venv/` 和 `models/`：

- `data.json` 可能包含 API Key 和本地设置。
- `.venv/` 是本地 Python 环境。
- `requirements.txt` 会提交到仓库，用来让插件自动安装 Python 依赖。
- `models/` 里是本地 Whisper 模型文件，体积很大。
