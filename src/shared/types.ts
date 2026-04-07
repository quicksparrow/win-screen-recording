export type AspectRatio = "16:9" | "9:16" | "1:1";
export type RawTrackType = "screen" | "webcam" | "audio";
export type BackgroundType = "none" | "gradient" | "wallpaper" | "custom-image";
export type WebcamPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type WebcamMode = "none" | "full-screen" | "small-overlay";

export interface CaptureSource {
  id: string;
  name: string;
  displayId?: string;
  appIconDataUrl?: string | null;
}

export interface WallpaperAsset {
  name: string;
  path: string;
  fileUrl: string;
}

export interface ExportRequest {
  inputPath: string;
  outputPath: string;
  aspectRatio: AspectRatio;
  fps?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  audioInputPath?: string;
  expectAudio?: boolean;
  keepAspect?: boolean;
}

export interface GifExportRequest {
  inputPath: string;
  outputPath: string;
  fps?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  highQuality?: boolean;
}

export interface RecordingArtifacts {
  projectDir: string;
  screenPath: string;
  webcamPath: string;
  audioPath: string;
  telemetryPath: string;
  manifestPath: string;
}

export interface StudioRecordingSession {
  sessionId: string;
  startedAtIso: string;
  artifacts: RecordingArtifacts;
}

export interface StudioSessionSummary {
  sourceId: string;
  aspectRatio: AspectRatio;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  captureWebcam: boolean;
  durationMs: number;
}

export interface CompletedStudioSession {
  sessionId: string;
  endedAtIso: string;
  artifacts: RecordingArtifacts;
  telemetryEventCount: number;
}

export type TelemetryEvent =
  | {
      type: "cursor";
      timestampMs: number;
      x: number;
      y: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  | {
      type: "mouse-down" | "mouse-up";
      timestampMs: number;
      x: number;
      y: number;
      button: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  | {
      type: "key-down" | "key-up";
      timestampMs: number;
      key: string;
      code: string;
      repeat: boolean;
    };

export interface TelemetryFile {
  schemaVersion: 1;
  createdAtIso: string;
  events: TelemetryEvent[];
}

export interface StudioSceneSettings {
  aspectRatio: AspectRatio;
  backgroundType: BackgroundType;
  gradientFrom: string;
  gradientTo: string;
  gradientMotion: number;
  solidColor: string;
  wallpaperUrl: string;
  backgroundBlurRadius: number;
  shadowEnabled: boolean;
  shadowBlur: number;
  shadowOpacity: number;
  shadowOffsetY: number;
  webcamMode: WebcamMode;
  webcamPosition: WebcamPosition;
  webcamRadius: number;
  webcamBorderColor: string;
  webcamBorderWidth: number;
  webcamScale: number;
  webcamBeautifyEnabled: boolean;
  webcamBeautifySmoothRadius: number;
  webcamBeautifyExposure: number;
  windowRadius: number;
}

export interface ExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface ExportProgressEvent {
  stage: "started" | "rendering" | "encoding" | "saving" | "completed" | "failed" | "canceled";
  message: string;
  percent?: number;
  detail?: string;
  timestampMs: number;
}

export interface SystemPowerStateEvent {
  state: "lock-screen" | "unlock-screen" | "suspend" | "resume";
  timestampMs: number;
}

export interface ExitConfirmationEvent {
  title: string;
  message: string;
  detail: string;
  timestampMs: number;
}

export interface RecordingSession {
  sessionId: string;
  filePath: string;
}

export interface DesktopApi {
  listCaptureSources: (types?: Array<"screen" | "window">) => Promise<CaptureSource[]>;
  listWallpapers: () => Promise<WallpaperAsset[]>;
  listAppBackgrounds: () => Promise<WallpaperAsset[]>;
  chooseSavePath: (defaultFileName: string) => Promise<string | null>;
  chooseExportPath: (defaultFileName: string, format: "mp4" | "gif") => Promise<string | null>;
  createRecordingSession: (defaultFileName: string) => Promise<RecordingSession | null>;
  appendRecordingChunk: (sessionId: string, chunk: Uint8Array) => Promise<void>;
  finishRecordingSession: (sessionId: string) => Promise<void>;
  cancelRecordingSession: (sessionId: string) => Promise<void>;
  createStudioSession: () => Promise<StudioRecordingSession | null>;
  appendTrackChunk: (sessionId: string, track: RawTrackType, chunk: Uint8Array) => Promise<void>;
  appendTelemetryEvents: (sessionId: string, events: TelemetryEvent[]) => Promise<void>;
  finishStudioSession: (sessionId: string, summary: StudioSessionSummary) => Promise<CompletedStudioSession | null>;
  cancelStudioSession: (sessionId: string) => Promise<void>;
  writeBinaryFile: (filePath: string, chunk: Uint8Array) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  copyExportFile: (sourcePath: string, outputPath: string) => Promise<ExportResult>;
  createExportRenderSession: (filePath: string) => Promise<string>;
  appendExportRenderChunk: (sessionId: string, chunk: Uint8Array) => Promise<void>;
  finishExportRenderSession: (sessionId: string) => Promise<void>;
  cancelExportRenderSession: (sessionId: string) => Promise<void>;
  exportMp4: (request: ExportRequest) => Promise<ExportResult>;
  exportGif: (request: GifExportRequest) => Promise<ExportResult>;
  cancelExport: () => Promise<{ canceled: boolean }>;
  getFfmpegStatus: () => Promise<{ path: string; exists: boolean; packaged: boolean }>;
  onExportProgress: (listener: (event: ExportProgressEvent) => void) => () => void;
  onSystemPowerState: (listener: (event: SystemPowerStateEvent) => void) => () => void;
  respondExitConfirmation: (confirmed: boolean) => void;
  onExitConfirmationRequested: (listener: (event: ExitConfirmationEvent) => void) => () => void;
}
