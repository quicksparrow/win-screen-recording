import { spawn, type ChildProcess } from "node:child_process";
import type { AspectRatio, ExportRequest, GifExportRequest } from "../../shared/types";
import { requireFfmpegPath } from "../services/FfmpegService";

const FFMPEG_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const FFMPEG_STALL_TIMEOUT_MS = 20 * 60 * 1000;
const AUDIO_PROBE_TIMEOUT_MS = 60 * 1000;
const MAX_STDERR_CHARS = 16 * 1024;
const MIN_DIMENSION = 120;
const MAX_DIMENSION = 3840;

type ExportTelemetryCallbacks = {
  onLog?: (message: string) => void;
  onProgress?: (percent: number, message: string, detail?: string) => void;
};

type ActiveExportProcess = {
  process: ChildProcess;
  canceled: boolean;
};

function getAspectRatioFilter(aspectRatio: AspectRatio): string {
  if (aspectRatio === "1:1") {
    return "crop=min(iw\\,ih):min(iw\\,ih)";
  }

  if (aspectRatio === "9:16") {
    return "crop=if(gt(a\\,9/16)\\,ih*9/16\\,iw):if(gt(a\\,9/16)\\,ih\\,iw*16/9)";
  }

  return "crop=if(gt(a\\,16/9)\\,ih*16/9\\,iw):if(gt(a\\,16/9)\\,ih\\,iw*9/16)";
}

function normalizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const bounded = Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(value)));
  return bounded % 2 === 0 ? bounded : bounded - 1;
}

function resolveOutputDimensions(aspectRatio: AspectRatio, width?: number, height?: number): { width: number; height: number } {
  const defaultByRatio: Record<AspectRatio, { width: number; height: number }> = {
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "1:1": { width: 960, height: 960 }
  };
  const fallback = defaultByRatio[aspectRatio];
  return {
    width: normalizeDimension(width ?? fallback.width, fallback.width),
    height: normalizeDimension(height ?? fallback.height, fallback.height)
  };
}

function hasAudioStreamMetadata(stderr: string): boolean {
  // FFmpeg stream lines can include optional stream ids and language tags:
  // "Stream #0:1[0x2](und): Audio: ..."
  return /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?:\s*Audio:/i.test(stderr);
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function appendAndDrainLines(buffer: string, chunk: Buffer, onLine: (line: string) => void): string {
  let next = `${buffer}${chunk.toString()}`;
  let newlineIndex = next.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = next.slice(0, newlineIndex).trim();
    next = next.slice(newlineIndex + 1);
    if (line) {
      onLine(line);
    }
    newlineIndex = next.indexOf("\n");
  }
  return next;
}

export class ExportManager {
  private activeProcess: ActiveExportProcess | null = null;

  cancelActiveExport(): boolean {
    const active = this.activeProcess;
    if (!active) {
      return false;
    }

    active.canceled = true;
    try {
      active.process.kill("SIGKILL");
    } catch {
      // Ignore process-kill race conditions.
    }
    return true;
  }

  private setActiveProcess(process: ChildProcess): () => boolean {
    const context: ActiveExportProcess = { process, canceled: false };
    this.activeProcess = context;
    return () => {
      const canceled = context.canceled;
      if (this.activeProcess === context) {
        this.activeProcess = null;
      }
      return canceled;
    };
  }

  convertWebmToMp4(request: ExportRequest, callbacks?: ExportTelemetryCallbacks): Promise<void> {
    const ffmpegPath = requireFfmpegPath();
    const cropFilter = getAspectRatioFilter(request.aspectRatio);
    const fps = Number.isFinite(request.fps) && request.fps ? Math.max(24, Math.min(120, Math.round(request.fps))) : 60;
    const { width, height } = resolveOutputDimensions(request.aspectRatio, request.width, request.height);
    const encoderPreset = "fast";
    const expectedDurationMs = Number.isFinite(request.durationSec) && request.durationSec ? Math.max(1, request.durationSec * 1000) : null;
    const filter = request.keepAspect
      ? `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=increase,crop=${width}:${height}:0:0,fps=${fps}`
      : `${cropFilter},scale=${width}:${height}:flags=lanczos,fps=${fps}`;

    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-progress",
      "pipe:1",
      "-nostats",
      "-n",
      "-i",
      request.inputPath
    ];
    if (request.audioInputPath) {
      args.push("-i", request.audioInputPath);
    }
    args.push("-vf", filter, "-c:v", "libx264", "-preset", encoderPreset, "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (request.audioInputPath) {
      args.push("-map", "0:v:0", "-map", "1:a:0?", "-af", "apad", "-c:a", "aac", "-b:a", "192k", "-shortest");
    } else {
      args.push("-an");
    }
    args.push(request.outputPath);

