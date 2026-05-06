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

  const initialUrl = normalizeXhsUrl(extractXhsUrl(options.url));
  const page = await fetchPage(initialUrl);
  const url = normalizeXhsUrl(page.finalUrl || initialUrl);
  const html = page.html;
  const extracted = extractPage(url, html);
  if (isUnavailablePage(extracted, html)) {
    throw new Error("这条小红书笔记已失效或不可访问。");
  }

  if (new URL(url).pathname.includes("/user/profile")) {
    warnings.push("当前链接是个人页/收藏页；小红书通常需要浏览器登录和动态加载，建议打开具体笔记详情页再导入。");
  } else if (extracted.noteLinks.length && !extracted.body && !extracted.videoUrls.length) {
    warnings.push("当前链接看起来像个人页或收藏页；小红书通常不会在静态 HTML 中暴露完整收藏内容，已生成链接索引。");
  }

  let mediaPath = "";
  let archivedMediaPath = "";
  let transcript = "";
  let ocrText = "";
  let imageOcrText = "";
  if (extracted.images.length) {
    imageOcrText = await ocrImages(extracted.images, options).catch((error) => {
      warnings.push(`图片文字识别失败：${error.message}`);
      return "";
    });
  }
  if (options.downloadVideo) {
    mediaPath = await downloadMedia(url, options).catch((error) => {
      warnings.push(`视频下载失败：${error.message}`);
      return "";
    });

    if (mediaPath) {
      transcript = await transcribeMediaAuto(mediaPath, options).catch((error) => {
        warnings.push(`视频转写失败：${error.message}`);
        return "";
      });
    }
    if (mediaPath) {
      ocrText = await ocrVideoFrames(mediaPath).catch((error) => {
        warnings.push(`画面文字识别失败：${error.message}`);
        return "";
      });
    }
    if (mediaPath) {
      archivedMediaPath = await archiveMedia(mediaPath, options, extracted).catch((error) => {
        warnings.push(`媒体归档失败：${error.message}`);
        return "";
      });
    }
  }

  const sourceText = [
    extracted.title,
    extracted.description,
    extracted.body,
    imageOcrText,
    hasMeaningfulTranscript(transcript) ? transcript : "",
    ocrText
  ].filter(Boolean).join("\n\n");

  const category = await classifyCategory(sourceText, extracted, options);

  const summary = hasSummaryChatConfig(options) && sourceText.trim()
    ? await summarizeWithChatApi(sourceText, extracted, options).catch((error) => {
      warnings.push(`AI 总结失败：${error.message}`);
      return fallbackSummary(sourceText);
    })
    : fallbackSummary(sourceText);

  const notePath = await writeNote({
    vaultPath: options.vaultPath,
    outputFolder: options.outputFolder || "笔记/小红书",
    url,
    extracted,
    summary,
    transcript,
    ocrText,
    imageOcrText,
    mediaPath,
    archivedMediaPath,
    category
  });

  return {
    notePath,
    title: extracted.title || "小红书笔记"
  };
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      }
    });
    if (!response.ok) {
      throw new Error(`网页请求失败：HTTP ${response.status}`);
    }
    return {
      finalUrl: response.url || url,
      html: await response.text()
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`网页请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractPage(url, html) {
  const title = cleanText(
    pickMeta(html, "og:title") ||
    matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    "小红书笔记"
  );
  const description = cleanText(
    pickMeta(html, "description") ||
    pickMeta(html, "og:description") ||
    ""
  );
  const rawImages = unique([
    pickMeta(html, "og:image"),
    ...extractInitialStateImages(html),
    ...matchAll(html, /https?:\\?\/\\?\/[^"'<>\\\s)]+?(?:jpg|jpeg|png|webp)[^"'<>\\\s)]*/gi)
  ].map(unescapeUrl).filter(Boolean));
  const images = filterImageUrls(rawImages);
  const videoUrls = unique([
    pickMeta(html, "og:video"),
    pickMeta(html, "og:video:url"),
    ...matchAll(html, /https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:mp4|m3u8)(?:\?[^"'<>\\\s]*)?/gi)
  ].map(unescapeUrl).filter(Boolean));
  const noteLinks = unique(matchAll(html, /https?:\\?\/\\?\/www\.xiaohongshu\.com\\?\/(?:explore|discovery\/item)\\?\/[A-Za-z0-9]+[^"'<>\\\s]*/gi)
    .map(unescapeUrl)
    .map(normalizeXhsUrl));

  const jsonText = extractLikelyJsonText(html);
  const body = cleanText(jsonText || description);

  return { url, title, description, body, images, videoUrls, noteLinks };
}

function isUnavailablePage(extracted, html) {
  const content = cleanText([
    extracted.title,
    extracted.description,
    extracted.body,
    html.slice(0, 3000)
  ].filter(Boolean).join("\n"));
  return /页面不见了|内容不存在|笔记不存在|该内容无法访问|当前笔记暂时无法浏览/.test(content);
}

function extractInitialStateImages(html) {
  const state = matchOne(html, /window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/);
  if (!state) {
    return [];
  }
  return unique([
    ...matchAll(state, /"urlDefault"\s*:\s*"((?:\\.|[^"\\])*)"/g),
    ...matchAll(state, /"urlPre"\s*:\s*"((?:\\.|[^"\\])*)"/g),
    ...matchAll(state, /"url"\s*:\s*"((?:https?:\\\/\\\/sns-[^"\\]+|http?:\\\/\\\/sns-[^"\\]+)(?:\\.|[^"\\])*)"/g)
  ].map(decodeJsonString).map(unescapeUrl).filter(Boolean));
}

function extractLikelyJsonText(html) {
  const candidates = [];
  for (const raw of matchAll(html, /"desc"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    candidates.push(decodeJsonString(raw));
  }
  for (const raw of matchAll(html, /"content"\s*:\s*"((?:\\.|[^"\\]){20,})"/g)) {
    candidates.push(decodeJsonString(raw));
  }
  return unique(candidates.map(cleanText).filter((text) => text.length > 20)).join("\n\n");
}

async function downloadMedia(url, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-media-"));
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
    maxBuffer: 1024 * 1024 * 20,
    timeout: 1000 * 60 * 5
  });
  const files = await fs.readdir(tempDir);
  const media = files.find((file) => /\.(mp3|m4a|mp4|webm|wav|mpeg|mpga)$/i.test(file));
  if (!media) {
    throw new Error("没有找到可转写的媒体文件。");
  }
  return path.join(tempDir, media);
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
  throw new Error("缺少 yt-dlp。请在插件目录创建 .venv 并安装 yt-dlp，或运行 README 里的安装命令。");
}

async function transcribeMedia(mediaPath, options) {
  const form = new FormData();
  form.append("model", options.transcriptionModel);
  form.append("file", new Blob([await fs.readFile(mediaPath)]), path.basename(mediaPath));

  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.openaiApiKey}`
    },
    body: form
  }, 1000 * 60 * 10);
  const data = await withTimeout(response.json(), 1000 * 60 * 2, "读取转写接口响应超时").catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }
  return data.text || "";
}

