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
  nodePath: "node",
  openaiApiKey: "",
  summaryApiKey: "",
  summaryApiBaseUrl: "",
  summaryModel: "",
  visionApiKey: "",
  visionApiBaseUrl: "",
  visionModel: "",
  useVisionModel: true,
  transcriptionModel: "",
  localWhisperModelPath: "models/ggml-small.bin",
  noteCategories: [],
  tryBrowserCookies: true,
  downloadVideo: true
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
const WHISPER_SMALL_PATH = "models/ggml-small.bin";
const WHISPER_SMALL_MIN_BYTES = 450_000_000;
const WHISPER_SMALL_URL = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true";
const IS_WINDOWS = process.platform === "win32";
const PLATFORM_NAME = IS_WINDOWS ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform;
const IMPORT_MODAL_COPY = {
  title: "导入到 Obsidian",
  description: "粘贴一条小红书或 B 站链接，网页链接和 App 分享链接都可以。插件主打视频/字幕转录，再整理成 Obsidian 笔记。",
  placeholder: "粘贴小红书或 B 站链接，例如 http://xhslink.com/..."
};
module.exports = class XiaohongshuSummarizerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.noteCategories)) {
      this.settings.noteCategories = [];
    }
    this.isDownloadingWhisperModel = false;
    this.isCheckingDependencies = false;
    this.isInstallingPythonDeps = false;
    this.isInstallingSystemDeps = false;
    this.isInstallingAllDeps = false;
    this.isCheckingCookieAccess = false;
    this.dependencyStatus = null;

    this.addCommand({
      id: "import-content-url",
      name: "转录链接并整理",
      callback: () => new UrlModal(this.app, this, IMPORT_MODAL_COPY, "", async (url) => this.importAnyUrl(url)).open()
    });

    this.addCommand({
      id: "import-content-url-from-clipboard",
      name: "从剪贴板转录链接并整理",
      callback: async () => {
        const url = await navigator.clipboard.readText();
        new UrlModal(this.app, this, {
          ...IMPORT_MODAL_COPY,
          title: "从剪贴板导入"
        }, url.trim(), async (value) => this.importAnyUrl(value)).open();
      }
    });

    this.addSettingTab(new XiaohongshuSummarizerSettingTab(this.app, this));
    void this.refreshDependencyStatus().catch((error) => console.error(error));
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
    new Notice("没有识别到小红书或 B 站链接。请粘贴网页链接或 App 分享链接。");
  }

  async importUrl(rawUrl) {
    const url = extractSupportedUrl(rawUrl);
    if (!isXiaohongshuUrl(url)) {
      new Notice("请粘贴有效的小红书网页链接或 App 分享链接。");
      return;
    }

    new Notice("正在提取小红书内容，视频转录可能需要一会儿。");

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
      new Notice("请粘贴有效的 B 站网页链接或 App 分享链接。");
      return;
    }

    new Notice("正在转录 B 站视频内容；有字幕优先用字幕，没有字幕再转录音频。");

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

  async downloadWhisperSmall() {
    if (this.isDownloadingWhisperModel) {
      new Notice("Whisper small 正在下载中。");
      return;
    }

    const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
    const relativePath = WHISPER_SMALL_PATH;
    const modelPath = path.join(pluginDir, relativePath);
    if (isCompleteWhisperModel(modelPath)) {
      this.settings.localWhisperModelPath = relativePath;
      await this.saveSettings();
      new Notice("Whisper small 已经下载完成。");
      return;
    }

    this.isDownloadingWhisperModel = true;
    const tempPath = `${modelPath}.download`;
    await fs.promises.mkdir(path.dirname(modelPath), { recursive: true });
    new Notice("开始下载 Whisper small，文件接近 500MB，完成前请保持网络连接。");

    const child = childProcess.spawn("curl", [
      "-L",
      "--fail",
      "--continue-at", "-",
      "-o", tempPath,
      WHISPER_SMALL_URL
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
      new Notice(`Whisper small 下载失败：${error.message || error}`);
    });

    child.on("close", async (code) => {
      this.isDownloadingWhisperModel = false;
      if (code !== 0) {
        new Notice(`Whisper small 下载失败：curl 退出码 ${code}`);
        console.error(stderr);
        return;
      }
      try {
        const stat = await fs.promises.stat(tempPath);
        if (stat.size < WHISPER_SMALL_MIN_BYTES) {
          new Notice("Whisper small 下载不完整，请稍后重新点击下载。");
          return;
        }
        await fs.promises.rename(tempPath, modelPath);
        this.settings.localWhisperModelPath = relativePath;
        await this.saveSettings();
        new Notice("Whisper small 下载完成，已切换为本地转录模型。");
      } catch (error) {
        console.error(error);
        new Notice(`Whisper small 保存失败：${error.message || error}`);
      }
    });
  }

  async refreshDependencyStatus() {
    if (this.isCheckingDependencies) {
      return this.dependencyStatus;
    }

    this.isCheckingDependencies = true;
    try {
      const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
      const pythonPath = getVenvPythonPath(pluginDir);
      const [packageManagerInfo, nodeInfo, ffmpegInfo, whisperInfo, tesseractInfo] = await Promise.all([
        probeCommand(getPackageManagerCandidates(), ["--version"]),
        probeCommand(getNodeCandidates(this.settings.nodePath), ["--version"]),
        probeCommand(getFfmpegCandidates(pluginDir), ["-version"]),
        probeWhisperCommand(pluginDir),
        probeCommand(getTesseractCandidates(), ["--version"])
      ]);
      const pythonVenvReady = fs.existsSync(pythonPath);
      const pythonDepsReady = pythonVenvReady
        ? await probePythonModules(pythonPath, ["yt_dlp", "PIL", "rapidocr_onnxruntime"])
        : false;

      this.dependencyStatus = {
        checkedAt: new Date().toISOString(),
        brewReady: packageManagerInfo.ok,
        packageManagerReady: packageManagerInfo.ok,
        nodeReady: nodeInfo.ok,
        pythonVenvReady,
        pythonDepsReady,
        ffmpegReady: ffmpegInfo.ok,
        whisperReady: whisperInfo.ok,
        tesseractReady: tesseractInfo.ok
      };
      return this.dependencyStatus;
    } finally {
      this.isCheckingDependencies = false;
    }
  }

  async installPythonDependencies(options = {}) {
    if (this.isInstallingPythonDeps || (!options.internal && this.isInstallingAllDeps)) {
      new Notice("Python 依赖正在安装中。");
      return;
    }

    this.isInstallingPythonDeps = true;
    new Notice("开始安装 Python 依赖，首次安装可能需要 1-3 分钟。");
    try {
      const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
      const pythonBootstrap = await resolvePythonBootstrap();
      await runCommand(pythonBootstrap.command, [...pythonBootstrap.args, "-m", "venv", ".venv"], { cwd: pluginDir, timeoutMs: 1000 * 60 * 10 });
      const venvPython = getVenvPythonPath(pluginDir);
      await runCommand(venvPython, ["-m", "pip", "install", "-U", "pip"], { cwd: pluginDir, timeoutMs: 1000 * 60 * 20 });
      await runCommand(venvPython, ["-m", "pip", "install", "-U", "-r", "requirements.txt"], { cwd: pluginDir, timeoutMs: 1000 * 60 * 30 });
      await this.refreshDependencyStatus();
      new Notice("Python 依赖安装完成。");
      return true;
    } catch (error) {
      console.error(error);
      new Notice(`Python 依赖安装失败：${error.message || error}`);
      return false;
    } finally {
      this.isInstallingPythonDeps = false;
    }
  }

  async installSystemDependencies(options = {}) {
    if (this.isInstallingSystemDeps || (!options.internal && this.isInstallingAllDeps)) {
      new Notice("系统依赖正在安装中。");
      return;
    }

    this.isInstallingSystemDeps = true;
    new Notice(IS_WINDOWS ? "开始安装 Windows 系统依赖，winget 可能会运行几分钟。" : "开始安装 macOS 系统依赖，Homebrew 可能会运行几分钟。");
    try {
      if (IS_WINDOWS) {
        const winget = await resolveAvailableCommand(["winget"], ["--version"]);
        await installWingetPackage(winget, "OpenJS.NodeJS.LTS");
        await installWingetPackage(winget, "Python.Python.3.13").catch(async () => installWingetPackage(winget, "Python.Python.3.12"));
        await installWingetPackage(winget, "Gyan.FFmpeg");
        await installWingetPackage(winget, "UB-Mannheim.TesseractOCR");
      } else {
        const brew = await resolveAvailableCommand(["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"], ["--version"]);
        await runCommand(brew, ["install", "node", "ffmpeg", "whisper-cpp", "tesseract"], { timeoutMs: 1000 * 60 * 45 });
      }
      await this.refreshDependencyStatus();
      new Notice("系统依赖安装完成。");
      return true;
    } catch (error) {
      console.error(error);
      new Notice(`系统依赖安装失败：${error.message || error}`);
      return false;
    } finally {
      this.isInstallingSystemDeps = false;
    }
  }

  async installAllDependencies() {
    if (this.isInstallingAllDeps) {
      new Notice("依赖安装正在进行中。");
      return;
    }

    this.isInstallingAllDeps = true;
    try {
      const systemOk = await this.installSystemDependencies({ internal: true });
      const pythonOk = systemOk ? await this.installPythonDependencies({ internal: true }) : false;
      await this.refreshDependencyStatus();
      if (systemOk && pythonOk) {
        new Notice("基础依赖已经准备好，可以继续下载 Whisper small。");
      } else {
        new Notice("依赖安装没有全部完成，请先看上面的提示。");
      }
    } finally {
      this.isInstallingAllDeps = false;
    }
  }

  async checkCookieAccess() {
    if (this.isCheckingCookieAccess) {
      new Notice("正在检查浏览器登录态。");
      return false;
    }

    this.isCheckingCookieAccess = true;
    try {
      const pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
      const python = getVenvPythonPath(pluginDir);
      if (!fs.existsSync(python)) {
        new Notice("还没有 Python 环境，请先在环境与安装里点击一键安装。");
        return false;
      }

      await runCommand(python, [
        "-m", "yt_dlp",
        "--cookies-from-browser", "chrome",
        "--simulate",
        "--skip-download",
        "https://www.bilibili.com"
      ], {
        cwd: pluginDir,
        timeoutMs: 1000 * 60
      });
      new Notice("Chrome 登录态读取检查通过。插件不会保存 Cookie 内容。");
      return true;
    } catch (error) {
      console.error(error);
      new Notice("登录态检查失败：请确认 Chrome 已登录目标平台，并关闭可能占用 Cookie 数据库的浏览器窗口后再试。");
      return false;
    } finally {
      this.isCheckingCookieAccess = false;
    }
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
      title: "导入到 Obsidian",
      description: "粘贴一条内容链接，插件会整理成 Obsidian 笔记。",
      placeholder: "粘贴小红书或 B 站链接",
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

class XiaohongshuSummarizerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("content-link-settings");
    if (!this.plugin.dependencyStatus && !this.plugin.isCheckingDependencies) {
      void this.plugin.refreshDependencyStatus().then(() => {
        if (this.containerEl.isConnected) {
          this.display();
        }
      }).catch((error) => console.error(error));
    }

    const pluginDir = path.join(this.app.vault.adapter.basePath, this.plugin.manifest.dir);
    const whisperSmallPath = path.join(pluginDir, WHISPER_SMALL_PATH);
    const hasWhisperSmall = isCompleteWhisperModel(whisperSmallPath);
    const isDownloadingWhisperSmall = Boolean(this.plugin.isDownloadingWhisperModel);
    const dependencyStatus = this.plugin.dependencyStatus || createDefaultDependencyStatus();
    const apiReady = Boolean(this.plugin.settings.summaryApiKey && this.plugin.settings.summaryApiBaseUrl && this.plugin.settings.summaryModel);
    const coreReady = dependencyStatus.ffmpegReady && dependencyStatus.whisperReady && dependencyStatus.pythonDepsReady;

    const header = containerEl.createDiv({ cls: "xhs-settings-hero" });
    header.createEl("h2", { text: "内容链接总结" });
    header.createEl("p", {
      text: "把你主动分享的小红书和 B 站链接整理成 Obsidian 知识卡片：摘要、要点、行动清单和自动分类。"
    });

    const overview = containerEl.createDiv({ cls: "xhs-settings-overview" });
    this.createStat(overview, "基础依赖", coreReady ? "已就绪" : "待安装");
    this.createStat(overview, "Whisper", hasWhisperSmall ? "small" : isDownloadingWhisperSmall ? "下载中" : "未下载");
    this.createStat(overview, "AI 总结", apiReady ? "已配置" : "未配置");
    this.createStat(overview, "图文理解", this.plugin.settings.useVisionModel !== false ? "已开启" : "已关闭");

    const quickActions = containerEl.createDiv({ cls: "xhs-settings-actions" });
    new Setting(quickActions)
      .addButton((button) => button
        .setButtonText("导入链接")
        .setCta()
        .onClick(() => new UrlModal(this.app, this.plugin, IMPORT_MODAL_COPY, "", async (url) => this.plugin.importAnyUrl(url)).open()))
      .addButton((button) => button
        .setButtonText("剪贴板导入")
        .onClick(async () => {
          const url = await navigator.clipboard.readText();
          new UrlModal(this.app, this.plugin, {
            ...IMPORT_MODAL_COPY,
            title: "从剪贴板导入"
          }, url.trim(), async (value) => this.plugin.importAnyUrl(value)).open();
        }))
      .addButton((button) => button
        .setButtonText(this.plugin.isCheckingDependencies ? "检查中" : "检查环境")
        .setDisabled(this.plugin.isCheckingDependencies)
        .onClick(async () => {
          await this.plugin.refreshDependencyStatus();
          this.display();
        }));

    const startSection = this.createSection(containerEl, "快速开始", "第一次使用按这个顺序走，基本不用碰终端。");
    startSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "1. 先点“一键安装”把本地依赖装好。"
    });
    startSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "2. 如果要做视频转录，再点“下载 small”。"
    });
    startSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "3. 在 Chrome 登录小红书或 B 站，再点击“检查登录态”。"
    });
    startSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "4. 如果要 AI 总结或图文理解，再填写 API Key、地址和模型。"
    });
    startSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "5. 最后用上面的“导入链接”开始整理内容。"
    });

    const setupSection = this.createSection(containerEl, "环境与安装", `当前系统：${PLATFORM_NAME}。插件会尽量自己准备本地依赖；macOS 使用 Homebrew，Windows 使用 winget，Python 依赖装进插件目录自己的 .venv。`);
    const dependencyGrid = setupSection.createDiv({ cls: "xhs-dependency-grid" });
    this.createDependencyBadge(dependencyGrid, IS_WINDOWS ? "winget" : "Homebrew", dependencyStatus.packageManagerReady ?? dependencyStatus.brewReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "Node.js", dependencyStatus.nodeReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "Python 环境", dependencyStatus.pythonVenvReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "Python 依赖", dependencyStatus.pythonDepsReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "ffmpeg", dependencyStatus.ffmpegReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "whisper-cpp", dependencyStatus.whisperReady, this.plugin.isCheckingDependencies);
    this.createDependencyBadge(dependencyGrid, "tesseract", dependencyStatus.tesseractReady, this.plugin.isCheckingDependencies);

    new Setting(setupSection)
      .setName("一键准备基础依赖")
      .setDesc("按顺序安装系统依赖和插件自己的 Python 依赖。macOS/Windows 第一次使用都可以先点这里。")
      .addButton((button) => button
        .setButtonText(this.plugin.isInstallingAllDeps ? "安装中" : "一键安装")
        .setCta()
        .setDisabled(this.plugin.isInstallingAllDeps || this.plugin.isInstallingPythonDeps || this.plugin.isInstallingSystemDeps)
        .onClick(async () => {
          await this.plugin.installAllDependencies();
          this.display();
        }))
      .addButton((button) => button
        .setButtonText(this.plugin.isCheckingDependencies ? "检查中" : "重新检查")
        .setDisabled(this.plugin.isCheckingDependencies || this.plugin.isInstallingAllDeps)
        .onClick(async () => {
          await this.plugin.refreshDependencyStatus();
          this.display();
        }));

    new Setting(setupSection)
      .setName("Python 依赖")
      .setDesc("安装 `yt-dlp`、`rapidocr_onnxruntime`、`pillow`、`whisper.cpp-cli` 到插件目录的 `.venv`。")
      .addButton((button) => button
        .setButtonText(this.plugin.isInstallingPythonDeps ? "安装中" : "安装 Python 依赖")
        .setDisabled(this.plugin.isInstallingPythonDeps || this.plugin.isInstallingAllDeps)
        .onClick(async () => {
          await this.plugin.installPythonDependencies();
          this.display();
        }));

    new Setting(setupSection)
      .setName("系统依赖")
      .setDesc(IS_WINDOWS ? "使用 winget 安装 Node.js、Python、ffmpeg、Tesseract。Whisper 转录优先使用 Python 依赖里的 whisper.cpp-cli。" : "使用 Homebrew 安装 Node.js、ffmpeg、whisper-cpp、tesseract。")
      .addButton((button) => button
        .setButtonText(this.plugin.isInstallingSystemDeps ? "安装中" : "安装系统依赖")
        .setDisabled(this.plugin.isInstallingSystemDeps || this.plugin.isInstallingAllDeps)
        .onClick(async () => {
          await this.plugin.installSystemDependencies();
          this.display();
        }));

    const mediaSection = this.createSection(containerEl, "转录与媒体", "控制本地 Whisper 转录和媒体处理方式。");

    new Setting(mediaSection)
      .setName("Whisper small 模型")
      .setDesc(hasWhisperSmall
        ? "small 已下载完成。"
        : isDownloadingWhisperSmall
          ? "small 正在下载中，请保持网络连接。"
          : "下载更轻量的本地转录模型，约 500MB。模型只保存在本机，不会上传到 GitHub。")
      .addButton((button) => button
        .setButtonText(hasWhisperSmall ? "已下载" : isDownloadingWhisperSmall ? "下载中" : "下载 small")
        .setDisabled(hasWhisperSmall || isDownloadingWhisperSmall)
        .onClick(async () => {
          await this.plugin.downloadWhisperSmall();
          this.display();
        }));

    new Setting(mediaSection)
      .setName("本地 Whisper 模型")
      .setDesc("相对插件目录或绝对路径。默认使用 Whisper small。")
      .addText((text) => text
        .setPlaceholder("models/ggml-small.bin")
        .setValue(this.plugin.settings.localWhisperModelPath)
        .onChange(async (value) => {
          this.plugin.settings.localWhisperModelPath = value.trim() || DEFAULT_SETTINGS.localWhisperModelPath;
          await this.plugin.saveSettings();
        }));

    new Setting(mediaSection)
      .setName("转录模型")
      .setDesc("只在额外配置云端音频转录时使用。留空则使用本地转录。")
      .addText((text) => text
        .setPlaceholder("填写你的转录模型名称")
        .setValue(this.plugin.settings.transcriptionModel)
        .onChange(async (value) => {
          this.plugin.settings.transcriptionModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(mediaSection)
      .setName("启用音视频转录")
      .setDesc("开启后会为你主动导入的单条链接做字幕/音频转录，用于生成摘要；B 站临时音频会在转录后删除。关闭后只整理网页正文和图片文字。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.downloadVideo)
        .onChange(async (value) => {
          this.plugin.settings.downloadVideo = value;
          await this.plugin.saveSettings();
        }));

    const cookieSection = this.createSection(containerEl, "登录态（推荐开启）", "这是小红书和 B 站整理体验最完整的方式：你只需要在 Chrome 正常登录，插件临时读取本机登录态来访问你已经能看的内容。插件不会保存 Cookie，也不会要求你粘贴 Cookie。");
    cookieSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "1. 用 Chrome 打开小红书或 B 站，并确认已经登录。"
    });
    cookieSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "2. 回到这里开启“临时读取 Chrome 登录态”。"
    });
    cookieSection.createEl("p", {
      cls: "xhs-settings-step",
      text: "3. 点击“检查登录态”，通过后直接粘贴链接导入。"
    });

    new Setting(cookieSection)
      .setName("推荐开启：临时读取 Chrome 登录态")
      .setDesc("开启后，本机工具会临时读取 Chrome Cookie，用于访问你已登录后可看的内容。插件不保存 Cookie 内容。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.tryBrowserCookies)
        .onChange(async (value) => {
          this.plugin.settings.tryBrowserCookies = value;
          await this.plugin.saveSettings();
        }));

    new Setting(cookieSection)
      .setName("检查登录态")
      .setDesc("只检查本机工具是否能读取 Chrome 登录态，不会把 Cookie 写入插件配置。第一次使用建议先检查一次。")
      .addButton((button) => button
        .setButtonText(this.plugin.isCheckingCookieAccess ? "检查中" : "检查登录态")
        .setDisabled(this.plugin.isCheckingCookieAccess)
        .onClick(async () => {
          await this.plugin.checkCookieAccess();
          this.display();
        }));

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

    const aiSection = this.createSection(containerEl, "AI 总结与图文理解", "配置兼容 chat/completions 的接口。图文理解 Key 留空时复用总结 Key。");

    new Setting(aiSection)
      .setName("总结 API Key")
      .setDesc("用于调用你自己配置的总结接口。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API Key")
          .setValue(this.plugin.settings.summaryApiKey || this.plugin.settings.openaiApiKey || "")
          .onChange(async (value) => {
            this.plugin.settings.summaryApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(aiSection)
      .setName("总结 API 地址")
      .addText((text) => text
        .setPlaceholder("https://example.com/v1")
        .setValue(this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.summaryApiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("总结模型")
      .addText((text) => text
        .setPlaceholder("填写你的模型名称")
        .setValue(this.plugin.settings.summaryModel)
        .onChange(async (value) => {
          this.plugin.settings.summaryModel = value.trim();
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
        .setPlaceholder("默认复用总结 API 地址")
        .setValue(this.plugin.settings.visionApiBaseUrl || this.plugin.settings.summaryApiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.visionApiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(aiSection)
      .setName("图文理解模型")
      .addText((text) => text
        .setPlaceholder("填写你的视觉模型名称")
        .setValue(this.plugin.settings.visionModel || "")
        .onChange(async (value) => {
          this.plugin.settings.visionModel = value.trim();
          await this.plugin.saveSettings();
        }));

    const advancedSection = this.createSection(containerEl, "高级", "通常不用改；只有 Obsidian 找不到 Node 时才需要调整。");

    new Setting(advancedSection)
      .setName("Node 路径")
      .setDesc(IS_WINDOWS ? "通常填 node。若找不到，可填 C:\\Program Files\\nodejs\\node.exe。" : "通常填 node。若找不到，可填 /opt/homebrew/bin/node 或 /usr/local/bin/node。")
      .addText((text) => text
        .setPlaceholder("node")
        .setValue(this.plugin.settings.nodePath)
        .onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || DEFAULT_SETTINGS.nodePath;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("p", {
      cls: "xhs-summarizer-muted xhs-summarizer-setting-warning",
      text: "免责声明：本插件主打单条链接的转录和个人知识整理，仅用于个人学习、研究和复盘。请只导入你有权访问和整理的内容，不要用于批量抓取、转载、搬运、传播原始视频/音频/图片/字幕或任何侵犯他人权益的用途。使用时请自行遵守小红书、B 站等平台规则和相关法律法规。插件不会保存小红书账号密码；需要登录时，请在浏览器中手动登录。"
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

  createDependencyBadge(containerEl, label, ready, checking) {
    const badge = containerEl.createDiv({ cls: `xhs-dependency-badge ${ready ? "is-ready" : "is-missing"}` });
    badge.createEl("span", { cls: "xhs-dependency-badge-label", text: label });
    badge.createEl("strong", { text: checking ? "检查中" : ready ? "已就绪" : "未就绪" });
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

function createDefaultDependencyStatus() {
  return {
    checkedAt: "",
    brewReady: false,
    packageManagerReady: false,
    nodeReady: false,
    pythonVenvReady: false,
    pythonDepsReady: false,
    ffmpegReady: false,
    whisperReady: false,
    tesseractReady: false
  };
}

function getVenvPythonPath(pluginDir) {
  return IS_WINDOWS
    ? path.join(pluginDir, ".venv", "Scripts", "python.exe")
    : path.join(pluginDir, ".venv", "bin", "python");
}

function getPackageManagerCandidates() {
  return IS_WINDOWS ? ["winget"] : ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"];
}

function getNodeCandidates(configuredNodePath) {
  const candidates = [];
  if (configuredNodePath) {
    candidates.push(configuredNodePath);
  }
  if (IS_WINDOWS) {
    candidates.push("node.exe", "node", "C:\\Program Files\\nodejs\\node.exe");
  } else {
    candidates.push("node", "/opt/homebrew/bin/node", "/usr/local/bin/node");
  }
  return [...new Set(candidates)];
}

function getFfmpegCandidates() {
  return IS_WINDOWS
    ? ["ffmpeg.exe", "ffmpeg"]
    : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];
}

function getTesseractCandidates() {
  return IS_WINDOWS
    ? ["tesseract.exe", "tesseract", "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"]
    : ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "tesseract"];
}

function getWhisperCandidates(pluginDir) {
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: Object.assign({}, process.env, options.env || {}),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`命令执行超时：${command}`));
      }, options.timeoutMs)
      : null;

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
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `命令退出码 ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probeCommand(candidates, args) {
  for (const candidate of candidates) {
    if (looksLikeAbsolutePath(candidate) && !fs.existsSync(candidate)) {
      continue;
    }
    try {
      await runCommand(candidate, args, { timeoutMs: 15000 });
      return { ok: true, command: candidate };
    } catch {
      // Try next candidate.
    }
  }
  return { ok: false, command: "" };
}

async function probeWhisperCommand(pluginDir) {
  for (const candidate of getWhisperCandidates(pluginDir)) {
    if (looksLikeAbsolutePath(candidate) && !fs.existsSync(candidate)) {
      continue;
    }
    try {
      await runCommand(candidate, ["--help"], { timeoutMs: 15000 });
      return { ok: true, command: candidate };
    } catch {
      // Try next candidate.
    }
  }
  return { ok: false, command: "" };
}

async function resolveAvailableCommand(candidates, args) {
  const result = await probeCommand(candidates, args);
  if (!result.ok) {
    throw new Error(`缺少可用命令：${candidates.join(" / ")}`);
  }
  return result.command;
}

async function resolvePythonBootstrap() {
  const candidates = IS_WINDOWS
    ? [
      { command: "python", args: [] },
      { command: "py", args: ["-3"] }
    ]
    : [
      { command: "/usr/bin/python3", args: [] },
      { command: "/opt/homebrew/bin/python3", args: [] },
      { command: "/usr/local/bin/python3", args: [] },
      { command: "python3", args: [] },
      { command: "python", args: [] }
    ];
  for (const candidate of candidates) {
    if (looksLikeAbsolutePath(candidate.command) && !fs.existsSync(candidate.command)) {
      continue;
    }
    try {
      await runCommand(candidate.command, [...candidate.args, "--version"], { timeoutMs: 15000 });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(IS_WINDOWS ? "缺少 Python。请先安装 Python，或在设置页点击安装系统依赖。" : "缺少 Python 3。");
}

async function installWingetPackage(winget, packageId) {
  await runCommand(winget, [
    "install",
    "--id", packageId,
    "--exact",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements"
  ], { timeoutMs: 1000 * 60 * 45 });
}

async function probePythonModules(pythonPath, modules) {
  try {
    const code = modules.map((name) => `import ${name}`).join("\n");
    await runCommand(pythonPath, ["-c", code], { timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}

function looksLikeAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

function isCompleteWhisperModel(modelPath) {
  try {
    return fs.existsSync(modelPath) && fs.statSync(modelPath).size >= WHISPER_SMALL_MIN_BYTES;
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