    return new Promise((resolve, reject) => {
      const encodeStartedAt = Date.now();
      callbacks?.onLog?.(`[export:mp4] FFmpeg starting. input=${request.inputPath} output=${request.outputPath} fps=${fps} size=${width}x${height}`);
      callbacks?.onLog?.(
        `[export:mp4] settings aspect=${request.aspectRatio} keepAspect=${request.keepAspect ? "true" : "false"} expectAudio=${request.expectAudio ? "true" : "false"} audioInput=${
          request.audioInputPath ?? "none"
        }`
      );
      callbacks?.onLog?.(`[export:mp4] encoder preset=${encoderPreset} crf=18 pix_fmt=yuv420p`);
      callbacks?.onLog?.(`[export:mp4] args=${args.join(" ")}`);
      const ffmpeg = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const clearActiveProcess = this.setActiveProcess(ffmpeg);
      callbacks?.onLog?.(`[export:mp4] FFmpeg spawned (pid=${ffmpeg.pid ?? "unknown"}).`);
      let hardTimedOut = false;
      let stalledOut = false;
      let lastProgressAt = Date.now();
      const touchProgress = () => {
        lastProgressAt = Date.now();
      };

      const timeout = setTimeout(() => {
        hardTimedOut = true;
        callbacks?.onLog?.(`[export:mp4] FFmpeg hard timeout after ${FFMPEG_TIMEOUT_MS / 1000}s.`);
        ffmpeg.kill("SIGKILL");
      }, FFMPEG_TIMEOUT_MS);
      const stallTimeout = setInterval(() => {
        if (Date.now() - lastProgressAt <= FFMPEG_STALL_TIMEOUT_MS) return;
        stalledOut = true;
        callbacks?.onLog?.(`[export:mp4] FFmpeg stalled for ${FFMPEG_STALL_TIMEOUT_MS / 1000}s; terminating process.`);
        ffmpeg.kill("SIGKILL");
      }, 1_000);

      let stderr = "";
      let progressBuffer = "";
      let stderrLineBuffer = "";
      ffmpeg.stdout.on("data", (chunk) => {
        touchProgress();
        progressBuffer += chunk.toString();
        let newlineIndex = progressBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const rawLine = progressBuffer.slice(0, newlineIndex).trim();
          progressBuffer = progressBuffer.slice(newlineIndex + 1);
          if (!rawLine) {
            newlineIndex = progressBuffer.indexOf("\n");
            continue;
          }

          const [rawKey, ...rawRest] = rawLine.split("=");
          const key = rawKey?.trim();
          const value = rawRest.join("=").trim();
          callbacks?.onLog?.(`[export:mp4][stdout] ${rawLine}`);
          if (key === "out_time_ms" && expectedDurationMs) {
            const outTimeMs = Number(value) / 1000;
            if (Number.isFinite(outTimeMs) && outTimeMs >= 0) {
              const percent = clampPercent((outTimeMs / expectedDurationMs) * 100);
              callbacks?.onProgress?.(percent, `Encoding MP4... ${Math.round(percent)}%`, `${(outTimeMs / 1000).toFixed(2)}s encoded`);
            }
          }
          if (key === "progress" && value === "end") {
            callbacks?.onProgress?.(100, "Encoding MP4... 100%");
          }
        }
      });
      ffmpeg.stderr.on("data", (chunk) => {
        touchProgress();
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
        stderrLineBuffer = appendAndDrainLines(stderrLineBuffer, chunk, (line) => {
          callbacks?.onLog?.(`[export:mp4][stderr] ${line}`);
        });
      });

      ffmpeg.on("error", (error) => {
        clearTimeout(timeout);
        clearInterval(stallTimeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        callbacks?.onLog?.(`[export:mp4] FFmpeg process error: ${error.message}`);
        reject(error);
      });
      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        clearInterval(stallTimeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        if (hardTimedOut) {
          reject(new Error(`FFmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000} seconds.`));
          return;
        }
        if (stalledOut) {
          reject(new Error(`FFmpeg made no progress for ${FFMPEG_STALL_TIMEOUT_MS / 1000} seconds.`));
          return;
        }

        if (code === 0) {
          const elapsedSec = (Date.now() - encodeStartedAt) / 1000;
          callbacks?.onLog?.(`[export:mp4] FFmpeg encoding completed successfully in ${elapsedSec.toFixed(2)}s.`);
          if (request.expectAudio && request.audioInputPath) {
            this.verifyAudioTrack(request.outputPath)
              .then(resolve)
              .catch(reject);
            return;
          }
          resolve();
          return;
        }

        const elapsedSec = (Date.now() - encodeStartedAt) / 1000;
        callbacks?.onLog?.(`[export:mp4] FFmpeg failed with code ${code ?? "unknown"} after ${elapsedSec.toFixed(2)}s.`);
        reject(new Error(stderr || `FFmpeg exited with code ${code ?? "unknown"}`));
      });
    });
  }

  private verifyAudioTrack(filePath: string): Promise<void> {
    const ffmpegPath = requireFfmpegPath();
    const args = ["-hide_banner", "-nostdin", "-i", filePath];
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"]
      });
      const clearActiveProcess = this.setActiveProcess(ffmpeg);
      let hardTimedOut = false;
      const timeout = setTimeout(() => {
        hardTimedOut = true;
        ffmpeg.kill("SIGKILL");
      }, AUDIO_PROBE_TIMEOUT_MS);

      let stderr = "";
      ffmpeg.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
      });

      ffmpeg.on("error", (error) => {
        clearTimeout(timeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        reject(error);
      });
      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        if (hardTimedOut) {
          reject(new Error(`Audio track verification timed out after ${AUDIO_PROBE_TIMEOUT_MS / 1000} seconds.`));
          return;
        }
        if (!hasAudioStreamMetadata(stderr)) {
          reject(new Error("Export finished without an audio track."));
          return;
        }
        if (code !== 0 && code !== 1) {
          reject(new Error(stderr || "Audio verification failed"));
          return;
        }
        resolve();
      });
    });
  }

  convertWebmToGif(request: GifExportRequest, callbacks?: ExportTelemetryCallbacks): Promise<void> {
    const ffmpegPath = requireFfmpegPath();
    const fps = Number.isFinite(request.fps) && request.fps ? Math.max(8, Math.min(30, Math.round(request.fps))) : 12;
    const width = normalizeDimension(request.width ?? 960, 960);
    const height = normalizeDimension(request.height ?? 540, 540);
    const expectedDurationMs = Number.isFinite(request.durationSec) && request.durationSec ? Math.max(1, request.durationSec * 1000) : null;
    const palette = request.highQuality ? "palettegen=max_colors=256:stats_mode=diff" : "palettegen=max_colors=128";
    const dither = request.highQuality ? "paletteuse=dither=sierra2_4a" : "paletteuse=dither=bayer:bayer_scale=3";
    const filter = `fps=${fps},scale=${width}:${height}:flags=lanczos,split[s0][s1];[s0]${palette}[p];[s1][p]${dither}`;

    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-progress",
      "pipe:1",
      "-nostats",
      "-n",
      "-i",
      request.inputPath,
      "-vf",
      filter,
      "-loop",
      "0",
      request.outputPath
    ];

    return new Promise((resolve, reject) => {
      const encodeStartedAt = Date.now();
      callbacks?.onLog?.(`[export:gif] FFmpeg starting. input=${request.inputPath} output=${request.outputPath} fps=${fps} size=${width}x${height}`);
      callbacks?.onLog?.(`[export:gif] settings highQuality=${request.highQuality ? "true" : "false"}`);
      callbacks?.onLog?.(`[export:gif] args=${args.join(" ")}`);
      const ffmpeg = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const clearActiveProcess = this.setActiveProcess(ffmpeg);
      callbacks?.onLog?.(`[export:gif] FFmpeg spawned (pid=${ffmpeg.pid ?? "unknown"}).`);
      let hardTimedOut = false;
      let stalledOut = false;
      let lastProgressAt = Date.now();
      const touchProgress = () => {
        lastProgressAt = Date.now();
      };
      const timeout = setTimeout(() => {
        hardTimedOut = true;
        callbacks?.onLog?.(`[export:gif] FFmpeg hard timeout after ${FFMPEG_TIMEOUT_MS / 1000}s.`);
        ffmpeg.kill("SIGKILL");
      }, FFMPEG_TIMEOUT_MS);
      const stallTimeout = setInterval(() => {
        if (Date.now() - lastProgressAt <= FFMPEG_STALL_TIMEOUT_MS) return;
        stalledOut = true;
        callbacks?.onLog?.(`[export:gif] FFmpeg stalled for ${FFMPEG_STALL_TIMEOUT_MS / 1000}s; terminating process.`);
        ffmpeg.kill("SIGKILL");
      }, 1_000);

      let stderr = "";
      let progressBuffer = "";
      let stderrLineBuffer = "";
      ffmpeg.stdout.on("data", (chunk) => {
        touchProgress();
        progressBuffer += chunk.toString();
        let newlineIndex = progressBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const rawLine = progressBuffer.slice(0, newlineIndex).trim();
          progressBuffer = progressBuffer.slice(newlineIndex + 1);
          if (!rawLine) {
            newlineIndex = progressBuffer.indexOf("\n");
            continue;
          }

          const [rawKey, ...rawRest] = rawLine.split("=");
          const key = rawKey?.trim();
          const value = rawRest.join("=").trim();
          callbacks?.onLog?.(`[export:gif][stdout] ${rawLine}`);
          if (key === "out_time_ms" && expectedDurationMs) {
            const outTimeMs = Number(value) / 1000;
            if (Number.isFinite(outTimeMs) && outTimeMs >= 0) {
              const percent = clampPercent((outTimeMs / expectedDurationMs) * 100);
              callbacks?.onProgress?.(percent, `Encoding GIF... ${Math.round(percent)}%`, `${(outTimeMs / 1000).toFixed(2)}s encoded`);
            }
          }
          if (key === "progress" && value === "end") {
            callbacks?.onProgress?.(100, "Encoding GIF... 100%");
          }
        }
      });
      ffmpeg.stderr.on("data", (chunk) => {
        touchProgress();
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
        stderrLineBuffer = appendAndDrainLines(stderrLineBuffer, chunk, (line) => {
          callbacks?.onLog?.(`[export:gif][stderr] ${line}`);
        });
      });

      ffmpeg.on("error", (error) => {
        clearTimeout(timeout);
        clearInterval(stallTimeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        callbacks?.onLog?.(`[export:gif] FFmpeg process error: ${error.message}`);
        reject(error);
      });
      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        clearInterval(stallTimeout);
        const canceledByUser = clearActiveProcess();
        if (canceledByUser) {
          reject(new Error("Export canceled by user."));
          return;
        }
        if (hardTimedOut) {
          reject(new Error(`FFmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000} seconds.`));
          return;
        }
        if (stalledOut) {
          reject(new Error(`FFmpeg made no progress for ${FFMPEG_STALL_TIMEOUT_MS / 1000} seconds.`));
          return;
        }

        if (code === 0) {
          const elapsedSec = (Date.now() - encodeStartedAt) / 1000;
          callbacks?.onLog?.(`[export:gif] FFmpeg encoding completed successfully in ${elapsedSec.toFixed(2)}s.`);
          resolve();
          return;
        }

        const elapsedSec = (Date.now() - encodeStartedAt) / 1000;
        callbacks?.onLog?.(`[export:gif] FFmpeg failed with code ${code ?? "unknown"} after ${elapsedSec.toFixed(2)}s.`);
        reject(new Error(stderr || `FFmpeg exited with code ${code ?? "unknown"}`));
      });
    });
  }
}
