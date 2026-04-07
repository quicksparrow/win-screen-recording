import { app, desktopCapturer, dialog, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CompletedStudioSession,
  ExportRequest,
  GifExportRequest,
  RawTrackType,
  RecordingArtifacts,
  StudioRecordingSession,
  StudioSessionSummary,
  TelemetryEvent,
  WallpaperAsset
} from "../../shared/types";
import { ExportManager } from "../modules/ExportManager";
import { StorageManager } from "../modules/StorageManager";
import { TelemetryLogger } from "../modules/TelemetryLogger";
import { getFfmpegStatus } from "../services/FfmpegService";

const exportManager = new ExportManager();
const approvedSavePaths = new Set<string>();
const approvedDataRoots = new Set<string>();
const allowedSourceTypes = new Set<"screen" | "window">(["screen", "window"]);
const defaultCaptureTypes: Array<"screen" | "window"> = ["screen", "window"];
const projectDirectoryName = "screen-recording";
const allowedWallpaperExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const recordingSessions = new Map<string, { storage: StorageManager; filePath: string }>();
const exportRenderSessions = new Map<string, { storage: StorageManager; filePath: string }>();
const studioSessions = new Map<
  string,
  {
    startedAtIso: string;
    artifacts: RecordingArtifacts;
    storages: Record<RawTrackType, StorageManager>;
    telemetry: TelemetryLogger;
  }
>();

function isCaptureType(value: unknown): value is "screen" | "window" {
  return value === "screen" || value === "window";
}

function isRawTrackType(value: unknown): value is RawTrackType {
  return value === "screen" || value === "webcam" || value === "audio";
}

function resolveAssetDirectory(folderName: "wallpapers" | "design"): string {
  const candidates = app.isPackaged
    ? [path.resolve(process.resourcesPath, folderName), path.resolve(process.cwd(), folderName)]
    : [path.resolve(process.cwd(), folderName), path.resolve(process.resourcesPath, folderName)];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore invalid candidate paths and keep scanning.
    }
  }

  return path.resolve(app.getPath("documents"), projectDirectoryName, folderName);
}

function sanitizeDefaultFileName(value: string): string {
  const fallback = `recording-${Date.now()}.webm`;
  if (!value || typeof value !== "string") {
    return fallback;
  }

  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
  return base.length > 0 ? base : fallback;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function buildRecordingArtifacts(projectDir: string): RecordingArtifacts {
  return {
    projectDir,
    screenPath: path.join(projectDir, "screen.webm"),
    webcamPath: path.join(projectDir, "webcam.webm"),
    audioPath: path.join(projectDir, "audio.webm"),
    telemetryPath: path.join(projectDir, "telemetry.json"),
    manifestPath: path.join(projectDir, "session-manifest.json")
  };
}

function isValidStudioSummary(value: unknown): value is StudioSessionSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const summary = value as StudioSessionSummary;
  return (
    typeof summary.sourceId === "string" &&
    summary.sourceId.length > 0 &&
    (summary.aspectRatio === "16:9" || summary.aspectRatio === "9:16" || summary.aspectRatio === "1:1") &&
    typeof summary.captureSystemAudio === "boolean" &&
    typeof summary.captureMicrophone === "boolean" &&
    typeof summary.captureWebcam === "boolean" &&
    typeof summary.durationMs === "number" &&
    Number.isFinite(summary.durationMs) &&
    summary.durationMs >= 0
  );
}

function isValidExportRequest(payload: unknown): payload is ExportRequest {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const request = payload as ExportRequest;
  return (
    typeof request.inputPath === "string" &&
    request.inputPath.length > 0 &&
    typeof request.outputPath === "string" &&
    request.outputPath.length > 0 &&
    (request.aspectRatio === "16:9" || request.aspectRatio === "9:16" || request.aspectRatio === "1:1") &&
    (request.fps === undefined || (typeof request.fps === "number" && Number.isFinite(request.fps))) &&
    (request.width === undefined || (typeof request.width === "number" && Number.isFinite(request.width) && request.width > 0)) &&
    (request.height === undefined || (typeof request.height === "number" && Number.isFinite(request.height) && request.height > 0)) &&
    (request.durationSec === undefined || (typeof request.durationSec === "number" && Number.isFinite(request.durationSec) && request.durationSec > 0)) &&
    (request.audioInputPath === undefined || typeof request.audioInputPath === "string") &&
    (request.expectAudio === undefined || typeof request.expectAudio === "boolean") &&
    (request.keepAspect === undefined || typeof request.keepAspect === "boolean")
  );
}

