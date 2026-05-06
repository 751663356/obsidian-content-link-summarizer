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
const WHISPER_LARGE_V3_PATH = "models/ggml-large-v3.bin";
const WHISPER_LARGE_V3_MIN_BYTES = 2_900_000_000;
const WHISPER_LARGE_V3_URL = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true";

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
    this.isDownloadingWhisperModel = false;

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

  async openBatchQueueReport() {
    await this.writeBatchQueueReport();
    const target = normalizePath("收集箱/内容链接批量导入队列.md");
    const file = this.app.vault.getAbstractFileByPath(target);
    if (file) {
      await this.app.workspace.getLeaf(true).openFile(file);
    } else {
      new Notice(`队列状态已写入：${target}`);
    }
  }

  async downloadWhisperLargeV3() {
    if (this.isDownloadingWhisperModel) {
      new Notice("Whisper large-v3 正在下载中。");
      return;
    }

    const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
    const relativePath = WHISPER_LARGE_V3_PATH;
    const modelPath = path.join(pluginDir, relativePath);
    if (isCompleteWhisperModel(modelPath)) {
      this.settings.localWhisperModelPath = relativePath;
      await this.saveSettings();
      new Notice("Whisper large-v3 已经下载完成。");
      return;
    }

    this.isDownloadingWhisperModel = true;
    const tempPath = `${modelPath}.download`;
    await fs.promises.mkdir(path.dirname(modelPath), { recursive: true });
    new Notice("开始下载 Whisper large-v3，文件接近 3GB，完成前请保持网络连接。");

    const child = childProcess.spawn("curl", [
      "-L",
      "--fail",
      "--continue-at", "-",
      "-o", tempPath,
      WHISPER_LARGE_V3_URL
    ], {
      cwd: pluginDir,
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.on("error", (error) => {
      this.isDownloadingWhisperModel = false;
      console.error(error);
      new Notice(`Whisper large-v3 下载失败：${error.message || error}`);
    });

    child.on("close", async (code) => {
      this.isDownloadingWhisperModel = false;
      if (code !== 0) {
        new Notice(`Whisper large-v3 下载失败：curl 退出码 ${code}`);
        console.error(stderr);
        return;
      }
      try {
        const stat = await fs.promises.stat(tempPath);
        if (stat.size < WHISPER_LARGE_V3_MIN_BYTES) {
          new Notice("Whisper large-v3 下载不完整，请稍后重新点击下载。");
          return;
        }
        await fs.promises.rename(tempPath, modelPath);
        this.settings.localWhisperModelPath = relativePath;
        await this.saveSettings();
        new Notice("Whisper large-v3 下载完成，已切换为本地转写模型。");
      } catch (error) {
        console.error(error);
        new Notice(`Whisper large-v3 保存失败：${error.message || error}`);
      }
    });
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
    containerEl.addClass("content-link-settings");

    const counts = countQueueStatus(this.plugin.settings.batchQueue || []);
    const pluginDir = path.join(this.app.vault.adapter.basePath, this.plugin.manifest.dir);
    const largeV3Path = path.join(pluginDir, WHISPER_LARGE_V3_PATH);
    const hasLargeV3 = isCompleteWhisperModel(largeV3Path);
    const isDownloadingLargeV3 = Boolean(this.plugin.isDownloadingWhisperModel);

    const header = containerEl.createDiv({ cls: "xhs-settings-hero" });
    header.createEl("h2", { text: "内容链接总结" });
    header.createEl("p", {
      text: "把小红书和 B 站链接整理成 Obsidian 笔记，支持批量队列、视频转写、图片理解和自动分类。"
    });

    const overview = containerEl.createDiv({ cls: "xhs-settings-overview" });
    this.createStat(overview, "待处理", String(counts.pending));
    this.createStat(overview, "已完成", String(counts.done));
    this.createStat(overview, "失败", String(counts.failed));
    this.createStat(overview, "Whisper", hasLargeV3 ? "large-v3" : isDownloadingLargeV3 ? "下载中" : "未下载");

    const quickActions = containerEl.createDiv({ cls: "xhs-settings-actions" });
    new Setting(quickActions)
      .addButton((button) => button
        .setButtonText("批量导入")
        .setCta()
        .onClick(() => new BatchUrlModal(this.app, this.plugin).open()))
      .addButton((button) => button
        .setButtonText("继续队列")
        .onClick(async () => this.plugin.processBatchQueue()))
      .addButton((button) => button
        .setButtonText("打开队列状态")
        .onClick(async () => this.plugin.openBatchQueueReport()));

    const storageSection = this.createSection(containerEl, "保存与分类", "控制笔记保存位置和自动分类候选。");

    new Setting(storageSection)
      .setName("小红书笔记文件夹")
      .setDesc("生成的笔记会再按分类放到子文件夹。")
      .addText((text) => text
        .setPlaceholder("笔记/小红书")
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(storageSection)
      .setName("B 站笔记文件夹")
      .setDesc("生成的笔记会再按分类放到子文件夹。")
      .addText((text) => text
        .setPlaceholder("笔记/B站")
        .setValue(this.plugin.settings.bilibiliOutputFolder || DEFAULT_SETTINGS.bilibiliOutputFolder)
        .onChange(async (value) => {
          this.plugin.settings.bilibiliOutputFolder = value.trim() || DEFAULT_SETTINGS.bilibiliOutputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(storageSection)
      .setName("分类候选")
      .setDesc("一行一个。留空时使用默认大类；AI 只会从这里选择。")
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text
          .setPlaceholder(DEFAULT_NOTE_CATEGORIES.join("\n"))
          .setValue(getNoteCategories(this.plugin.settings).join("\n"))
          .onChange(async (value) => {
            const categories = parseCategories(value);
            this.plugin.settings.noteCategories = categories;
            await this.plugin.saveSettings();
          });
      });

    const aiSection = this.createSection(containerEl, "AI 总结与图文理解", "配置 OpenAI 兼容接口。图文理解 Key 留空时复用总结 Key。");

    new Setting(aiSection)
      .setName("总结 API Key")
      .setDesc("用于调用 GLM-5.1 等模型生成总结。")
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

    new Setting(aiSection)
      .setName("总结 API 地址")
      .addText((text) => text
        .setPlaceholder("https://api.z.ai/api/paas/v4")
        .setValue(this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.summaryApiBaseUrl = value.trim() || DEFAULT_SETTINGS.summaryApiBaseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("总结模型")
      .addText((text) => text
        .setPlaceholder("glm-5.1")
        .setValue(this.plugin.settings.summaryModel)
        .onChange(async (value) => {
          this.plugin.settings.summaryModel = value.trim() || DEFAULT_SETTINGS.summaryModel;
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("启用图文理解")
      .setDesc("纯图片笔记会先交给视觉模型识别文字；失败时回退到本地 OCR。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useVisionModel !== false)
        .onChange(async (value) => {
          this.plugin.settings.useVisionModel = value;
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("图文理解 API Key")
      .setDesc("留空时复用总结 API Key。")
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

    new Setting(aiSection)
      .setName("图文理解 API 地址")
      .addText((text) => text
        .setPlaceholder("https://api.z.ai/api/paas/v4")
        .setValue(this.plugin.settings.visionApiBaseUrl || this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.visionApiBaseUrl = value.trim() || DEFAULT_SETTINGS.visionApiBaseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("图文理解模型")
      .addText((text) => text
        .setPlaceholder("glm-5v-turbo")
        .setValue(this.plugin.settings.visionModel || DEFAULT_SETTINGS.visionModel)
        .onChange(async (value) => {
          this.plugin.settings.visionModel = value.trim() || DEFAULT_SETTINGS.visionModel;
          await this.plugin.saveSettings();
        }));

    const mediaSection = this.createSection(containerEl, "转写与媒体", "控制视频下载、本地转写和浏览器登录态。");

    new Setting(mediaSection)
      .setName("转写模型")
      .setDesc("只在额外配置 OpenAI 音频转写时使用；默认走本地 Whisper。")
      .addText((text) => text
        .setPlaceholder("gpt-4o-mini-transcribe")
        .setValue(this.plugin.settings.transcriptionModel)
        .onChange(async (value) => {
          this.plugin.settings.transcriptionModel = value.trim() || DEFAULT_SETTINGS.transcriptionModel;
          await this.plugin.saveSettings();
        }));

    new Setting(mediaSection)
      .setName("本地 Whisper 模型")
      .setDesc("相对插件目录或绝对路径。准确优先建议 large-v3。")
      .addText((text) => text
        .setPlaceholder("models/ggml-large-v3.bin")
        .setValue(this.plugin.settings.localWhisperModelPath)
        .onChange(async (value) => {
          this.plugin.settings.localWhisperModelPath = value.trim() || DEFAULT_SETTINGS.localWhisperModelPath;
          await this.plugin.saveSettings();
        }));

    new Setting(mediaSection)
      .setName("Whisper large-v3 模型")
      .setDesc(hasLargeV3
        ? "large-v3 已下载完成。"
        : isDownloadingLargeV3
          ? "large-v3 正在下载中，请保持网络连接。"
          : "下载准确优先的本地转写模型，约 3GB。模型只保存在本机，不会上传到 GitHub。")
      .addButton((button) => button
        .setButtonText(hasLargeV3 ? "已下载" : isDownloadingLargeV3 ? "下载中" : "下载 large-v3")
        .setDisabled(hasLargeV3 || isDownloadingLargeV3)
        .onClick(async () => {
          await this.plugin.downloadWhisperLargeV3();
          this.display();
        }));

    new Setting(mediaSection)
      .setName("读取浏览器登录态")
      .setDesc("下载视频时让 yt-dlp 尝试使用 Chrome Cookie。插件不会保存小红书账号密码。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.tryBrowserCookies)
        .onChange(async (value) => {
          this.plugin.settings.tryBrowserCookies = value;
          await this.plugin.saveSettings();
        }));

    new Setting(mediaSection)
      .setName("下载并转写视频")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.downloadVideo)
        .onChange(async (value) => {
          this.plugin.settings.downloadVideo = value;
          await this.plugin.saveSettings();
        }));

    const advancedSection = this.createSection(containerEl, "高级", "通常不用改；只有 Obsidian 找不到 Node 时才需要调整。");

    new Setting(advancedSection)
      .setName("Node 路径")
      .setDesc("可填 /opt/homebrew/bin/node 或 /usr/local/bin/node。")
      .addText((text) => text
        .setPlaceholder("node")
        .setValue(this.plugin.settings.nodePath)
        .onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || DEFAULT_SETTINGS.nodePath;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("p", {
      cls: "xhs-summarizer-muted xhs-summarizer-setting-warning",
      text: "不要把小红书账号密码填到这里。需要登录时，请在浏览器中手动登录。"
    });
  }

  createSection(containerEl, title, description) {
    const section = containerEl.createDiv({ cls: "xhs-settings-section" });
    section.createEl("h3", { text: title });
    if (description) {
      section.createEl("p", {
        cls: "xhs-summarizer-muted xhs-settings-section-desc",
        text: description
      });
    }
    return section;
  }

  createStat(containerEl, label, value) {
    const stat = containerEl.createDiv({ cls: "xhs-settings-stat" });
    stat.createEl("span", { cls: "xhs-settings-stat-label", text: label });
    stat.createEl("strong", { text: value });
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

function isCompleteWhisperModel(modelPath) {
  try {
    return fs.existsSync(modelPath) && fs.statSync(modelPath).size >= WHISPER_LARGE_V3_MIN_BYTES;
  } catch {
    return false;
  }
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
