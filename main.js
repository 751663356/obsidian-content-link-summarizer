const {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath
} = require("obsidian");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  outputFolder: "笔记/小红书",
  bilibiliOutputFolder: "笔记/B站",
  nodePath: "/Users/ian/.nvm/versions/node/v24.14.0/bin/node",
  openaiApiKey: "",
  summaryApiKey: "",
  summaryApiBaseUrl: "https://api.z.ai/api/paas/v4",
  summaryModel: "glm-5.1",
  visionApiKey: "",
  visionApiBaseUrl: "https://api.z.ai/api/paas/v4",
  visionModel: "glm-5v-turbo",
  useVisionModel: true,
  transcriptionModel: "gpt-4o-mini-transcribe",
  localWhisperModelPath: "models/ggml-large-v3.bin",
  noteCategories: [],
  tryBrowserCookies: true,
  downloadVideo: true,
  batchQueue: []
};

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

module.exports = class XiaohongshuSummarizerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.noteCategories)) {
      this.settings.noteCategories = [];
    }
    if (!Array.isArray(this.settings.batchQueue)) {
      this.settings.batchQueue = [];
    }
    this.isProcessingQueue = false;

    this.addCommand({
      id: "import-content-url",
      name: "导入链接并总结",
      callback: () => new UrlModal(this.app, this, {
        title: "导入链接",
        description: "支持小红书、B 站网页链接，也支持直接粘贴 App 分享出来的整段文案。插件会自动判断平台、自动分类并生成总结。",
        placeholder: "粘贴网页链接，或小红书/B站 App 分享文案里的短链接",
      }, "", async (url) => this.importAnyUrl(url)).open()
    });

    this.addCommand({
      id: "import-content-url-from-clipboard",
      name: "从剪贴板导入链接并总结",
      callback: async () => {
        const url = await navigator.clipboard.readText();
        new UrlModal(this.app, this, {
          title: "导入链接",
          description: "支持小红书、B 站网页链接，也支持直接粘贴 App 分享出来的整段文案。插件会自动判断平台、自动分类并生成总结。",
          placeholder: "粘贴网页链接，或小红书/B站 App 分享文案里的短链接",
        }, url.trim(), async (value) => this.importAnyUrl(value)).open();
      }
    });

    this.addCommand({
      id: "batch-import-content-urls",
      name: "批量导入链接并排队总结",
      callback: () => new BatchUrlModal(this.app, this).open()
    });

    this.addCommand({
      id: "resume-batch-import-queue",
      name: "继续处理批量导入队列",
      callback: async () => this.processBatchQueue()
    });

    this.addSettingTab(new XiaohongshuSummarizerSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async importAnyUrl(rawUrl) {
    const url = extractSupportedUrl(rawUrl);
    if (isXiaohongshuUrl(url)) {
      await this.importUrl(url);
      return;
    }
    if (isBilibiliUrl(url)) {
      await this.importBilibiliUrl(url);
      return;
    }
    new Notice("没有识别到可导入的小红书或 B 站链接。可以直接粘贴 App 分享出来的整段文字。");
  }

  async importUrl(rawUrl) {
    const url = extractSupportedUrl(rawUrl);
    if (!isXiaohongshuUrl(url)) {
      new Notice("请粘贴有效的小红书链接或小红书分享文案。");
      return;
    }

    new Notice("正在提取小红书内容，视频转写可能需要一会儿。");

    try {
      const result = await this.importXhsToNote(url);

      if (!result.ok) {
        throw new Error(result.error || "导入失败");
      }

      const target = normalizePath(result.notePath);
      const file = this.app.vault.getAbstractFileByPath(target);
      if (file) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }

      const warnings = (result.warnings || []).length ? `，有 ${result.warnings.length} 条提示` : "";
      new Notice(`小红书笔记已生成${warnings}：${target}`);
    } catch (error) {
      console.error(error);
      new Notice(`小红书导入失败：${error.message || error}`);
    }
  }

  async importBilibiliUrl(rawUrl) {
    const url = extractSupportedUrl(rawUrl);
    if (!isBilibiliUrl(url)) {
      new Notice("请粘贴有效的 B 站视频链接或 B 站分享文案。");
      return;
    }

    new Notice("正在提取 B 站视频内容；没有字幕时会转写音频，可能需要一会儿。");

    try {
      const result = await this.importBilibiliToNote(url);

      if (!result.ok) {
        throw new Error(result.error || "导入失败");
      }

      const target = normalizePath(result.notePath);
      const file = this.app.vault.getAbstractFileByPath(target);
      if (file) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }

      const warnings = (result.warnings || []).length ? `，有 ${result.warnings.length} 条提示` : "";
      new Notice(`B 站视频总结已生成${warnings}：${target}`);
    } catch (error) {
      console.error(error);
      new Notice(`B 站导入失败：${error.message || error}`);
    }
  }

  async importXhsToNote(url) {
    const summaryApiKey = this.settings.summaryApiKey || this.settings.openaiApiKey || "";
    const visionApiKey = this.settings.visionApiKey || summaryApiKey;
    return this.runHelper("import_xhs.mjs", {
      url,
      vaultPath: this.app.vault.adapter.basePath,
      outputFolder: this.settings.outputFolder,
      category: "__auto__",
      noteCategories: getNoteCategories(this.settings),
      summaryApiKey,
      summaryApiBaseUrl: this.settings.summaryApiBaseUrl,
      summaryModel: this.settings.summaryModel,
      visionApiKey,
      visionApiBaseUrl: this.settings.visionApiBaseUrl || this.settings.summaryApiBaseUrl,
      visionModel: this.settings.visionModel,
      useVisionModel: this.settings.useVisionModel,
      transcriptionModel: this.settings.transcriptionModel,
      localWhisperModelPath: this.settings.localWhisperModelPath,
      tryBrowserCookies: this.settings.tryBrowserCookies,
      downloadVideo: this.settings.downloadVideo
    });
  }

  async importBilibiliToNote(url) {
    const summaryApiKey = this.settings.summaryApiKey || this.settings.openaiApiKey || "";
    return this.runHelper("import_bilibili.mjs", {
      url,
      vaultPath: this.app.vault.adapter.basePath,
      outputFolder: this.settings.bilibiliOutputFolder || DEFAULT_SETTINGS.bilibiliOutputFolder,
      category: "__auto__",
      noteCategories: getNoteCategories(this.settings),
      summaryApiKey,
      summaryApiBaseUrl: this.settings.summaryApiBaseUrl,
      summaryModel: this.settings.summaryModel,
      localWhisperModelPath: this.settings.localWhisperModelPath,
      tryBrowserCookies: this.settings.tryBrowserCookies,
      downloadVideo: this.settings.downloadVideo
    });
  }

  async enqueueBatch(rawText) {
    const urls = extractAllSupportedUrls(rawText);
    if (!urls.length) {
      new Notice("没有识别到可导入的小红书或 B 站链接。");
      return;
    }

    const existingKeys = new Set(this.settings.batchQueue.map((item) => item.key || queueKey(item.url)));
    const now = new Date().toISOString();
    let added = 0;
    for (const url of urls) {
      const key = queueKey(url);
      if (existingKeys.has(key)) {
        continue;
      }
      existingKeys.add(key);
      this.settings.batchQueue.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key,
        url,
        platform: isXiaohongshuUrl(url) ? "小红书" : "B站",
        status: "pending",
        createdAt: now,
        notePath: "",
        error: "",
        warnings: []
      });
      added += 1;
    }

    await this.saveSettings();
    await this.writeBatchQueueReport();
    new Notice(`已加入 ${added} 条，队列现有 ${this.settings.batchQueue.length} 条。`);
    await this.processBatchQueue();
  }

  async processBatchQueue() {
    if (this.isProcessingQueue) {
      new Notice("批量导入队列正在运行。");
      return;
    }

    const next = () => this.settings.batchQueue.find((item) => item.status === "pending" || item.status === "running");
    let item = next();
    if (!item) {
      new Notice("批量导入队列里没有待处理链接。");
      await this.writeBatchQueueReport();
      return;
    }

    this.isProcessingQueue = true;
    try {
      while ((item = next())) {
        item.status = "running";
        item.startedAt = new Date().toISOString();
        item.error = "";
        await this.saveSettings();
        await this.writeBatchQueueReport();

        const index = this.settings.batchQueue.indexOf(item) + 1;
        new Notice(`批量导入 ${index}/${this.settings.batchQueue.length}：${item.platform}`);

        try {
          const result = item.platform === "B站"
            ? await this.importBilibiliToNote(item.url)
            : await this.importXhsToNote(item.url);
          if (!result.ok) {
            throw new Error(result.error || "导入失败");
          }
          item.status = "done";
          item.notePath = result.notePath || "";
          item.title = result.title || "";
          item.warnings = result.warnings || [];
          item.finishedAt = new Date().toISOString();
        } catch (error) {
          console.error(error);
          item.status = "failed";
          item.error = error.message || String(error);
          item.finishedAt = new Date().toISOString();
        }

        await this.saveSettings();
        await this.writeBatchQueueReport();
      }
      new Notice("批量导入队列处理完成。");
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async writeBatchQueueReport() {
    const queue = this.settings.batchQueue || [];
    const counts = countQueueStatus(queue);
    const reportPath = "收集箱/内容链接批量导入队列.md";
    const absPath = path.join(this.app.vault.adapter.basePath, reportPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    const lines = [
      "# 内容链接批量导入队列",
      "",
      `更新时间：${new Date().toLocaleString()}`,
      "",
      `总数：${queue.length}`,
      `待处理：${counts.pending}`,
      `处理中：${counts.running}`,
      `已完成：${counts.done}`,
      `失败：${counts.failed}`,
      "",
      "## 队列",
      "",
      "| 状态 | 平台 | 标题/链接 | 结果 |",
      "| --- | --- | --- | --- |",
      ...queue.map((item) => {
        const label = item.title || item.url;
        const result = item.notePath ? `[[${item.notePath}]]` : (item.error || "");
        return `| ${item.status} | ${item.platform || ""} | ${escapeTableCell(label)} | ${escapeTableCell(result)} |`;
      })
    ];
    await fs.promises.writeFile(absPath, `${lines.join("\n")}\n`, "utf8");
  }

  runHelper(scriptName, payload, timeoutMs = 1000 * 60 * 45) {
    return new Promise((resolve, reject) => {
      const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
      const helperPath = path.join(pluginDir, "scripts", scriptName);
      const child = childProcess.spawn(this.settings.nodePath || "node", [helperPath], {
        cwd: pluginDir,
        env: Object.assign({}, process.env, {
          SUMMARY_API_KEY: payload.summaryApiKey || process.env.SUMMARY_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "",
          VISION_API_KEY: payload.visionApiKey || process.env.VISION_API_KEY || payload.summaryApiKey || process.env.SUMMARY_API_KEY || process.env.OPENAI_API_KEY || ""
        }),
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
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
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
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`无法解析辅助脚本输出：${stdout || stderr}`));
        }
      });

      child.stdin.end(JSON.stringify(payload));
    });
  }
};

