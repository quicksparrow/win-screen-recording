import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApi,
  ExitConfirmationEvent,
  ExportProgressEvent,
  ExportRequest,
  GifExportRequest,
  RawTrackType,
  SystemPowerStateEvent,
  StudioSessionSummary,
  TelemetryEvent
} from "../shared/types";

const api: DesktopApi = {
  listCaptureSources: (types) => ipcRenderer.invoke("capture:list-sources", types),
  listWallpapers: () => ipcRenderer.invoke("background:list-wallpapers"),
  listAppBackgrounds: () => ipcRenderer.invoke("background:list-app-backgrounds"),
  chooseSavePath: (defaultFileName) => ipcRenderer.invoke("storage:choose-save-path", defaultFileName),
  chooseExportPath: (defaultFileName, format) => ipcRenderer.invoke("storage:choose-export-path", defaultFileName, format),
  createRecordingSession: (defaultFileName) => ipcRenderer.invoke("recording:create-session", defaultFileName),
  appendRecordingChunk: (sessionId, chunk) => ipcRenderer.invoke("recording:append-chunk", sessionId, chunk),
  finishRecordingSession: (sessionId) => ipcRenderer.invoke("recording:finish-session", sessionId),
  cancelRecordingSession: (sessionId) => ipcRenderer.invoke("recording:cancel-session", sessionId),
  createStudioSession: () => ipcRenderer.invoke("recording:create-studio-session"),
  appendTrackChunk: (sessionId, track: RawTrackType, chunk) =>
    ipcRenderer.invoke("recording:append-track-chunk", sessionId, track, chunk),
  appendTelemetryEvents: (sessionId, events: TelemetryEvent[]) =>
    ipcRenderer.invoke("recording:append-telemetry-events", sessionId, events),
  finishStudioSession: (sessionId, summary: StudioSessionSummary) =>
    ipcRenderer.invoke("recording:finish-studio-session", sessionId, summary),
  cancelStudioSession: (sessionId) => ipcRenderer.invoke("recording:cancel-studio-session", sessionId),
  writeBinaryFile: (filePath, chunk) => ipcRenderer.invoke("storage:write-binary-file", filePath, chunk),
  deleteFile: (filePath) => ipcRenderer.invoke("storage:delete-file", filePath),
  copyExportFile: (sourcePath, outputPath) => ipcRenderer.invoke("storage:copy-export-file", sourcePath, outputPath),
  createExportRenderSession: (filePath) => ipcRenderer.invoke("export:create-render-session", filePath),
  appendExportRenderChunk: (sessionId, chunk) => ipcRenderer.invoke("export:append-render-chunk", sessionId, chunk),
  finishExportRenderSession: (sessionId) => ipcRenderer.invoke("export:finish-render-session", sessionId),
  cancelExportRenderSession: (sessionId) => ipcRenderer.invoke("export:cancel-render-session", sessionId),
  exportMp4: (request: ExportRequest) => ipcRenderer.invoke("export:mp4", request),
  exportGif: (request: GifExportRequest) => ipcRenderer.invoke("export:gif", request),
  cancelExport: () => ipcRenderer.invoke("export:cancel"),
  getFfmpegStatus: () => ipcRenderer.invoke("ffmpeg:status"),
  respondExitConfirmation: (confirmed: boolean) => {
    ipcRenderer.send("app:exit-confirmation-response", confirmed);
  },
  onExportProgress: (listener: (event: ExportProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ExportProgressEvent) => listener(payload);
    ipcRenderer.on("export:progress", handler);
    return () => {
      ipcRenderer.removeListener("export:progress", handler);
    };
  },
  onSystemPowerState: (listener: (event: SystemPowerStateEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: SystemPowerStateEvent) => listener(payload);
    ipcRenderer.on("system:power-state", handler);
    return () => {
      ipcRenderer.removeListener("system:power-state", handler);
    };
  },
  onExitConfirmationRequested: (listener: (event: ExitConfirmationEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ExitConfirmationEvent) => listener(payload);
    ipcRenderer.on("app:show-exit-confirmation", handler);
    return () => {
      ipcRenderer.removeListener("app:show-exit-confirmation", handler);
    };
  }
};

contextBridge.exposeInMainWorld("desktopAPI", Object.freeze(api));