async function transcribeMediaAuto(mediaPath, options) {
  if (options.openaiApiKey && options.transcriptionModel) {
    const stat = await fs.stat(mediaPath);
    if (stat.size <= 24 * 1024 * 1024) {
      return transcribeMedia(mediaPath, options);
    }
    warnings.push("媒体文件超过 24MB，正在改用本地 Whisper 转写。");
  }
  if (!options.openaiApiKey || !options.transcriptionModel) {
    warnings.push("未设置云端音频转写 Key 或模型，正在使用本地 Whisper 转写。");
  }
  return transcribeWithLocalWhisper(mediaPath, options);
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
    timeout: 1000 * 60 * 5,
    maxBuffer: 1024 * 1024 * 20
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
    timeout: 1000 * 60 * 15,
    maxBuffer: 1024 * 1024 * 20
  });
  return cleanText(await fs.readFile(`${outputBase}.txt`, "utf8"));
}

async function ocrVideoFrames(mediaPath) {
  const frameDir = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-frames-"));
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-y",
    "-i", mediaPath,
    "-vf", "fps=1,scale=1800:-1",
    "-frames:v", "45",
    path.join(frameDir, "frame-%03d.png")
  ], {
    timeout: 1000 * 60 * 3,
    maxBuffer: 1024 * 1024 * 20
  });

  const frames = (await fs.readdir(frameDir))
    .filter((file) => file.endsWith(".png"))
    .sort();
  const chunks = await ocrLocalImages(frames.map((frame) => path.join(frameDir, frame)));
  return dedupeOcrLines(chunks.join("\n"));
}

