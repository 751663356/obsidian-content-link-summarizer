param(
  [string]$VaultPath = ""
)

$ErrorActionPreference = "Stop"
$RepoZipUrl = $env:CONTENT_LINK_SUMMARIZER_ZIP_URL
if ([string]::IsNullOrWhiteSpace($RepoZipUrl)) {
  $RepoZipUrl = "https://github.com/751663356/obsidian-content-link-summarizer/archive/refs/heads/main.zip"
}
$PluginId = "xiaohongshu-summarizer"

function Say($Text) {
  Write-Host ""
  Write-Host $Text
}

function Fail($Text) {
  Write-Host ""
  Write-Error "安装失败：$Text"
  exit 1
}

Say "内容链接总结 Obsidian 插件安装器"

if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  Write-Host "请粘贴你的 Obsidian 仓库路径。"
  Write-Host "例如：C:\Users\Ian\Documents\Obsidian\IanVault"
  $VaultPath = Read-Host "仓库路径"
}

$VaultPath = $VaultPath.Trim('"').Trim()
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  Fail "仓库路径不能为空。"
}

if (!(Test-Path -LiteralPath $VaultPath -PathType Container)) {
  Fail "这个路径不存在：$VaultPath"
}

$PluginDir = Join-Path $VaultPath ".obsidian\plugins\$PluginId"
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("content-link-summarizer-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
  Say "正在下载插件..."
  $ZipPath = Join-Path $TmpDir "plugin.zip"
  Invoke-WebRequest -Uri $RepoZipUrl -OutFile $ZipPath
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $TmpDir -Force

  $SourceDir = Get-ChildItem -LiteralPath $TmpDir -Directory |
    Where-Object { $_.Name -like "obsidian-content-link-summarizer-*" } |
    Select-Object -First 1

  if ($null -eq $SourceDir) {
    Fail "没有在下载包里找到插件目录。"
  }

  Say "正在安装到 Obsidian..."
  New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
  $ScriptsDir = Join-Path $PluginDir "scripts"
  if (Test-Path -LiteralPath $ScriptsDir) {
    Remove-Item -LiteralPath $ScriptsDir -Recurse -Force
  }

  $Items = @(
    "manifest.json",
    "main.js",
    "styles.css",
    "README.md",
    "requirements.txt",
    "package.json",
    "data.example.json",
    "install.sh",
    "install.ps1",
    "scripts"
  )

  foreach ($Item in $Items) {
    $Source = Join-Path $SourceDir.FullName $Item
    if (Test-Path -LiteralPath $Source) {
      Copy-Item -LiteralPath $Source -Destination $PluginDir -Recurse -Force
    }
  }

  Say "安装完成。"
  Write-Host "插件位置：$PluginDir"
  Write-Host ""
  Write-Host "下一步："
  Write-Host "1. 打开 Obsidian 设置 -> 第三方插件。"
  Write-Host "2. 关闭安全模式后启用「内容链接总结」。"
  Write-Host "3. 打开插件设置页，点击「一键安装」准备本地依赖。"
  Write-Host "4. 需要视频转录时，再点击「下载 small」。"
  Write-Host "5. 用 Chrome 登录小红书或 B 站，然后点击「检查登录态」。"
} finally {
  if (Test-Path -LiteralPath $TmpDir) {
    Remove-Item -LiteralPath $TmpDir -Recurse -Force
  }
}
