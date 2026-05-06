#!/usr/bin/env bash
set -euo pipefail

REPO_ZIP_URL="${CONTENT_LINK_SUMMARIZER_ZIP_URL:-https://github.com/751663356/obsidian-content-link-summarizer/archive/refs/heads/main.zip}"
PLUGIN_ID="xiaohongshu-summarizer"

say() {
  printf "\n%s\n" "$1"
}

fail() {
  printf "\n安装失败：%s\n" "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "缺少 curl。"
command -v unzip >/dev/null 2>&1 || fail "缺少 unzip。"

say "内容链接总结 Obsidian 插件安装器"
say "请粘贴你的 Obsidian 仓库路径。"
printf "例如：/Users/ian/Library/Mobile Documents/iCloud~md~obsidian/Documents/Ian的仓库\n\n"
printf "仓库路径："
IFS= read -r VAULT_PATH

VAULT_PATH="${VAULT_PATH/#\~/$HOME}"
VAULT_PATH="${VAULT_PATH%/}"

if [ -z "$VAULT_PATH" ]; then
  fail "仓库路径不能为空。"
fi

if [ ! -d "$VAULT_PATH" ]; then
  fail "这个路径不存在：$VAULT_PATH"
fi

PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

say "正在下载插件..."
curl -fsSL "$REPO_ZIP_URL" -o "$TMP_DIR/plugin.zip"
unzip -q "$TMP_DIR/plugin.zip" -d "$TMP_DIR"

SOURCE_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name "obsidian-content-link-summarizer-*" | head -n 1)"
if [ -z "$SOURCE_DIR" ]; then
  fail "没有在下载包里找到插件目录。"
fi

say "正在安装到 Obsidian..."
mkdir -p "$PLUGIN_DIR"
rm -rf "$PLUGIN_DIR/scripts"

for item in \
  manifest.json \
  main.js \
  styles.css \
  README.md \
  requirements.txt \
  package.json \
  data.example.json \
  install.ps1 \
  scripts
do
  if [ -e "$SOURCE_DIR/$item" ]; then
    cp -R "$SOURCE_DIR/$item" "$PLUGIN_DIR/"
  fi
done

say "安装完成。"
printf "插件位置：%s\n" "$PLUGIN_DIR"
printf "\n下一步：\n"
printf "1. 打开 Obsidian 设置 -> 第三方插件。\n"
printf "2. 关闭安全模式后启用「内容链接总结」。\n"
printf "3. 打开插件设置页，点击「一键安装」准备本地依赖。\n"
printf "4. 需要视频转录时，再点击「下载 small」。\n"
printf "5. 用 Chrome 登录小红书或 B 站，然后点击「检查登录态」。\n"