async function ocrImages(imageUrls, options = {}) {
  const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-images-"));
  const preparedPaths = [];
  for (const [index, imageUrl] of imageUrls.slice(0, 12).entries()) {
    const imagePath = path.join(imageDir, `image-${String(index + 1).padStart(2, "0")}.jpg`);
    const preparedPath = path.join(imageDir, `image-${String(index + 1).padStart(2, "0")}-ocr.png`);
    await downloadFile(imageUrl, imagePath).catch((error) => {
      warnings.push(`图片下载失败：${imageUrl}：${error.message}`);
    });
    if (!existsSync(imagePath)) {
      continue;
    }
    await prepareImageForOcr(imagePath, preparedPath).catch(() => fs.copyFile(imagePath, preparedPath));
    preparedPaths.push(existsSync(preparedPath) ? preparedPath : imagePath);
  }

  if (options.useVisionModel !== false && hasVisionChatConfig(options) && preparedPaths.length) {
    const visionText = await ocrImagesWithVisionModel(preparedPaths, options).catch((error) => {
      warnings.push(`视觉模型识别图片失败，回退到本地 OCR：${error.message}`);
      return "";
    });
    if (cleanOcrText(visionText).length >= 10) {
      return dedupeOcrLines(cleanOcrText(visionText));
    }
  }

  const chunks = await ocrLocalImages(preparedPaths);
  return dedupeOcrLines(chunks.join("\n"));
}

async function ocrImagesWithVisionModel(imagePaths, options) {
  const chunks = [];
  for (const [index, imagePath] of imagePaths.entries()) {
    const text = await ocrSingleImageWithVisionModel(imagePath, index + 1, options);
    const cleaned = cleanOcrText(text);
    if (cleaned) {
      chunks.push(`【图${index + 1}】\n${cleaned}`);
    }
  }
  return chunks.join("\n\n");
}

async function ocrSingleImageWithVisionModel(imagePath, imageIndex, options) {
  const dataUrl = await imageToDataUrl(imagePath);
  const baseUrl = String(options.visionApiBaseUrl || options.summaryApiBaseUrl).replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.visionApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: options.visionModel,
      temperature: 0,
      max_tokens: 2200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `请完整识别第 ${imageIndex} 张小红书图片里的中文和英文文字。`,
                "要求：",
                "1. 只输出图片中真实存在的文字，不要总结、不要改写、不要编造。",
                "2. 尽量保留标题、序号、项目符号和换行层级。",
                "3. 如果只有装饰图没有文字，输出空字符串。"
              ].join("\n")
            },
            {
              type: "image_url",
              image_url: { url: dataUrl }
            }
          ]
        }
      ]
    })
  }, 1000 * 60 * 2);
  const data = await withTimeout(response.json(), 1000 * 60 * 2, "读取视觉模型响应超时").catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.msg || `HTTP ${response.status}`);
  }
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function ocrLocalImages(imagePaths) {
  if (!imagePaths.length) {
    return [];
  }

  const rapidText = await ocrWithRapidOcr(imagePaths).catch((error) => {
    warnings.push(`RapidOCR 失败，回退到 Tesseract：${error.message}`);
    return "";
  });
  if (rapidText.trim()) {
    return [cleanOcrText(rapidText)];
  }

  const tesseractPath = await findExecutable([
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "tesseract"
  ], ["--version"], "缺少 tesseract，无法识别图片文字。");

  const chunks = [];
  for (const imagePath of imagePaths) {
    const { stdout } = await execFileAsync(tesseractPath, [
      imagePath,
      "stdout",
      "-l", "chi_sim+eng",
      "--psm", "6",
      "-c", "preserve_interword_spaces=1"
    ], {
      timeout: 1000 * 30,
      maxBuffer: 1024 * 1024 * 5
    });
    const text = cleanOcrText(stdout);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks;
}

async function ocrWithRapidOcr(imagePaths) {
  const python = path.join(pluginDir, ".venv", "bin", "python");
  if (!existsSync(python)) {
    throw new Error("插件 Python 环境不存在。");
  }
  const { stdout } = await execFileAsync(python, [
    path.join(pluginDir, "scripts", "rapid_ocr.py"),
    ...imagePaths
  ], {
    cwd: pluginDir,
    timeout: 1000 * 60 * 5,
    maxBuffer: 1024 * 1024 * 20
  });
  return stdout;
}

async function prepareImageForOcr(inputPath, outputPath) {
  await execFileAsync("/opt/homebrew/bin/ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", "scale=2400:-1:flags=lanczos,format=gray,unsharp=5:5:1.0:5:5:0.0",
    outputPath
  ], {
    timeout: 1000 * 30,
    maxBuffer: 1024 * 1024 * 10
  });
}

