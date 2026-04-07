import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import ffmpegStatic from "ffmpeg-static";

const ffmpegBinaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

export function resolveFfmpegPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ffmpeg", ffmpegBinaryName);
  }

  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }

  return path.join(process.cwd(), "resources", "ffmpeg", ffmpegBinaryName);
}

export function requireFfmpegPath(): string {
  const resolvedPath = resolveFfmpegPath();
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`FFmpeg binary not found at ${resolvedPath}`);
  }

  return resolvedPath;
}

export function getFfmpegStatus(): { path: string; exists: boolean; packaged: boolean } {
  const resolvedPath = resolveFfmpegPath();
  return {
    path: resolvedPath,
    exists: fs.existsSync(resolvedPath),
    packaged: app.isPackaged
  };
}
