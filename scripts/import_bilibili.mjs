import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const input = JSON.parse(await readStdin());
const warnings = [];
const execFileAsync = promisify(execFile);
const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_NOTE_CATEGORIES = [
  "技术与工具",
  "面试与求职",
  "职场与沟通",
  "学习与认知",
  "生活与健康",
  "财务与商业",
  "情感与关系",
  "娱乐与灵感",
  "未分类"
];

try {
  const result = await importUrl(input);
  process.stdout.write(JSON.stringify({ ok: true, warnings, ...result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    warnings
  }));
  process.exitCode = 0;
}

async function importUrl(options) {
  normalizeModelOptions(options);

  const info = await getVideoInfo(options.url, options);
  const extracted = normalizeVideoInfo(info, options.url);
  let transcript = "";
  let transcriptSource = "";
  let mediaPath = "";
  let archivedMediaPath = "";

  const subtitle = await extractBestSubtitle(info).catch((error) => {
    warnings.push(`字幕提取失败：${error.message}`);
    return null;
  });
  if (subtitle?.text?.trim()) {
    transcript = subtitle.text;
    transcriptSource = subtitle.source;
  } else {
    warnings.push("未找到可用字幕，正在改用本地 Whisper 转写音频。");
    mediaPath = await downloadAudio(extracted.webpageUrl || options.url, options);
    transcript = await transcribeWithLocalWhisper(mediaPath, options);
    transcriptSource = "本地 Whisper 转写";
    archivedMediaPath = await archiveMedia(mediaPath, options, extracted).catch((error) => {
      warnings.push(`媒体归档失败：${error.message}`);
      return "";
    });
  }

  const sourceText = [
    `标题：${extracted.title}`,
    extracted.uploader ? `UP 主：${extracted.uploader}` : "",
    extracted.description ? `简介：${extracted.description}` : "",
    transcript ? `字幕/转写来源：${transcriptSource}\n${transcript}` : ""
  ].filter(Boolean).join("\n\n");

  const summary = options.summaryApiKey && sourceText.trim()
    ? await summarizeWithChatApi(sourceText, extracted, options).catch((error) => {
      warnings.push(`AI 总结失败：${error.message}`);
      return fallbackSummary(sourceText);
    })
    : fallbackSummary(sourceText);
  const category = await classifyCategory(sourceText, extracted, options);

  const notePath = await writeNote({
    vaultPath: options.vaultPath,
    outputFolder: options.outputFolder || "笔记/B站",
    category,
    extracted,
    summary,
    transcript,
    transcriptSource,
    archivedMediaPath,
    mediaPath
  });

  return {
    notePath,
    title: extracted.title || "B站视频"
  };
}

async function getVideoInfo(url, options) {
  const python = await findPythonWithYtDlp();
  const args = [
    "-m", "yt_dlp",
    "--dump-single-json",
    "--no-warnings",
    "--skip-download"
  ];
  if (options.tryBrowserCookies) {
    args.push("--cookies-from-browser", "chrome");
  }
  args.push(url);

  const { stdout } = await execFileAsync(python, args, {
    cwd: pluginDir,
    timeout: 1000 * 60 * 3,
    maxBuffer: 1024 * 1024 * 80
  });
  return JSON.parse(stdout);
}

function normalizeVideoInfo(info, fallbackUrl) {
  return {
    url: fallbackUrl,
    webpageUrl: info.webpage_url || info.original_url || fallbackUrl,
    title: cleanText(info.title || "B站视频"),
    uploader: cleanText(info.uploader || info.channel || info.creator || ""),
    uploadDate: formatYtdlpDate(info.upload_date || ""),
    duration: Number(info.duration || 0),
    description: cleanText(info.description || ""),
    bvid: info.id || info.display_id || "",
    viewCount: info.view_count || "",
    likeCount: info.like_count || "",
    commentCount: info.comment_count || ""
  };
}

