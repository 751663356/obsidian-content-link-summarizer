import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const importScript = path.join(pluginDir, "scripts", "import_xhs.mjs");
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

const input = JSON.parse(await readStdin().catch(() => "{}") || "{}");
const vaultPath = input.vaultPath || path.dirname(path.dirname(pluginDir));
const settings = await readSettings();
const links = uniqueLinks([
  ...(Array.isArray(input.links) ? input.links : []),
  ...await readLinksFile(input.linksFile)
]);
const statusPath = input.statusPath || path.join(vaultPath, "收集箱", "小红书批量导入状态.json");
const maxItems = Number(input.maxItems || 0);
const pendingLinks = maxItems > 0 ? links.slice(0, maxItems) : links;

await fs.mkdir(path.dirname(statusPath), { recursive: true });
const status = await readStatus(statusPath);
const existingNotes = await scanExistingNotes(vaultPath, settings.outputFolder || "笔记/小红书");
status.createdAt ||= new Date().toISOString();
status.items ||= {};
status.total = pendingLinks.length;
status.updatedAt = new Date().toISOString();

let ok = 0;
let failed = 0;
let skipped = 0;

for (let index = 0; index < pendingLinks.length; index += 1) {
  const link = pendingLinks[index];
  const existingNote = existingNotes.get(noteKey(link));
  if (existingNote) {
    skipped += 1;
    status.items[link] = {
      status: "ok",
      notePath: existingNote,
      skippedReason: "already_exists",
      finishedAt: new Date().toISOString()
    };
    await writeStatus(statusPath, status);
    writeProgress({ type: "skip_existing", index: index + 1, total: pendingLinks.length, link, notePath: existingNote });
    continue;
  }

  const item = status.items[link];
  if (item?.status === "ok") {
    skipped += 1;
    writeProgress({ type: "skip", index: index + 1, total: pendingLinks.length, link, notePath: item.notePath });
    continue;
  }

  status.items[link] = {
    status: "running",
    startedAt: new Date().toISOString()
  };
  await writeStatus(statusPath, status);
  writeProgress({ type: "start", index: index + 1, total: pendingLinks.length, link });

  const result = await importOne(link);
  if (result.ok) {
    ok += 1;
    status.items[link] = {
      status: "ok",
      notePath: result.notePath || "",
      title: result.title || "",
      warnings: result.warnings || [],
      finishedAt: new Date().toISOString()
    };
    if (result.notePath) {
      existingNotes.set(noteKey(link), result.notePath);
    }
    writeProgress({ type: "ok", index: index + 1, total: pendingLinks.length, link, notePath: result.notePath, warnings: result.warnings?.length || 0 });
  } else {
    failed += 1;
    status.items[link] = {
      status: "failed",
      error: result.error || "导入失败",
      warnings: result.warnings || [],
      finishedAt: new Date().toISOString()
    };
    writeProgress({ type: "failed", index: index + 1, total: pendingLinks.length, link, error: result.error || "导入失败" });
  }

  status.updatedAt = new Date().toISOString();
  await writeStatus(statusPath, status);
}

writeProgress({
  type: "done",
  total: pendingLinks.length,
  ok,
  failed,
  skipped,
  statusPath
});

async function importOne(url) {
  const summaryApiKey = settings.summaryApiKey || settings.openaiApiKey || process.env.SUMMARY_API_KEY || process.env.OPENAI_API_KEY || "";
  const visionApiKey = settings.visionApiKey || summaryApiKey || process.env.VISION_API_KEY || "";
  const payload = {
    url,
    vaultPath,
    outputFolder: settings.outputFolder || "笔记/小红书",
    category: "__auto__",
    noteCategories: normalizeCategories(settings.noteCategories),
    summaryApiKey,
    summaryApiBaseUrl: settings.summaryApiBaseUrl || "",
    summaryModel: settings.summaryModel || "",
    visionApiKey,
    visionApiBaseUrl: settings.visionApiBaseUrl || settings.summaryApiBaseUrl || "",
    visionModel: settings.visionModel || "",
    useVisionModel: settings.useVisionModel !== false,
    transcriptionModel: settings.transcriptionModel || "",
    localWhisperModelPath: settings.localWhisperModelPath || "models/ggml-large-v3.bin",
    tryBrowserCookies: settings.tryBrowserCookies !== false,
    downloadVideo: settings.downloadVideo !== false
  };

  try {
    const stdout = await runImportHelper(settings.nodePath || "node", [importScript], payload, {
      cwd: pluginDir,
      env: {
        ...process.env,
        SUMMARY_API_KEY: summaryApiKey,
        VISION_API_KEY: visionApiKey
      },
      timeout: 1000 * 60 * 45
    });
    return JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      warnings: []
    };
  }
}

function runImportHelper(command, args, payload, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("导入超时，已跳过这条链接。"));
    }, options.timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024 * 80) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `helper exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readSettings() {
  const settingsPath = path.join(pluginDir, "data.json");
  if (!existsSync(settingsPath)) {
    return {};
  }
  return JSON.parse(await fs.readFile(settingsPath, "utf8"));
}

async function readLinksFile(linksFile) {
  if (!linksFile) {
    return [];
  }
  const text = await fs.readFile(linksFile, "utf8");
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readStatus(file) {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function scanExistingNotes(vaultPath, outputFolder) {
  const out = new Map();
  const root = path.join(vaultPath, outputFolder.replace(/\\/g, "/"));
  if (!existsSync(root)) {
    return out;
  }
  const files = await listMarkdownFiles(root);
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const source = text.match(/^source:\s*(.+)$/m)?.[1] || "";
    const id = source.match(/[0-9a-f]{24}/i)?.[0];
    if (!id) {
      continue;
    }
    out.set(id, path.relative(vaultPath, file).split(path.sep).join("/"));
  }
  return out;
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(fullPath);
    }
  }
  return out;
}

async function writeStatus(file, status) {
  const normalized = {
    ...status,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function writeProgress(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function normalizeCategories(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,，]/);
  const categories = [...new Set(raw.map((item) => String(item || "").trim()).filter(Boolean))];
  return categories.length ? categories : DEFAULT_NOTE_CATEGORIES;
}

function uniqueLinks(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const link = String(value || "").trim();
    if (!/^https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\//i.test(link)) {
      continue;
    }
    const key = noteKey(link);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

function noteKey(link) {
  const id = link.match(/[0-9a-f]{24}/i)?.[0];
  return id || link.replace(/[?#].*$/, "");
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