async function downloadFile(url, destinationPath) {
  const response = await fetchWithTimeout(normalizeAssetUrl(url), {
    headers: {
      "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "referer": "https://www.xiaohongshu.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    }
  }, 30000);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = await withTimeout(response.arrayBuffer(), 30000, `读取图片超时：${url}`);
  await fs.writeFile(destinationPath, Buffer.from(bytes));
}

async function imageToDataUrl(imagePath) {
  const mime = path.extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  const data = await fs.readFile(imagePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function hasMeaningfulTranscript(text) {
  const normalized = cleanText(text).toLowerCase();
  return Boolean(normalized && !/^\[?(music|音乐)\]?$/.test(normalized));
}

async function findExecutable(candidates, testArgs, missingMessage) {
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) {
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

function cleanOcrText(text) {
  return String(text || "")
    .replace(/[|｜]/g, " ")
    .split(/\r?\n/)
    .map((line) => cleanText(line).replace(/\s+/g, " "))
    .filter((line) => line.length >= 2)
    .join("\n")
    .trim();
}

function dedupeOcrLines(text) {
  const seen = new Set();
  const lines = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const normalized = line.replace(/\s+/g, "").replace(/[，。！？、：:；;,.!?]/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    lines.push(line);
  }
  return lines.join("\n").trim();
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

async function summarizeWithChatApi(sourceText, extracted, options) {
  const baseUrl = String(options.summaryApiBaseUrl).replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
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
          content: "你是一个严谨的中文知识整理助手。把小红书笔记整理成适合 Obsidian 保存的精炼 Markdown。不要编造原文没有的信息。"
        },
        {
          role: "user",
          content: [
            `标题：${extracted.title || ""}`,
            `链接：${extracted.url}`,
            "请输出：",
            "## 一句话总结",
            "## 核心要点",
            "## 可执行清单",
            "## 值得回看",
            "",
            "原始内容：",
            sourceText.slice(0, 60000)
          ].join("\n")
        }
      ]
    })
  }, 1000 * 60 * 2);
  const data = await withTimeout(response.json(), 1000 * 60 * 2, "读取总结接口响应超时").catch(() => ({}));
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
  if (!hasSummaryChatConfig(options) || !sourceText.trim()) {
    return guessCategory(sourceText, categories);
  }

  const baseUrl = String(options.summaryApiBaseUrl).replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
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
          content: "你负责给笔记分类。只能从用户提供的分类中选择一个，直接输出分类名，不要解释，不要新增分类。优先选择宽泛大类，不要按具体标题生成细分类。"
        },
        {
          role: "user",
          content: [
            `可选分类：${categories.join("、")}`,
            `标题：${extracted.title || ""}`,
            "内容：",
            sourceText.slice(0, 8000)
          ].join("\n")
        }
      ]
    })
  }, 1000 * 60);
  const data = await withTimeout(response.json(), 1000 * 60, "读取分类接口响应超时").catch(() => ({}));
  if (!response.ok) {
    warnings.push(`AI 分类失败，使用规则兜底：${data.error?.message || `HTTP ${response.status}`}`);
    return guessCategory(sourceText, categories);
  }
  return pickAllowedCategory(data.choices?.[0]?.message?.content || "", categories);
}