function isValidGifExportRequest(payload: unknown): payload is GifExportRequest {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const request = payload as GifExportRequest;
  return (
    typeof request.inputPath === "string" &&
    request.inputPath.length > 0 &&
    typeof request.outputPath === "string" &&
    request.outputPath.length > 0 &&
    (request.fps === undefined || (typeof request.fps === "number" && Number.isFinite(request.fps))) &&
    (request.width === undefined || (typeof request.width === "number" && Number.isFinite(request.width) && request.width > 0)) &&
    (request.height === undefined || (typeof request.height === "number" && Number.isFinite(request.height) && request.height > 0)) &&
    (request.durationSec === undefined || (typeof request.durationSec === "number" && Number.isFinite(request.durationSec) && request.durationSec > 0)) &&
    (request.highQuality === undefined || typeof request.highQuality === "boolean")
  );
}

function sanitizeChunkPayload(chunk: unknown): Buffer {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(chunk));
  }

  throw new Error("Invalid chunk payload.");
}

function resolveAndValidateWritableFilePath(filePath: string): string | null {
  const normalized = path.resolve(filePath);
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  const tempRoot = app.getPath("temp");
  if (isPathInside(tempRoot, normalized)) {
    return normalized;
  }

  for (const approvedRoot of approvedDataRoots) {
    if (isPathInside(approvedRoot, normalized)) {
      return normalized;
    }
  }

  return null;
}

async function closeStudioTrackWriters(storages: Record<RawTrackType, StorageManager>): Promise<void> {
  await Promise.all([
    storages.screen.closeChunkWriter(),
    storages.webcam.closeChunkWriter(),
    storages.audio.closeChunkWriter()
  ]);
}

