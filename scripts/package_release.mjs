import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const packageDir = path.join(distDir, "xiaohongshu-summarizer");
const zipPath = path.join(distDir, "content-link-summarizer.zip");

const files = [
  "manifest.json",
  "main.js",
  "styles.css",
  "README.md",
  "requirements.txt",
  "package.json",
  "data.example.json",
  "install.sh",
  "install.ps1"
];

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(packageDir, { recursive: true });

for (const file of files) {
  const source = path.join(root, file);
  if (existsSync(source)) {
    await fs.copyFile(source, path.join(packageDir, file));
  }
}

await fs.cp(path.join(root, "scripts"), path.join(packageDir, "scripts"), {
  recursive: true
});

await execFileAsync("zip", ["-qr", zipPath, "xiaohongshu-summarizer"], {
  cwd: distDir
});

console.log(`Release package created: ${zipPath}`);
