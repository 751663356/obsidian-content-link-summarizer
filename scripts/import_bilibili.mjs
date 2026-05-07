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
const IS_WINDOWS = process.platform === "win32";
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
  try {

  const subtitle = await extractBestSubtitle(info).catch((error) => {
    warnings.push(`字幕提取失败：${error.message}`);
    return null;
  });
  if (subtitle?.text?.trim()) {
    transcript = subtitle.text;
    transcriptSource = subtitle.source;
  } else {
    warnings.push("未找到可用字幕，正在改用本地 Whisper 转录音频。");
    mediaPath = await downloadAudio(extracted.webpageUrl || options.url, options);
    transcript = await transcribeWithLocalWhisper(mediaPath, options);
    transcriptSource = "本地 Whisper 转录";
  }

  const sourceText = [
    `标题：${extracted.title}`,
    extracted.uploader ? `UP 主：${extracted.uploader}` : "",
    extracted.description ? `简介：${extracted.description}` : "",
    transcript ? `字幕/转录来源：${transcriptSource}\n${transcript}` : ""
  ].filter(Boolean).join("\n\n");

  const summary = hasSummaryChatConfig(options) && sourceText.trim()
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
    mediaPath
  });

  return {
    notePath,
    title: extracted.title || "B站视频"
  };
  } finally {
    await cleanupTempMedia(mediaPath);
  }
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
    cid: info.cid || "",
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
    throw new Error("当前关闭了音视频转录，且该视频没有可用字幕。请在插件设置里开启音视频转录。");
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
    throw new Error("没有找到可转录的音频文件。");
  }
  return path.join(tempDir, media);
}

