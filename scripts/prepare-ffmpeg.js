const fs = require("node:fs");
const path = require("node:path");

const ffmpegPath = require("ffmpeg-static");

if (!ffmpegPath) {
  throw new Error("ffmpeg-static did not resolve a binary path.");
}

const targetDir = path.join(process.cwd(), "resources", "ffmpeg");
const targetFile = path.join(targetDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(ffmpegPath, targetFile);

console.log(`FFmpeg copied to ${targetFile}`);