async function archiveMedia(mediaPath, options, extracted) {
  const vaultPath = options.vaultPath;
  const attachmentFolder = options.mediaFolder || "附件/小红书";
  const folderAbs = path.join(vaultPath, attachmentFolder);
  await fs.mkdir(folderAbs, { recursive: true });

  const ext = path.extname(mediaPath) || ".mp4";
  const date = localDateString();
  const base = sanitizeFilename(extracted.title || "小红书媒体").slice(0, 60) || "小红书媒体";
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

async function writeNote({ vaultPath, outputFolder, url, extracted, summary, transcript, ocrText, imageOcrText, mediaPath, archivedMediaPath, category }) {
  const safeCategory = sanitizePathSegment(category || "未分类");
  const noteFolder = safeCategory
    ? path.posix.join(outputFolder.replace(/\\/g, "/"), safeCategory)
    : outputFolder.replace(/\\/g, "/");
  const folderAbs = path.join(vaultPath, noteFolder);
  await fs.mkdir(folderAbs, { recursive: true });

  const base = sanitizeFilename(extracted.title || "小红书笔记").slice(0, 70) || "小红书笔记";
  let relativePath = path.posix.join(noteFolder, `${base}.md`);
  let absPath = path.join(vaultPath, relativePath);
  let index = 2;
  while (existsSync(absPath)) {
    relativePath = path.posix.join(noteFolder, `${base} ${index}.md`);
    absPath = path.join(vaultPath, relativePath);
    index += 1;
  }

  const tags = ["小红书", "摘要", safeCategory].filter(Boolean);
  const frontmatter = [
    "---",
    `source: ${JSON.stringify(url)}`,
    "platform: 小红书",
    `created: ${new Date().toISOString()}`,
    `category: ${JSON.stringify(safeCategory)}`,
    `tags: ${JSON.stringify(tags)}`,
    "---"
  ].join("\n");

  const body = [
    frontmatter,
    "",
    `# ${escapeMarkdownHeading(extracted.title || "小红书笔记")}`,
    "",
    `原链接：${url}`,
    "",
    archivedMediaPath ? `媒体文件：[[${archivedMediaPath}]]` : "",
    archivedMediaPath ? "" : "",
    summary || "暂无可用摘要。",
    "",
    "## 原始摘录",
    "",
    extracted.body || extracted.description || "未能从页面静态内容中提取正文。",
    "",
    extracted.noteLinks.length ? ["## 页面中发现的笔记链接", "", ...extracted.noteLinks.map((link) => `- ${link}`), ""].join("\n") : "",
    extracted.images.length ? ["## 图片", "", ...extracted.images.slice(0, 12).map((image) => `- ${image}`), ""].join("\n") : "",
    imageOcrText ? ["## 图片文字", "", imageOcrText, ""].join("\n") : "",
    transcript ? ["## 视频转写", "", transcript, ""].join("\n") : "",
    ocrText ? ["## 视频画面文字", "", ocrText, ""].join("\n") : "",
    mediaPath ? `\n<!-- 转写临时媒体：${mediaPath} -->\n` : "",
    archivedMediaPath ? `<!-- 已归档媒体：${archivedMediaPath} -->\n` : ""
  ].filter(Boolean).join("\n");

  await fs.writeFile(absPath, body, "utf8");
  return relativePath;
}

function fallbackSummary(text) {
  const clean = cleanText(text);
  if (!clean) {
    return [
      "## 一句话总结",
      "未能提取到足够内容。",
      "",
      "## 核心要点",
      "- 请确认链接是单条笔记详情页，并且浏览器已登录。"
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

function pickMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return unescapeHtml(matchOne(html, new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i")) ||
    matchOne(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i")) || "");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "操作超时")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function matchOne(text, regex) {
  const match = text.match(regex);
  return match?.[1] || "";
}

function matchAll(text, regex) {
  return [...text.matchAll(regex)].map((match) => match[1] || match[0]);
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function cleanText(text) {
  return unescapeHtml(String(text || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unescapeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function unescapeUrl(value) {
  return unescapeHtml(String(value || "").replace(/\\\//g, "/"));
}

function filterImageUrls(values) {
  const urls = unique(values
    .map(normalizeAssetUrl)
    .filter((url) => /^https?:\/\/[^/]+\/.+/i.test(url))
    .filter((url) => !/\/(?:favicon|logo)[^/]*\.(?:png|jpg|jpeg|webp)$/i.test(url)));

  const hasDefaultImages = urls.some((url) => /!nd_(?:dft|wgth|webp)/i.test(url));
  return urls.filter((url) => {
    if (hasDefaultImages && /!nd_prv/i.test(url)) {
      return false;
    }
    return true;
  });
}

function normalizeModelOptions(options) {
  options.summaryApiKey = options.summaryApiKey || process.env.SUMMARY_API_KEY || options.openaiApiKey || process.env.OPENAI_API_KEY || "";
  options.summaryApiBaseUrl = options.summaryApiBaseUrl || process.env.SUMMARY_API_BASE_URL || process.env.OPENAI_BASE_URL || "";
  options.summaryModel = options.summaryModel || process.env.SUMMARY_MODEL || "";
  options.visionApiKey = options.visionApiKey || process.env.VISION_API_KEY || options.summaryApiKey || "";
  options.visionApiBaseUrl = options.visionApiBaseUrl || process.env.VISION_API_BASE_URL || options.summaryApiBaseUrl || "";
  options.visionModel = options.visionModel || process.env.VISION_MODEL || "";
  options.noteCategories = normalizeCategories(options.noteCategories);
}

function hasSummaryChatConfig(options) {
  return Boolean(options.summaryApiKey && options.summaryApiBaseUrl && options.summaryModel);
}

function hasVisionChatConfig(options) {
  return Boolean(options.visionApiKey && (options.visionApiBaseUrl || options.summaryApiBaseUrl) && options.visionModel);
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
    ["技术与工具", /(工具|插件|代码|编程|AI|模型|Obsidian|B站|剪辑|软件|开发|效率|网站|提示词)/],
    ["职场与沟通", /(职场|沟通|表达|汇报|领导|同事|人情世故|话术|关系|社交|会议|管理)/],
    ["学习与认知", /(学习|认知|思维|成长|读书|方法论|复盘|专注|记忆|知识|课程)/],
    ["生活与健康", /(生活|健康|睡眠|饮食|运动|健身|护肤|穿搭|旅行|家居|收纳)/],
    ["财务与商业", /(财务|理财|投资|商业|创业|副业|赚钱|收入|消费|预算|基金|股票)/],
    ["情感与关系", /(情感|恋爱|婚姻|亲密关系|家庭|朋友|伴侣|相处|边界)/],
    ["娱乐与灵感", /(娱乐|影视|音乐|游戏|灵感|审美|摄影|绘画|设计|探店|美食)/]
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeXhsUrl(url) {
  const parsed = new URL(unescapeUrl(url.trim()));
  parsed.hash = "";
  return parsed.toString();
}

function extractXhsUrl(input) {
  const text = String(input || "").trim();
  const urls = [
    ...text.matchAll(/https?:\/\/[^\s<>"'`，。！？、；；（）()【】\[\]]+/gi)
  ].map((match) => trimUrl(match[0]));
  const matched = urls.find((url) => /^https?:\/\/(?:(?:www\.)?xiaohongshu\.com|xhslink\.com)\//i.test(url));
  if (matched) {
    return matched;
  }
  const compact = text.match(/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s<>"'`，。！？、；；（）()【】\[\]]*/i);
  if (compact) {
    return trimUrl(compact[0].startsWith("http") ? compact[0] : `https://${compact[0]}`);
  }
  return trimUrl(text);
}

function trimUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[，。！？、；;,.!?]+$/g, "")
    .replace(/&amp;/g, "&");
}

function normalizeAssetUrl(url) {
  const value = unescapeUrl(url);
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return value;
}

function sanitizeFilename(name) {
  return cleanText(name).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizePathSegment(name) {
  return sanitizeFilename(name).replace(/[. ]+$/g, "").slice(0, 40);
}

function localDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