async function extractBestSubtitle(info) {
  const candidates = collectSubtitleCandidates(info);
  for (const candidate of candidates) {
    const raw = await fetchSubtitle(candidate.url).catch(() => "");
    const text = parseSubtitleText(raw, candidate.ext);
    if (text.trim().length >= 20) {
      return {
        text,
        source: candidate.auto ? `B站自动字幕（${candidate.lang}）` : `B站字幕（${candidate.lang}）`
      };
    }
  }
  return null;
}

function collectSubtitleCandidates(info) {
  const out = [];
  appendSubtitleCollection(out, info.subtitles, false);
  appendSubtitleCollection(out, info.automatic_captions, true);
  return out.sort((a, b) => subtitleScore(b) - subtitleScore(a));
}

function appendSubtitleCollection(out, collection, auto) {
  if (!collection || typeof collection !== "object") {
    return;
  }
  for (const [lang, tracks] of Object.entries(collection)) {
    for (const track of Array.isArray(tracks) ? tracks : []) {
      if (!track?.url) {
        continue;
      }
      out.push({
        lang,
        url: normalizeSubtitleUrl(track.url),
        ext: String(track.ext || "").toLowerCase(),
        auto
      });
    }
  }
}

function subtitleScore(candidate) {
  const lang = candidate.lang.toLowerCase();
  const ext = candidate.ext.toLowerCase();
  let score = 0;
  if (!candidate.auto) score += 100;
  if (/zh|chi|cn|hans|chs/.test(lang)) score += 80;
  if (/hans|zh-cn|zh_cn|chs/.test(lang)) score += 20;
  if (["json3", "json"].includes(ext)) score += 12;
  if (["vtt", "srt"].includes(ext)) score += 8;
  if (/en/.test(lang)) score += 5;
  return score;
}

async function fetchSubtitle(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "*/*",
      "referer": "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function parseSubtitleText(raw, ext = "") {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  if (ext.includes("json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const lines = [];
      if (Array.isArray(parsed.body)) {
        for (const item of parsed.body) {
          const content = cleanText(item.content || item.text || "");
          if (content) {
            lines.push(`${formatSeconds(item.from)} ${content}`);
          }
        }
        return dedupeLines(lines).join("\n");
      }
      if (Array.isArray(parsed.events)) {
        for (const event of parsed.events) {
          const content = cleanText((event.segs || []).map((seg) => seg.utf8 || "").join(""));
          if (content) {
            lines.push(`${formatSeconds((event.tStartMs || 0) / 1000)} ${content}`);
          }
        }
        return dedupeLines(lines).join("\n");
      }
    } catch {
      // Fall back to line-based subtitle cleanup below.
    }
  }

  return cleanSubtitleLines(text);
}

function cleanSubtitleLines(text) {
  const lines = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = cleanText(rawLine.replace(/<[^>]+>/g, ""));
    if (!line || line === "WEBVTT" || line === "Kind: captions" || line === "Language: zh") {
      continue;
    }
    if (/^\d+$/.test(line) || /-->|^\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(line)) {
      continue;
    }
    lines.push(line);
  }
  return dedupeLines(lines).join("\n");
}

async function downloadAudio(url, options) {
  if (!options.downloadVideo) {
    throw new Error("当前关闭了下载视频/音频，且该视频没有可用字幕。请在插件设置里开启下载并转写。");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bilibili-audio-"));
  const output = path.join(tempDir, "media.%(ext)s");
  const python = await findPythonWithYtDlp();
  const args = [
    "-m", "yt_dlp",
    "--no-check-certificates",
    "--no-warnings",
    "--restrict-filenames",
    "-f", "bestaudio/best",
    "-o", output
  ];
  if (options.tryBrowserCookies) {
    args.push("--cookies-from-browser", "chrome");
  }
  args.push(url);

  await execFileAsync(python, args, {
    cwd: pluginDir,
    timeout: 1000 * 60 * 10,
    maxBuffer: 1024 * 1024 * 30
  });
  const files = await fs.readdir(tempDir);
  const media = files.find((file) => /\.(mp3|m4a|mp4|webm|wav|mpeg|mpga|aac)$/i.test(file));
  if (!media) {
    throw new Error("没有找到可转写的音频文件。");
  }
  return path.join(tempDir, media);
}

async function transcribeWithLocalWhisper(mediaPath, options) {
  const modelPath = await resolveUsableWhisperModel(options.localWhisperModelPath || "models/ggml-large-v3.bin");
  const wavPath = path.join(path.dirname(mediaPath), "audio.wav");
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-y",
    "-i", mediaPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    wavPath
  ], {
    timeout: 1000 * 60 * 10,
    maxBuffer: 1024 * 1024 * 30
  });

  const outputBase = path.join(path.dirname(mediaPath), "transcript");
  await execFileAsync("/opt/homebrew/bin/whisper-cli", [
    "-m", modelPath,
    "-f", wavPath,
    "-l", "auto",
    "-otxt",
    "-of", outputBase,
    "-nt",
    "-np"
  ], {
    timeout: 1000 * 60 * 60,
    maxBuffer: 1024 * 1024 * 30
  });
  return cleanText(await fs.readFile(`${outputBase}.txt`, "utf8"));
}