async function listImageAssets(directory: string): Promise<WallpaperAsset[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && allowedWallpaperExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return {
        name: entry.name,
        path: absolutePath,
        fileUrl: pathToFileURL(absolutePath).toString()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

async function listWallpaperAssets(): Promise<WallpaperAsset[]> {
  return listImageAssets(resolveAssetDirectory("wallpapers"));
}

async function listAppBackgroundAssets(): Promise<WallpaperAsset[]> {
  return listImageAssets(resolveAssetDirectory("design"));
}

function emitExportProgress(
  sender: WebContents,
  payload: {
    stage: "started" | "rendering" | "encoding" | "saving" | "completed" | "failed" | "canceled";
    message: string;
    percent?: number;
    detail?: string;
  }
): void {
  sender.send("export:progress", {
    ...payload,
    timestampMs: Date.now()
  });
}

function bytesToMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatMainMemoryUsage(): string {
  const usage = process.memoryUsage();
  return `rss=${bytesToMiB(usage.rss)} heapUsed=${bytesToMiB(usage.heapUsed)} heapTotal=${bytesToMiB(usage.heapTotal)} ext=${bytesToMiB(
    usage.external
  )}`;
}

function logWorkflowDiagnostic(stage: string, detail = ""): void {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[workflow:diag:main] ts=${new Date().toISOString()} epochMs=${Date.now()} stage=${stage}${suffix}`);
}

export function registerIpcHandlers(): void {
  ipcMain.handle("capture:list-sources", async (_event, types?: Array<"screen" | "window">) => {
    const filteredTypes: Array<"screen" | "window"> =
      Array.isArray(types) && types.length > 0 ? types.filter((value): value is "screen" | "window" => isCaptureType(value) && allowedSourceTypes.has(value)) : defaultCaptureTypes;
    const captureTypes: Array<"screen" | "window"> = filteredTypes.length > 0 ? filteredTypes : defaultCaptureTypes;
    logWorkflowDiagnostic("source-enumeration:start", `captureTypes=${captureTypes.join(",")}`);
    try {
      const sources = await desktopCapturer.getSources({
        types: captureTypes,
        thumbnailSize: { width: 0, height: 0 }
      });
      logWorkflowDiagnostic("source-enumeration:success", `captureTypes=${captureTypes.join(",")} sourceCount=${sources.length}`);
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        displayId: source.display_id,
        appIconDataUrl: source.appIcon?.toDataURL() ?? null
      }));
    } catch (error) {
      logWorkflowDiagnostic("source-enumeration:failed", `captureTypes=${captureTypes.join(",")} reason=${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
  });

  ipcMain.handle("background:list-wallpapers", async () => listWallpaperAssets());
  ipcMain.handle("background:list-app-backgrounds", async () => listAppBackgroundAssets());

  ipcMain.handle("storage:choose-save-path", async (_event, defaultFileName: string) => {
    const result = await dialog.showSaveDialog({
      title: "Save Recording",
      defaultPath: sanitizeDefaultFileName(defaultFileName),
      filters: [
        { name: "WebM Video", extensions: ["webm"] },
        { name: "MP4 Video", extensions: ["mp4"] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const normalizedPath = path.resolve(result.filePath);
    approvedSavePaths.add(normalizedPath);
    return normalizedPath;
  });

  ipcMain.handle("storage:choose-export-path", async (_event, defaultFileName: string, format: "mp4" | "gif") => {
    const extension = format === "gif" ? "gif" : "mp4";
    const safeDefault = sanitizeDefaultFileName(defaultFileName).replace(/\.(webm|mp4|gif)$/i, "");
    const result = await dialog.showSaveDialog({
      title: `Export ${extension.toUpperCase()}`,
      defaultPath: `${safeDefault}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const normalizedPath = path.resolve(result.filePath);
    approvedSavePaths.add(normalizedPath);
    return normalizedPath;
  });

  ipcMain.handle("recording:create-session", async (_event, defaultFileName: string) => {
    const result = await dialog.showSaveDialog({
      title: "Save Recording",
      defaultPath: sanitizeDefaultFileName(defaultFileName),
      filters: [{ name: "WebM Video", extensions: ["webm"] }]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const filePath = path.resolve(result.filePath);
    const sessionId = randomUUID();
    const storage = new StorageManager();
    await storage.openChunkWriter(filePath);
    recordingSessions.set(sessionId, { storage, filePath });
    approvedSavePaths.add(filePath);

    return { sessionId, filePath };
  });

  ipcMain.handle("recording:append-chunk", async (_event, sessionId: string, chunk: unknown) => {
    const session = recordingSessions.get(sessionId);
    if (!session) {
      throw new Error("Recording session is not active.");
    }

    await session.storage.writeChunk(sanitizeChunkPayload(chunk));
  });

  ipcMain.handle("recording:finish-session", async (_event, sessionId: string) => {
    const session = recordingSessions.get(sessionId);
    if (!session) {
      return;
    }

    recordingSessions.delete(sessionId);
    await session.storage.closeChunkWriter();
  });

  ipcMain.handle("recording:cancel-session", async (_event, sessionId: string) => {
    const session = recordingSessions.get(sessionId);
    if (!session) {
      return;
    }

    recordingSessions.delete(sessionId);
    await session.storage.closeChunkWriter();
    try {
      await fs.promises.unlink(session.filePath);
    } catch {
      // Ignore delete failures; the user may not have created data yet.
    }
  });

  ipcMain.handle("recording:create-studio-session", async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const projectDir = path.join(app.getPath("temp"), "ai-screen-recorder", `studio-${timestamp}-${randomUUID().slice(0, 8)}`);
    const artifacts = buildRecordingArtifacts(projectDir);
    await fs.promises.mkdir(artifacts.projectDir, { recursive: true });

    const storages: Record<RawTrackType, StorageManager> = {
      screen: new StorageManager(),
      webcam: new StorageManager(),
      audio: new StorageManager()
    };

    await Promise.all([
      storages.screen.openChunkWriter(artifacts.screenPath),
      storages.webcam.openChunkWriter(artifacts.webcamPath),
      storages.audio.openChunkWriter(artifacts.audioPath)
    ]);

    const sessionId = randomUUID();
    const startedAtIso = new Date().toISOString();
    studioSessions.set(sessionId, {
      startedAtIso,
      artifacts,
      storages,
      telemetry: new TelemetryLogger(artifacts.telemetryPath)
    });
    approvedDataRoots.add(artifacts.projectDir);

    const session: StudioRecordingSession = {
      sessionId,
      startedAtIso,
      artifacts
    };

    return session;
  });

  ipcMain.handle("recording:append-track-chunk", async (_event, sessionId: string, track: unknown, chunk: unknown) => {
    if (!isRawTrackType(track)) {
      throw new Error("Invalid track.");
    }

    const session = studioSessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session is not active.");
    }

    await session.storages[track].writeChunk(sanitizeChunkPayload(chunk));
  });

  ipcMain.handle("recording:append-telemetry-events", async (_event, sessionId: string, events: unknown) => {
    const session = studioSessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session is not active.");
    }

    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    const typedEvents = events as TelemetryEvent[];
    session.telemetry.appendEvents(typedEvents);
  });

  ipcMain.handle("recording:finish-studio-session", async (_event, sessionId: string, summary: unknown) => {
    const session = studioSessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (!isValidStudioSummary(summary)) {
      throw new Error("Invalid studio summary.");
    }

    studioSessions.delete(sessionId);

    await closeStudioTrackWriters(session.storages);
    const telemetry = await session.telemetry.close();

    const manifest = {
      schemaVersion: 1,
      sessionId,
      startedAtIso: session.startedAtIso,
      endedAtIso: new Date().toISOString(),
      summary,
      artifacts: session.artifacts,
      telemetryEventCount: telemetry.count
    };
    await fs.promises.writeFile(session.artifacts.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const completed: CompletedStudioSession = {
      sessionId,
      endedAtIso: manifest.endedAtIso,
      artifacts: session.artifacts,
      telemetryEventCount: telemetry.count
    };

    return completed;
  });

  ipcMain.handle("recording:cancel-studio-session", async (_event, sessionId: string) => {
    const session = studioSessions.get(sessionId);
    if (!session) {
      return;
    }

    studioSessions.delete(sessionId);
    await closeStudioTrackWriters(session.storages);
    try {
      await fs.promises.rm(session.artifacts.projectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  });

  ipcMain.handle("storage:write-binary-file", async (_event, filePath: string, chunk: unknown) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("File path is required.");
    }

    const approvedPath = resolveAndValidateWritableFilePath(filePath);
    if (!approvedPath) {
      throw new Error("Write path is not approved.");
    }

    await fs.promises.mkdir(path.dirname(approvedPath), { recursive: true });
    await fs.promises.writeFile(approvedPath, sanitizeChunkPayload(chunk));
  });

  ipcMain.handle("storage:delete-file", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return;
    }

    const approvedPath = resolveAndValidateWritableFilePath(filePath);
    if (!approvedPath) {
      return;
    }

    try {
      await fs.promises.unlink(approvedPath);
    } catch {
      // Ignore delete failures.
    }
  });

  ipcMain.handle("storage:copy-export-file", async (_event, sourcePath: string, outputPath: string) => {
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || typeof outputPath !== "string" || outputPath.length === 0) {
      return { success: false, error: "Source and output paths are required." };
    }

    const sourceAbsolute = path.resolve(sourcePath);
    const outputAbsolute = path.resolve(outputPath);
    const approvedSource = resolveAndValidateWritableFilePath(sourceAbsolute);
    if (!approvedSource) {
      return { success: false, error: "Source path is not approved." };
    }

    if (!approvedSavePaths.has(outputAbsolute)) {
      return { success: false, error: "Output path is not approved by user selection." };
    }

    const extension = path.extname(outputAbsolute).toLowerCase();
    if (extension !== ".mp4" && extension !== ".gif") {
      return { success: false, error: "Output file must use .mp4 or .gif extension." };
    }

    if (path.extname(sourceAbsolute).toLowerCase() !== extension) {
      return { success: false, error: "Source and output formats must match." };
    }

    let sourceStat: fs.Stats;
    try {
      sourceStat = await fs.promises.stat(approvedSource);
    } catch {
      return { success: false, error: "Export file does not exist yet. Run Export first." };
    }

    if (!sourceStat.isFile()) {
      return { success: false, error: "Source path is not a file." };
    }

    await fs.promises.mkdir(path.dirname(outputAbsolute), { recursive: true });
    await fs.promises.copyFile(approvedSource, outputAbsolute);
    return { success: true, outputPath: outputAbsolute };
  });

  ipcMain.handle("export:create-render-session", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("File path is required.");
    }

    const approvedPath = resolveAndValidateWritableFilePath(filePath);
    if (!approvedPath) {
      throw new Error("Render output path is not approved.");
    }

    const sessionId = randomUUID();
    const storage = new StorageManager();
    await storage.openChunkWriter(approvedPath);
    exportRenderSessions.set(sessionId, { storage, filePath: approvedPath });
    console.log(`[export:render] session created id=${sessionId} path=${approvedPath}`);
    return sessionId;
  });

  ipcMain.handle("export:append-render-chunk", async (_event, sessionId: string, chunk: unknown) => {
    const session = exportRenderSessions.get(sessionId);
    if (!session) {
      throw new Error("Render session is not active.");
    }

    await session.storage.writeChunk(sanitizeChunkPayload(chunk));
  });

  ipcMain.handle("export:finish-render-session", async (_event, sessionId: string) => {
    const session = exportRenderSessions.get(sessionId);
    if (!session) {
      return;
    }

    exportRenderSessions.delete(sessionId);
    await session.storage.closeChunkWriter();
    console.log(`[export:render] session finished id=${sessionId} path=${session.filePath}`);
  });

  ipcMain.handle("export:cancel-render-session", async (_event, sessionId: string) => {
    const session = exportRenderSessions.get(sessionId);
    if (!session) {
      return;
    }

    exportRenderSessions.delete(sessionId);
    try {
      await session.storage.closeChunkWriter();
    } catch {
      // Ignore close errors on canceled writes.
    }
    try {
      await fs.promises.unlink(session.filePath);
    } catch {
      // Ignore cleanup failures.
    }
    console.log(`[export:render] session canceled id=${sessionId}`);
  });

  ipcMain.handle("export:mp4", async (event, request: unknown) => {
    const sender = event.sender;
    const requestStartedAt = Date.now();
    let preflightCompletedAt = requestStartedAt;
    if (!isValidExportRequest(request)) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: invalid MP4 request payload." });
      return { success: false, error: "Invalid export request payload." };
    }

    console.log(
      `[export:mp4] started input=${request.inputPath} output=${request.outputPath} aspect=${request.aspectRatio} fps=${request.fps ?? "default"} size=${
        request.width ?? "auto"
      }x${request.height ?? "auto"} durationSec=${request.durationSec ?? "unknown"} keepAspect=${request.keepAspect ?? "auto"} expectAudio=${
        request.expectAudio ?? false
      }`
    );
    console.log(`[export:mp4] main memory at start ${formatMainMemoryUsage()}`);
    emitExportProgress(sender, { stage: "started", message: "MP4 export started." });

    const inputPath = path.resolve(request.inputPath);
    const outputPath = path.resolve(request.outputPath);
    const audioInputPath = request.audioInputPath ? path.resolve(request.audioInputPath) : undefined;

    if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath) || (audioInputPath !== undefined && !path.isAbsolute(audioInputPath))) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input/output paths must be absolute." });
      return { success: false, error: "Input/output paths must be absolute." };
    }

    if (path.extname(outputPath).toLowerCase() !== ".mp4") {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: output file must use .mp4 extension." });
      return { success: false, error: "Output file must use .mp4 extension." };
    }

    if (inputPath === outputPath) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input and output files must be different." });
      return { success: false, error: "Input and output files must be different." };
    }

    const isUserApprovedOutput = approvedSavePaths.has(outputPath);
    const isInternalOutput = resolveAndValidateWritableFilePath(outputPath) !== null;
    if (!isUserApprovedOutput && !isInternalOutput) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: output path is not approved." });
      return { success: false, error: "Output path is not approved." };
    }
    if (isUserApprovedOutput) {
      approvedSavePaths.delete(outputPath);
    }

    let inputStat: fs.Stats;
    try {
      inputStat = await fs.promises.stat(inputPath);
    } catch {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input recording file does not exist." });
      return { success: false, error: "Input recording file does not exist." };
    }

    if (!inputStat.isFile()) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input path is not a file." });
      return { success: false, error: "Input path is not a file." };
    }
    console.log(`[export:mp4] video input asset path=${inputPath} size=${bytesToMiB(inputStat.size)}`);

    if (audioInputPath) {
      try {
        const audioStat = await fs.promises.stat(audioInputPath);
        if (!audioStat.isFile()) {
          emitExportProgress(sender, { stage: "failed", message: "Export failed: audio input path is not a file." });
          return { success: false, error: "Audio input path is not a file." };
        }
        console.log(`[export:mp4] audio input asset path=${audioInputPath} size=${bytesToMiB(audioStat.size)}`);
      } catch {
        emitExportProgress(sender, { stage: "failed", message: "Export failed: audio input file does not exist." });
        return { success: false, error: "Audio input file does not exist." };
      }
    } else {
      console.log("[export:mp4] no audio input asset requested.");
    }

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    preflightCompletedAt = Date.now();
    console.log(`[export:mp4][timing] preflight=${((preflightCompletedAt - requestStartedAt) / 1000).toFixed(2)}s`);

    try {
      const encodeStartedAt = Date.now();
      await exportManager.convertWebmToMp4(
        {
          inputPath,
          outputPath,
          aspectRatio: request.aspectRatio,
          fps: request.fps,
          width: request.width,
          height: request.height,
          durationSec: request.durationSec,
          audioInputPath,
          expectAudio: request.expectAudio,
          keepAspect: request.keepAspect
        },
        {
          onLog: (message) => console.log(message),
          onProgress: (percent, message, detail) => emitExportProgress(sender, { stage: "encoding", message, percent, detail })
        }
      );
      const encodeCompletedAt = Date.now();
      let outputSize = "unknown";
      try {
        const outputStat = await fs.promises.stat(outputPath);
        outputSize = bytesToMiB(outputStat.size);
      } catch {
        // Ignore output stat errors; convert call already succeeded.
      }
      console.log(
        `[export:mp4][timing] encode=${((encodeCompletedAt - encodeStartedAt) / 1000).toFixed(2)}s total=${(
          (encodeCompletedAt - requestStartedAt) /
          1000
        ).toFixed(2)}s outputSize=${outputSize}`
      );
      emitExportProgress(sender, { stage: "completed", message: "MP4 export completed.", percent: 100, detail: outputPath });
      console.log(`[export:mp4] completed output=${outputPath}`);
      return { success: true, outputPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MP4 export failed";
      console.error(`[export:mp4] failed: ${message}`);
      console.log(
        `[export:mp4][timing] failed preflight=${((preflightCompletedAt - requestStartedAt) / 1000).toFixed(2)}s total=${(
          (Date.now() - requestStartedAt) /
          1000
        ).toFixed(2)}s`
      );
      emitExportProgress(sender, { stage: "failed", message: `MP4 export failed: ${message}` });
      return { success: false, error: message };
    } finally {
      console.log(`[export:mp4] main memory at end ${formatMainMemoryUsage()}`);
    }
  });

  ipcMain.handle("export:gif", async (event, request: unknown) => {
    const sender = event.sender;
    const requestStartedAt = Date.now();
    let preflightCompletedAt = requestStartedAt;
    if (!isValidGifExportRequest(request)) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: invalid GIF request payload." });
      return { success: false, error: "Invalid GIF export request payload." };
    }

    console.log(
      `[export:gif] started input=${request.inputPath} output=${request.outputPath} fps=${request.fps ?? "default"} size=${request.width ?? "auto"}x${
        request.height ?? "auto"
      } durationSec=${request.durationSec ?? "unknown"} highQuality=${request.highQuality ?? false}`
    );
    console.log(`[export:gif] main memory at start ${formatMainMemoryUsage()}`);
    emitExportProgress(sender, { stage: "started", message: "GIF export started." });

    const inputPath = path.resolve(request.inputPath);
    const outputPath = path.resolve(request.outputPath);
    if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath)) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input/output paths must be absolute." });
      return { success: false, error: "Input/output paths must be absolute." };
    }

    if (path.extname(outputPath).toLowerCase() !== ".gif") {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: output file must use .gif extension." });
      return { success: false, error: "Output file must use .gif extension." };
    }

    const isUserApprovedOutput = approvedSavePaths.has(outputPath);
    const isInternalOutput = resolveAndValidateWritableFilePath(outputPath) !== null;
    if (!isUserApprovedOutput && !isInternalOutput) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: output path is not approved." });
      return { success: false, error: "Output path is not approved." };
    }
    if (isUserApprovedOutput) {
      approvedSavePaths.delete(outputPath);
    }

    let inputStat: fs.Stats;
    try {
      inputStat = await fs.promises.stat(inputPath);
    } catch {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input recording file does not exist." });
      return { success: false, error: "Input recording file does not exist." };
    }

    if (!inputStat.isFile()) {
      emitExportProgress(sender, { stage: "failed", message: "Export failed: input path is not a file." });
      return { success: false, error: "Input path is not a file." };
    }
    console.log(`[export:gif] video input asset path=${inputPath} size=${bytesToMiB(inputStat.size)}`);

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    preflightCompletedAt = Date.now();
    console.log(`[export:gif][timing] preflight=${((preflightCompletedAt - requestStartedAt) / 1000).toFixed(2)}s`);

    try {
      const encodeStartedAt = Date.now();
      await exportManager.convertWebmToGif(
        {
          inputPath,
          outputPath,
          fps: request.fps,
          width: request.width,
          height: request.height,
          durationSec: request.durationSec,
          highQuality: request.highQuality
        },
        {
          onLog: (message) => console.log(message),
          onProgress: (percent, message, detail) => emitExportProgress(sender, { stage: "encoding", message, percent, detail })
        }
      );
      const encodeCompletedAt = Date.now();
      let outputSize = "unknown";
      try {
        const outputStat = await fs.promises.stat(outputPath);
        outputSize = bytesToMiB(outputStat.size);
      } catch {
        // Ignore output stat errors; convert call already succeeded.
      }
      console.log(
        `[export:gif][timing] encode=${((encodeCompletedAt - encodeStartedAt) / 1000).toFixed(2)}s total=${(
          (encodeCompletedAt - requestStartedAt) /
          1000
        ).toFixed(2)}s outputSize=${outputSize}`
      );
      emitExportProgress(sender, { stage: "completed", message: "GIF export completed.", percent: 100, detail: outputPath });
      console.log(`[export:gif] completed output=${outputPath}`);
      return { success: true, outputPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : "GIF export failed";
      console.error(`[export:gif] failed: ${message}`);
      console.log(
        `[export:gif][timing] failed preflight=${((preflightCompletedAt - requestStartedAt) / 1000).toFixed(2)}s total=${(
          (Date.now() - requestStartedAt) /
          1000
        ).toFixed(2)}s`
      );
      emitExportProgress(sender, { stage: "failed", message: `GIF export failed: ${message}` });
      return { success: false, error: message };
    } finally {
      console.log(`[export:gif] main memory at end ${formatMainMemoryUsage()}`);
    }
  });

  ipcMain.handle("export:cancel", async (event) => {
    const canceled = exportManager.cancelActiveExport();
    if (canceled) {
      emitExportProgress(event.sender, { stage: "canceled", message: "Export canceled by user." });
    }
    console.log(`[export] cancel requested canceled=${canceled} memory=${formatMainMemoryUsage()}`);
    return { canceled };
  });

  ipcMain.handle("ffmpeg:status", async () => getFfmpegStatus());
}