async function transcribeWithLocalWhisper(mediaPath, options) {
  const modelPath = await resolveUsableWhisperModel(options.localWhisperModelPath || "models/ggml-small.bin");
  const wavPath = path.join(path.dirname(mediaPath), "audio.wav");
  const outputBase = path.join(path.dirname(mediaPath), "transcript");
  const ffmpegPath = await findExecutable(getFfmpegCandidates(), ["-version"], "缺少 ffmpeg，无法提取音频。");
  const whisper = await findWhisperCommand();
  try {
    await execFileAsync(ffmpegPath, [
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

    const transcriptPath = await runWhisperCli(whisper, modelPath, wavPath, outputBase, 1000 * 60 * 60);
    return cleanText(await fs.readFile(transcriptPath, "utf8"));
  } finally {
    await cleanupTempPath(wavPath);
    await cleanupTempPath(`${outputBase}.txt`);
    await cleanupTempPath(`${wavPath}.txt`);
  }
}

async function summarizeWithChatApi(sourceText, extracted, options) {
  const baseUrl = String(options.summaryApiBaseUrl).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.summaryApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: options.summaryModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "你是一个严谨的中文视频学习笔记整理助手。把 B 站视频整理成适合 Obsidian 长期复习的 Markdown。先判断视频类型，再选择最适合的笔记模板。不要编造字幕里没有的信息，不要输出逐字稿或大段原字幕。"
        },
        {
          role: "user",
          content: [
            `标题：${extracted.title || ""}`,
            `链接：${extracted.webpageUrl || extracted.url}`,
            extracted.uploader ? `UP 主：${extracted.uploader}` : "",
            extracted.duration ? `时长：${formatDuration(extracted.duration)}` : "",
            getAdaptiveSummaryPrompt(),
            "",
            "写作要求：",
            "- 时间轴重点只保留关键段落，不要逐句列字幕。",
            "- 核心要点要合并同类项，写成可复习的知识点。",
            "- 可执行清单必须是具体行动；没有就写“暂无明确行动”。",
            "- 教程类视频必须写出可执行步骤；步骤缺失时说明“视频未提供完整步骤”。",
            "- 如果预设类型都不合适，可以自己生成一个更合适的 Markdown 模板，但必须保持精炼。",
            "- 不要输出原始字幕或逐字稿。",
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

function getAdaptiveSummaryPrompt() {
  return [
    "请先判断视频类型，再按类型选择模板输出。",
    "",
    "必须先输出：",
    "## 内容类型",
    "用一句话说明你判断出的视频类型，例如：教程/操作演示、观点/认知、产品评测、课程/讲座、资讯解读、案例复盘、访谈/播客、灵感素材、其他。",
    "",
    "通用必备栏目：",
    "## 一句话总结",
    "## 时间轴重点",
    "## 核心要点",
    "## 可执行清单",
    "## 值得回看",
    "",
    "按视频类型追加对应栏目：",
    "- 教程/操作演示：追加 `## 适用场景`、`## 前置准备`、`## 具体步骤`、`## 注意事项`。",
    "- 课程/讲座：追加 `## 知识框架`、`## 关键概念`、`## 练习/复盘问题`。",
    "- 产品评测：追加 `## 适合谁`、`## 优点`、`## 缺点/风险`、`## 选择建议`。",
    "- 观点/认知：追加 `## 核心观点`、`## 支撑理由`、`## 对我的启发`、`## 可验证问题`。",
    "- 资讯解读：追加 `## 发生了什么`、`## 为什么重要`、`## 可能影响`。",
    "- 案例复盘：追加 `## 背景`、`## 关键动作`、`## 结果`、`## 可借鉴经验`。",
    "- 访谈/播客：追加 `## 嘉宾观点`、`## 关键故事`、`## 延伸思考`。",
    "- 灵感素材：追加 `## 可收藏信息`、`## 可能用途`、`## 后续整理建议`。",
    "- 其他：根据内容自己生成 2-4 个合适栏目。"
  ].join("\n");
}

async function classifyCategory(sourceText, extracted, options) {
  const categories = normalizeCategories(options.noteCategories);
  const requested = String(options.category || "").trim();
  if (requested && requested !== "__auto__" && categories.includes(requested)) {
    return requested;
  }
  if (!hasSummaryChatConfig(options) || !sourceText.trim()) {
    return guessCategory(sourceText, categories);
  }

  const baseUrl = String(options.summaryApiBaseUrl).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.summaryApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: options.summaryModel,
      temperature: 0,
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

async function writeNote({ vaultPath, outputFolder, category, extracted, summary, transcript, transcriptSource, mediaPath }) {
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

  const sourceHints = [
    extracted.description ? "- 已读取视频简介。" : "",
    transcriptSource ? `- 已读取${transcriptSource}，完整字幕/转录见下方折叠区。` : ""
  ].filter(Boolean);
  const descriptionExcerpt = excerptText(extracted.description, 500);
  const playerHtml = formatBilibiliPlayer(extracted);

  const body = [
    frontmatter,
    "",
    `# ${escapeMarkdownHeading(extracted.title || "B站视频")}`,
    "",
    `原链接：${extracted.webpageUrl || extracted.url}`,
    extracted.uploader ? `UP 主：${extracted.uploader}` : "",
    extracted.duration ? `时长：${formatDuration(extracted.duration)}` : "",
    transcriptSource ? `字幕/转录来源：${transcriptSource}` : "",
    "",
    playerHtml,
    playerHtml ? "" : "",
    summary || "暂无可用摘要。",
    "",
    "## 内容来源",
    "",
    sourceHints.length ? sourceHints.join("\n") : "- 未能提取到足够原始信息。",
    "",
    descriptionExcerpt ? ["## 简介片段", "", descriptionExcerpt, ""].join("\n") : "",
    transcript ? formatTranscriptSection("完整字幕/转录", transcript, transcriptSource) : "",
    mediaPath ? "<!-- 临时音频已在转录后删除。 -->\n" : ""
  ].filter(Boolean).join("\n");

  await fs.writeFile(absPath, body, "utf8");
  return relativePath;
}

function formatBilibiliPlayer(extracted) {
  const embedUrl = buildBilibiliEmbedUrl(extracted);
  if (!embedUrl) {
    return "";
  }
  return [
    "## 播放器",
    "",
    `<iframe src="${escapeHtmlAttr(embedUrl)}" width="100%" height="420" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`
  ].join("\n");
}

function buildBilibiliEmbedUrl(extracted) {
  const webpageUrl = extracted.webpageUrl || extracted.url || "";
  const bvid = extractBvid(extracted.bvid) || extractBvid(webpageUrl);
  const aid = extractAid(extracted.bvid) || extractAid(webpageUrl);
  const params = new URLSearchParams();
  if (bvid) {
    params.set("bvid", bvid);
  } else if (aid) {
    params.set("aid", aid);
  } else {
    return "";
  }
  if (extracted.cid) {
    params.set("cid", String(extracted.cid));
  }
  params.set("page", "1");
  params.set("high_quality", "1");
  params.set("danmaku", "0");
  params.set("autoplay", "0");
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

function extractBvid(value) {
  const match = String(value || "").match(/BV[0-9A-Za-z]+/);
  return match ? match[0] : "";
}

function extractAid(value) {
  const match = String(value || "").match(/(?:^|\/|av)(\d{6,})/i);
  return match ? match[1] : "";
}

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function findPythonWithYtDlp() {
  const candidates = [
    getVenvPythonPath(),
    "/usr/bin/python3",
    "python3",
    "python",
    "py"
  ];
  for (const candidate of candidates) {
    if (looksLikeAbsolutePath(candidate) && !existsSync(candidate)) {
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
    if (!/ggml-small\.bin$/i.test(modelPath) || stat.size > 450_000_000) {
      return modelPath;
    }
    warnings.push("small 模型还没下载完整，暂时回退到 base 模型转录。");
  }

  const fallbackPath = resolvePluginPath("models/ggml-base.bin");
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }
  throw new Error(`本地 Whisper 模型不存在或未下载完整：${modelPath}`);
}

async function findExecutable(candidates, testArgs, missingMessage) {
  for (const candidate of candidates) {
    if (looksLikeAbsolutePath(candidate) && !existsSync(candidate)) {
      continue;
    }
    try {
      await execFileAsync(candidate, testArgs, { timeout: 10000 });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(missingMessage);
}

async function findWhisperCommand() {
  for (const candidate of getWhisperCandidates()) {
    if (looksLikeAbsolutePath(candidate) && !existsSync(candidate)) {
      continue;
    }
    try {
      await execFileAsync(candidate, ["--help"], { timeout: 10000 });
      return {
        path: candidate,
        kind: /whisper-cpp(?:\.exe)?$/i.test(candidate) ? "python" : "native"
      };
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("缺少本地 Whisper 转录工具。请先在插件设置页安装依赖。");
}

async function runWhisperCli(whisper, modelPath, wavPath, outputBase, timeout) {
  await execFileAsync(whisper.path, [
    "-m", modelPath,
    "-f", wavPath,
    "-l", "auto",
    "-otxt",
    "-of", outputBase,
    "-nt",
    "-np"
  ], {
    timeout,
    maxBuffer: 1024 * 1024 * 30
  });
  return findNewestTranscript(path.dirname(wavPath), [`${outputBase}.txt`, `${wavPath}.txt`]);
}

async function findNewestTranscript(dir, preferredPaths) {
  for (const candidate of preferredPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const files = await fs.readdir(dir);
  const txtFiles = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".txt")) {
      continue;
    }
    const fullPath = path.join(dir, file);
    const stat = await fs.stat(fullPath);
    txtFiles.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  txtFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (txtFiles[0]) {
    return txtFiles[0].fullPath;
  }
  throw new Error("本地 Whisper 已运行，但没有找到转录文本。");
}

function getVenvPythonPath() {
  return IS_WINDOWS
    ? path.join(pluginDir, ".venv", "Scripts", "python.exe")
    : path.join(pluginDir, ".venv", "bin", "python");
}

function getFfmpegCandidates() {
  return IS_WINDOWS
    ? ["ffmpeg.exe", "ffmpeg"]
    : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];
}

function getWhisperCandidates() {
  return IS_WINDOWS
    ? [
      path.join(pluginDir, ".venv", "Scripts", "whisper-cpp.exe"),
      path.join(pluginDir, ".venv", "Scripts", "whisper-cli.exe"),
      "whisper-cpp.exe",
      "whisper-cli.exe",
      "whisper-cpp",
      "whisper-cli"
    ]
    : [
      path.join(pluginDir, ".venv", "bin", "whisper-cpp"),
      path.join(pluginDir, ".venv", "bin", "whisper-cli"),
      "/opt/homebrew/bin/whisper-cli",
      "/usr/local/bin/whisper-cli",
      "whisper-cli",
      "whisper-cpp"
    ];
}

function looksLikeAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(String(value || ""));
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

function excerptText(text, maxLength = 500) {
  const clean = cleanText(text);
  if (!clean) {
    return "";
  }
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function formatTranscriptSection(title, transcript, source = "") {
  const clean = cleanText(transcript);
  if (!clean) {
    return "";
  }
  return [
    `## ${title}`,
    "",
    source ? `来源：${source}` : "",
    source ? "" : "",
    "<details>",
    `<summary>展开${title}</summary>`,
    "",
    fencedText(clean),
    "",
    "</details>",
    ""
  ].filter((item) => item !== "").join("\n");
}

function fencedText(text) {
  const value = String(text || "");
  const longestFence = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return [fence + "text", value, fence].join("\n");
}

async function cleanupTempMedia(mediaPath) {
  if (!mediaPath) {
    return;
  }
  const tempRoot = path.resolve(os.tmpdir());
  const mediaDir = path.resolve(path.dirname(mediaPath));
  if (!mediaDir.startsWith(tempRoot)) {
    return;
  }
  await cleanupTempPath(mediaDir);
}

async function cleanupTempPath(targetPath) {
  if (!targetPath) {
    return;
  }
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

function normalizeModelOptions(options) {
  options.summaryApiKey = options.summaryApiKey || process.env.SUMMARY_API_KEY || options.openaiApiKey || process.env.OPENAI_API_KEY || "";
  options.summaryApiBaseUrl = options.summaryApiBaseUrl || process.env.SUMMARY_API_BASE_URL || process.env.OPENAI_BASE_URL || "";
  options.summaryModel = options.summaryModel || process.env.SUMMARY_MODEL || "";
  options.noteCategories = normalizeCategories(options.noteCategories);
}

function hasSummaryChatConfig(options) {
  return Boolean(options.summaryApiKey && options.summaryApiBaseUrl && options.summaryModel);
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