class UrlModal extends Modal {
  constructor(app, plugin, copy, initialUrl, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.copy = Object.assign({
      title: "导入链接",
      description: "粘贴链接后选择分类。",
      placeholder: "https://...",
    }, copy || {});
    this.initialUrl = initialUrl || "";
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("xhs-summarizer-modal");
    contentEl.createEl("h2", { text: this.copy.title });
    contentEl.createEl("p", {
      cls: "xhs-summarizer-muted",
      text: this.copy.description
    });

    const input = contentEl.createEl("textarea", {
      attr: { placeholder: this.copy.placeholder }
    });
    input.value = this.initialUrl;
    input.focus();

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("导入并总结")
        .setCta()
        .onClick(async () => {
          this.close();
          await this.onSubmit(input.value);
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class BatchUrlModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("xhs-summarizer-modal");
    contentEl.createEl("h2", { text: "批量导入链接" });
    contentEl.createEl("p", {
      cls: "xhs-summarizer-muted",
      text: "一行一个链接，或直接粘贴多段小红书/B站分享文案。插件会提取链接并按队列逐条总结。"
    });

    const input = contentEl.createEl("textarea", {
      attr: { placeholder: "粘贴多个链接或分享文案..." }
    });
    input.rows = 12;
    input.focus();

    const counts = countQueueStatus(this.plugin.settings.batchQueue || []);
    contentEl.createEl("p", {
      cls: "xhs-summarizer-muted",
      text: `当前队列：待处理 ${counts.pending}，处理中 ${counts.running}，已完成 ${counts.done}，失败 ${counts.failed}`
    });

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("加入队列并开始")
        .setCta()
        .onClick(async () => {
          const value = input.value;
          this.close();
          await this.plugin.enqueueBatch(value);
        }))
      .addButton((button) => button
        .setButtonText("继续当前队列")
        .onClick(async () => {
          this.close();
          await this.plugin.processBatchQueue();
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class XiaohongshuSummarizerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "内容链接总结" });

    new Setting(containerEl)
      .setName("输出文件夹")
      .setDesc("小红书笔记的根目录。实际会再按分类放到子文件夹。")
      .addText((text) => text
        .setPlaceholder("笔记/小红书")
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("B 站输出文件夹")
      .setDesc("B 站视频总结的根目录。实际会再按分类放到子文件夹。")
      .addText((text) => text
        .setPlaceholder("笔记/B站")
        .setValue(this.plugin.settings.bilibiliOutputFolder || DEFAULT_SETTINGS.bilibiliOutputFolder)
        .onChange(async (value) => {
          this.plugin.settings.bilibiliOutputFolder = value.trim() || DEFAULT_SETTINGS.bilibiliOutputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("分类候选")
      .setDesc("可留空。留空时使用默认大类；填写后 AI 只会从这些分类中选择。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text
          .setPlaceholder(DEFAULT_NOTE_CATEGORIES.join("\n"))
          .setValue(getNoteCategories(this.plugin.settings).join("\n"))
          .onChange(async (value) => {
            const categories = parseCategories(value);
            this.plugin.settings.noteCategories = categories;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Node 路径")
      .setDesc("如果 Obsidian 找不到 node，可填 /opt/homebrew/bin/node 或 /usr/local/bin/node。")
      .addText((text) => text
        .setPlaceholder("node")
        .setValue(this.plugin.settings.nodePath)
        .onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || DEFAULT_SETTINGS.nodePath;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("总结 API Key")
      .setDesc("用于调用 GLM-5.1 等 OpenAI 兼容接口做总结。不会保存小红书账号密码。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Z.AI API Key")
          .setValue(this.plugin.settings.summaryApiKey || this.plugin.settings.openaiApiKey || "")
          .onChange(async (value) => {
            this.plugin.settings.summaryApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("总结 API 地址")
      .setDesc("Z.AI OpenAI 兼容地址默认是 https://api.z.ai/api/paas/v4。")
      .addText((text) => text
        .setPlaceholder("https://api.z.ai/api/paas/v4")
        .setValue(this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.summaryApiBaseUrl = value.trim() || DEFAULT_SETTINGS.summaryApiBaseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("总结模型")
      .addText((text) => text
        .setPlaceholder("glm-5.1")
        .setValue(this.plugin.settings.summaryModel)
        .onChange(async (value) => {
          this.plugin.settings.summaryModel = value.trim() || DEFAULT_SETTINGS.summaryModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("启用图文理解")
      .setDesc("纯图片笔记会先交给视觉模型识别图片文字；失败时自动回退到本地 OCR。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useVisionModel !== false)
        .onChange(async (value) => {
          this.plugin.settings.useVisionModel = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("图文理解 API Key")
      .setDesc("留空时复用上面的总结 API Key。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("默认复用总结 API Key")
          .setValue(this.plugin.settings.visionApiKey || "")
          .onChange(async (value) => {
            this.plugin.settings.visionApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("图文理解 API 地址")
      .addText((text) => text
        .setPlaceholder("https://api.z.ai/api/paas/v4")
        .setValue(this.plugin.settings.visionApiBaseUrl || this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.visionApiBaseUrl = value.trim() || DEFAULT_SETTINGS.visionApiBaseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("图文理解模型")
      .addText((text) => text
        .setPlaceholder("glm-5v-turbo")
        .setValue(this.plugin.settings.visionModel || DEFAULT_SETTINGS.visionModel)
        .onChange(async (value) => {
          this.plugin.settings.visionModel = value.trim() || DEFAULT_SETTINGS.visionModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("转写模型")
      .setDesc("只在你额外配置 OpenAI 音频转写时使用；默认转写走本地 Whisper。GLM 负责总结和图片理解，不负责音频转文字。")
      .addText((text) => text
        .setPlaceholder("gpt-4o-mini-transcribe")
        .setValue(this.plugin.settings.transcriptionModel)
        .onChange(async (value) => {
          this.plugin.settings.transcriptionModel = value.trim() || DEFAULT_SETTINGS.transcriptionModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("本地 Whisper 模型")
      .setDesc("相对插件目录或绝对路径。准确优先建议 models/ggml-large-v3.bin；速度优先可改回 models/ggml-base.bin。")
      .addText((text) => text
        .setPlaceholder("models/ggml-large-v3.bin")
        .setValue(this.plugin.settings.localWhisperModelPath)
        .onChange(async (value) => {
          this.plugin.settings.localWhisperModelPath = value.trim() || DEFAULT_SETTINGS.localWhisperModelPath;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("尝试读取浏览器登录态")
      .setDesc("下载视频时让 yt-dlp 尝试使用 Chrome Cookie。插件不会保存小红书账号密码。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.tryBrowserCookies)
        .onChange(async (value) => {
          this.plugin.settings.tryBrowserCookies = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("尝试下载并转写视频")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.downloadVideo)
        .onChange(async (value) => {
          this.plugin.settings.downloadVideo = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("p", {
      cls: "xhs-summarizer-muted xhs-summarizer-setting-warning",
      text: "不要把小红书账号密码填到这里。需要登录时，请在浏览器中手动登录。"
    });
  }
}

function getNoteCategories(settings) {
  if (!Array.isArray(settings.noteCategories)) {
    return DEFAULT_NOTE_CATEGORIES;
  }
  const categories = parseCategories(settings.noteCategories);
  return categories.length ? categories : DEFAULT_NOTE_CATEGORIES;
}

function parseCategories(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,，]/);
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}

function extractSupportedUrl(input) {
  const text = String(input || "").trim();
  if (!text) {
    return "";
  }
  const urls = [
    ...text.matchAll(/https?:\/\/[^\s<>"'`，。！？、；；（）()【】\[\]]+/gi)
  ].map((match) => trimUrl(match[0]));
  for (const url of urls) {
    if (isXiaohongshuUrl(url) || isBilibiliUrl(url)) {
      return url;
    }
  }
  const compact = text.match(/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com|bilibili\.com|b23\.tv|bili(?:22|23|33|2233)\.cn)\/[^\s<>"'`，。！？、；；（）()【】\[\]]*/i);
  if (compact) {
    const value = compact[0].startsWith("http") ? compact[0] : `https://${compact[0]}`;
    return trimUrl(value);
  }
  return trimUrl(text);
}

function extractAllSupportedUrls(input) {
  const text = String(input || "");
  const urls = [
    ...text.matchAll(/https?:\/\/[^\s<>"'`，。！？、；；（）()【】\[\]]+/gi)
  ].map((match) => trimUrl(match[0]));
  const compactUrls = [
    ...text.matchAll(/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com|bilibili\.com|b23\.tv|bili(?:22|23|33|2233)\.cn)\/[^\s<>"'`，。！？、；；（）()【】\[\]]*/gi)
  ].map((match) => {
    const value = match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
    return trimUrl(value);
  });
  const out = [];
  const seen = new Set();
  for (const url of [...urls, ...compactUrls]) {
    if (!isXiaohongshuUrl(url) && !isBilibiliUrl(url)) {
      continue;
    }
    const key = queueKey(url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(url);
  }
  return out;
}

function queueKey(url) {
  const value = String(url || "").trim();
  const noteId = value.match(/[0-9a-f]{24}/i)?.[0];
  if (noteId && isXiaohongshuUrl(value)) {
    return `xhs:${noteId}`;
  }
  const bvid = value.match(/BV[0-9A-Za-z]+/)?.[0];
  if (bvid && isBilibiliUrl(value)) {
    return `bili:${bvid}`;
  }
  return value.replace(/[?#].*$/, "");
}

function countQueueStatus(queue) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const item of Array.isArray(queue) ? queue : []) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) {
      counts[item.status] += 1;
    }
  }
  return counts;
}

function escapeTableCell(value) {
  return String(value || "")
    .replace(/\n/g, " ")
    .replace(/\|/g, "\\|");
}

function trimUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[，。！？、；;,.!?]+$/g, "")
    .replace(/&amp;/g, "&");
}

function isXiaohongshuUrl(url) {
  return /^https?:\/\/(?:(?:www\.)?xiaohongshu\.com|xhslink\.com)\//i.test(String(url || "").trim());
}

function isBilibiliUrl(url) {
  return /^https?:\/\/(?:(www\.)?bilibili\.com\/video\/|b23\.tv\/|bili(?:22|23|33|2233)\.cn\/)/i.test(String(url || "").trim());
}