async function summarizeWithChatApi(sourceText, extracted, options) {
  const baseUrl = String(options.summaryApiBaseUrl || "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.summaryApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: options.summaryModel || "glm-5.1",
      temperature: 0.2,
      ...(baseUrl.includes("api.z.ai") ? { thinking: { type: "disabled" } } : {}),
      messages: [
        {
          role: "system",
          content: "你是一个严谨的中文视频学习笔记整理助手。把 B 站视频整理成适合 Obsidian 保存的 Markdown。不要编造字幕里没有的信息。"
        },
        {
          role: "user",
          content: [
            `标题：${extracted.title || ""}`,
            `链接：${extracted.webpageUrl || extracted.url}`,
            extracted.uploader ? `UP 主：${extracted.uploader}` : "",
            extracted.duration ? `时长：${formatDuration(extracted.duration)}` : "",
            "请输出：",
            "## 一句话总结",
            "## 时间轴重点",
            "## 核心要点",
            "## 可执行清单",
            "## 值得回看",
            "",
            "原始内容：",
            sourceText.slice(0, 60000)
          ].filter(Boolean).join("\n")
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }
  return data.choices?.[0]?.message?.content?.trim() || fallbackSummary(sourceText);
}

async function classifyCategory(sourceText, extracted, options) {
  const categories = normalizeCategories(options.noteCategories);
  const requested = String(options.category || "").trim();
  if (requested && requested !== "__auto__" && categories.includes(requested)) {
    return requested;
  }
  if (!options.summaryApiKey || !sourceText.trim()) {
    return guessCategory(sourceText, categories);
  }

  const baseUrl = String(options.summaryApiBaseUrl || "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.summaryApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: options.summaryModel || "glm-5.1",
      temperature: 0,
      ...(baseUrl.includes("api.z.ai") ? { thinking: { type: "disabled" } } : {}),
      messages: [
        {
          role: "system",
          content: "你负责给视频笔记分类。只能从用户提供的分类中选择一个，直接输出分类名，不要解释，不要新增分类。优先选择宽泛大类，不要按具体标题生成细分类。"
        },
        {
          role: "user",
          content: [
            `可选分类：${categories.join("、")}`,
            `标题：${extracted.title || ""}`,
            extracted.uploader ? `UP 主：${extracted.uploader}` : "",
            "内容：",
            sourceText.slice(0, 8000)
          ].filter(Boolean).join("\n")
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    warnings.push(`AI 分类失败，使用规则兜底：${data.error?.message || `HTTP ${response.status}`}`);
    return guessCategory(sourceText, categories);
  }
  return pickAllowedCategory(data.choices?.[0]?.message?.content || "", categories);
}

async function archiveMedia(mediaPath, options, extracted) {
  const vaultPath = options.vaultPath;
  const attachmentFolder = options.mediaFolder || "附件/B站";
  const folderAbs = path.join(vaultPath, attachmentFolder);
  await fs.mkdir(folderAbs, { recursive: true });

  const ext = path.extname(mediaPath) || ".m4a";
  const date = localDateString();
  const base = sanitizeFilename(extracted.title || "B站音频").slice(0, 60) || "B站音频";
  let relativePath = path.posix.join(attachmentFolder.replace(/\\/g, "/"), `${date} ${base}${ext}`);
  let absPath = path.join(vaultPath, relativePath);
  let index = 2;
  while (existsSync(absPath)) {
    relativePath = path.posix.join(attachmentFolder.replace(/\\/g, "/"), `${date} ${base} ${index}${ext}`);
    absPath = path.join(vaultPath, relativePath);
    index += 1;
  }

  await fs.copyFile(mediaPath, absPath);
  return relativePath;
}

async function writeNote({ vaultPath, outputFolder, category, extracted, summary, transcript, transcriptSource, archivedMediaPath, mediaPath }) {
  const safeCategory = sanitizePathSegment(category || "未分类");
  const noteFolder = safeCategory
    ? path.posix.join(outputFolder.replace(/\\/g, "/"), safeCategory)
    : outputFolder.replace(/\\/g, "/");
  const folderAbs = path.join(vaultPath, noteFolder);
  await fs.mkdir(folderAbs, { recursive: true });

  const base = sanitizeFilename(extracted.title || "B站视频").slice(0, 70) || "B站视频";
  let relativePath = path.posix.join(noteFolder, `${base}.md`);
  let absPath = path.join(vaultPath, relativePath);
  let index = 2;
  while (existsSync(absPath)) {
    relativePath = path.posix.join(noteFolder, `${base} ${index}.md`);
    absPath = path.join(vaultPath, relativePath);
    index += 1;
  }

  const tags = ["B站", "摘要", safeCategory].filter(Boolean);
  const frontmatter = [
    "---",
    `source: ${JSON.stringify(extracted.webpageUrl || extracted.url)}`,
    "platform: B站",
    extracted.uploader ? `up: ${JSON.stringify(extracted.uploader)}` : "",
    extracted.uploadDate ? `published: ${JSON.stringify(extracted.uploadDate)}` : "",
    extracted.duration ? `duration: ${JSON.stringify(formatDuration(extracted.duration))}` : "",
    `created: ${new Date().toISOString()}`,
    `category: ${JSON.stringify(safeCategory)}`,
    `tags: ${JSON.stringify(tags)}`,
    "---"
  ].filter(Boolean).join("\n");

  const body = [
    frontmatter,
    "",
    `# ${escapeMarkdownHeading(extracted.title || "B站视频")}`,
    "",
    `原链接：${extracted.webpageUrl || extracted.url}`,
    extracted.uploader ? `UP 主：${extracted.uploader}` : "",
    extracted.duration ? `时长：${formatDuration(extracted.duration)}` : "",
    transcriptSource ? `字幕/转写来源：${transcriptSource}` : "",
    archivedMediaPath ? `媒体文件：[[${archivedMediaPath}]]` : "",
    "",
    summary || "暂无可用摘要。",
    "",
    extracted.description ? ["## 视频简介", "", extracted.description, ""].join("\n") : "",
    transcript ? ["## 原始字幕/转写", "", transcript, ""].join("\n") : ""
  ].filter(Boolean).join("\n");

  await fs.writeFile(absPath, body, "utf8");
  return relativePath;
}

async function findPythonWithYtDlp() {
  const candidates = [
    path.join(pluginDir, ".venv", "bin", "python"),
    "/usr/bin/python3",
    "python3"
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) {
      continue;
    }
    try {
      await execFileAsync(candidate, ["-m", "yt_dlp", "--version"], { timeout: 10000 });
      return candidate;
    } catch {
      // Try the next Python candidate.
    }
  }
  throw new Error("缺少 yt-dlp。请在插件目录创建 .venv 并安装 yt-dlp。");
}

async function resolveUsableWhisperModel(preferredPath) {
  const modelPath = resolvePluginPath(preferredPath);
  if (existsSync(modelPath)) {
    const stat = await fs.stat(modelPath);
    if (!/large-v3/i.test(modelPath) || stat.size > 2_900_000_000) {
      return modelPath;
    }
    warnings.push("large-v3 模型还没下载完整，暂时回退到 base 模型转写。");
  }

  const fallbackPath = resolvePluginPath("models/ggml-base.bin");
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }
  throw new Error(`本地 Whisper 模型不存在或未下载完整：${modelPath}`);
}

function fallbackSummary(text) {
  const clean = cleanText(text);
  if (!clean) {
    return [
      "## 一句话总结",
      "未能提取到足够内容。",
      "",
      "## 核心要点",
      "- 请确认链接是单个 B 站视频，并且浏览器可正常访问。"
    ].join("\n");
  }
  const sentences = clean.split(/(?<=[。！？!?])\s*/).filter(Boolean).slice(0, 5);
  return [
    "## 一句话总结",
    sentences[0] || clean.slice(0, 120),
    "",
    "## 核心要点",
    ...sentences.slice(0, 5).map((sentence) => `- ${sentence}`)
  ].join("\n");
}

function normalizeModelOptions(options) {
  options.summaryApiKey = options.summaryApiKey || process.env.SUMMARY_API_KEY || process.env.DEEPSEEK_API_KEY || options.openaiApiKey || process.env.OPENAI_API_KEY || "";
  options.summaryApiBaseUrl = options.summaryApiBaseUrl || "https://api.z.ai/api/paas/v4";
  options.summaryModel = options.summaryModel || "glm-5.1";
  options.noteCategories = normalizeCategories(options.noteCategories);
}

function normalizeSubtitleUrl(url) {
  const value = String(url || "");
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return value;
}

function formatYtdlpDate(value) {
  const text = String(value || "");
  if (!/^\d{8}$/.test(text)) {
    return "";
  }
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(value) {
  return formatSeconds(value);
}

function localDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCategories(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,，]/);
  const categories = [...new Set(raw.map((item) => cleanText(item)).filter(Boolean))];
  return categories.length ? categories : DEFAULT_NOTE_CATEGORIES;
}

function pickAllowedCategory(value, categories) {
  const text = cleanText(value).replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  if (!categories.length) {
    return sanitizeCategoryName(text) || guessCategory(text, categories);
  }
  if (categories.includes(text)) {
    return text;
  }
  const matched = categories.find((category) => text.includes(category));
  return matched || guessCategory(text, categories);
}

function guessCategory(text, categories) {
  const content = cleanText(text);
  const rules = [
    ["面试与求职", /(面试|求职|校招|秋招|春招|简历|无领导|结构化|银行|offer|职场面试)/],
    ["技术与工具", /(工具|插件|代码|编程|AI|模型|Obsidian|B站|剪辑|软件|开发|效率|网站|提示词|教程)/],
    ["职场与沟通", /(职场|沟通|表达|汇报|领导|同事|人情世故|话术|关系|社交|会议|管理)/],
    ["学习与认知", /(学习|认知|思维|成长|读书|方法论|复盘|专注|记忆|知识|课程)/],
    ["生活与健康", /(生活|健康|睡眠|饮食|运动|健身|护肤|穿搭|旅行|家居|收纳)/],
    ["财务与商业", /(财务|理财|投资|商业|创业|副业|赚钱|收入|消费|预算|基金|股票)/],
    ["情感与关系", /(情感|恋爱|婚姻|亲密关系|家庭|朋友|伴侣|相处|边界)/],
    ["娱乐与灵感", /(娱乐|搞笑|鬼畜|整活|游戏|音乐|影视|番剧|灵感|审美|摄影|绘画|设计)/]
  ];
  for (const [category, regex] of rules) {
    if ((!categories.length || categories.includes(category)) && regex.test(content)) {
      return category;
    }
  }
  return categories.includes("未分类") ? "未分类" : (categories[0] || "未分类");
}

function sanitizeCategoryName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|#^[\]{}()（）【】《》,，.。:：;；!！?？]/g, " ")
    .replace(/\s+/g, "")
    .slice(0, 8);
}

function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(line);
  }
  return out;
}

function sanitizeFilename(name) {
  return cleanText(name).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizePathSegment(name) {
  return sanitizeFilename(name).replace(/[. ]+$/g, "").slice(0, 40);
}

function resolvePluginPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(pluginDir, value);
}

function escapeMarkdownHeading(text) {
  return String(text || "").replace(/^#+\s*/, "").trim();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
