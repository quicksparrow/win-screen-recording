import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import type {
  AspectRatio,
  BackgroundType,
  CaptureSource,
  CompletedStudioSession,
  ExitConfirmationEvent,
  ExportProgressEvent,
  RawTrackType,
  StudioSceneSettings,
  TelemetryEvent,
  WallpaperAsset,
  WebcamMode,
  WebcamPosition
} from "../shared/types";
import { computeCompositorLayout, renderCompositorFrame, type CompositorFrameProfile, type CompositorLayout } from "./modules/Compositor";

type CaptureMode = "tabs" | "windows" | "screen";
type ExportFormat = "mp4" | "gif";
type OutputSizePreset = "480p" | "720p" | "1080p";
type RecordingSizePreset = "standard-16-9" | "quick-16-9" | "vertical-9-16" | "square-1-1";
type SettingsPanel = "recording" | "webcam" | "sound" | "background";
type DropdownOption<T extends string> = { value: T; label: string; secondary?: string };
type WebcamModeTransition = { from: WebcamMode; to: WebcamMode; startedAt: number; durationMs: number };
type StudioData = {
  session: CompletedStudioSession;
  screenUrl: string;
  webcamUrl: string | null;
  audioUrl: string | null;
  durationSec: number;
  telemetry: TelemetryEvent[];
  isComposited: boolean;
};
type LivePipeline = {
  sourceId: string;
  webcamEnabled: boolean;
  systemAudioEnabled: boolean;
  microphoneEnabled: boolean;
  desktopStream: MediaStream;
  cameraStream: MediaStream | null;
  micStream: MediaStream | null;
  mixedAudioStream: MediaStream | null;
  audioContext: AudioContext | null;
};
type RenderedExport = {
  key: string;
  format: ExportFormat;
  path: string;
};
type ExportFeedback = {
  tone: "success" | "error" | "info";
  title: string;
  message: string;
  detail?: string;
};

type ExportTimingTrace = {
  format: ExportFormat;
  sourceDurationSec: number;
  width: number;
  height: number;
  fps: number;
  sourceComposited: boolean;
  backgroundEnabled: boolean;
  webcamEnabled: boolean;
  enhanceEnabled: boolean;
  startedAtMs: number;
  renderStartedAtMs?: number;
  renderFinishedAtMs?: number;
  encodeStartedAtMs?: number;
  encodeFinishedAtMs?: number;
  saveStartedAtMs?: number;
  saveFinishedAtMs?: number;
  renderFrames: number;
  renderFrameCostMsTotal: number;
  renderFrameCostMsMax: number;
  chunkWrites: number;
  chunkWriteMsTotal: number;
  chunkWriteMsMax: number;
  chunkBytes: number;
  compositorBackgroundMsTotal: number;
  compositorWindowMsTotal: number;
  compositorWebcamMsTotal: number;
  compositorBeautifyMsTotal: number;
  compositorBackgroundCacheHitFrames: number;
  compositorProfileFrames: number;
};

const rates: Record<AspectRatio, number> = { "16:9": 10_000_000, "9:16": 8_500_000, "1:1": 8_000_000 };
const outputSizePixels: Record<OutputSizePreset, number> = { "480p": 480, "720p": 720, "1080p": 1080 };
const mp4FrameRates = [30, 60] as const;
const gifFrameRates = [10, 12, 15] as const;
const MAX_WEBCAM_RADIUS = 200;
const MAX_BACKGROUND_BLUR = 50;
const MIN_WEBCAM_SIZE_RADIUS = 50;
const MAX_WEBCAM_SIZE_RADIUS = 180;
const MIN_WEBCAM_BEAUTIFY_SMOOTH_RADIUS = 0;
const MAX_WEBCAM_BEAUTIFY_SMOOTH_RADIUS = 8;
const MIN_WEBCAM_BEAUTIFY_EXPOSURE = -40;
const MAX_WEBCAM_BEAUTIFY_EXPOSURE = 40;
const supportedBackgroundMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const APP_BACKGROUND_STORAGE_KEY = "studio.appBackgroundFileUrl";
const THEME_STORAGE_KEY = "studio.theme";

const WEBCAM_MODE_TRANSITION_MS = 280;
const EXPORT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const EXPORT_CANCELED_MESSAGE = "Export canceled by user.";
const EXPORT_RECORDER_CHUNK_MS = 4_000;
const BACKGROUND_COMPOSITOR_INTERVAL_MS = 50;
const WEBCAM_STALL_RECOVERY_MS = 2_500;

const sceneDefaults: StudioSceneSettings = {
  aspectRatio: "16:9",
  backgroundType: "none",
  gradientFrom: "#dceeff",
  gradientTo: "#fff4c6",
  gradientMotion: 0.3,
  solidColor: "#ebf4ff",
  wallpaperUrl: "",
  backgroundBlurRadius: 0,
  shadowEnabled: true,
  shadowBlur: 26,
  shadowOpacity: 0.16,
  shadowOffsetY: 12,
  webcamMode: "none",
  webcamPosition: "bottom-right",
  webcamRadius: MAX_WEBCAM_RADIUS,
  webcamBorderColor: "#f7fbff",
  webcamBorderWidth: 4,
  webcamScale: 0.24,
  webcamBeautifyEnabled: false,
  webcamBeautifySmoothRadius: 2,
  webcamBeautifyExposure: 0,
  windowRadius: 20
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toEven = (v: number) => {
  const rounded = Math.max(2, Math.round(v));
  return rounded % 2 === 0 ? rounded : rounded - 1;
};
const mimeVideo = () => ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((x) => MediaRecorder.isTypeSupported(x));
const mimeAudio = () => ["audio/webm;codecs=opus", "audio/webm"].find((x) => MediaRecorder.isTypeSupported(x));
const secs = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function trapFocusInContainer(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return;
  }

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}

function recordingSizePresetConfig(preset: RecordingSizePreset): { aspectRatio: AspectRatio; outputSize: OutputSizePreset } {
  if (preset === "standard-16-9") return { aspectRatio: "16:9", outputSize: "1080p" };
  if (preset === "quick-16-9") return { aspectRatio: "16:9", outputSize: "720p" };
  if (preset === "vertical-9-16") return { aspectRatio: "9:16", outputSize: "1080p" };
  return { aspectRatio: "1:1", outputSize: "1080p" };
}

function formatEstimatedMinutes(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-- min";
  if (seconds < 60) return "< 1 min";
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function formatEstimatedSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "--";
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  return `${(mib / 1024).toFixed(2)} GB`;
}

type ExportEstimateInput = {
  format: ExportFormat;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  includeAudio: boolean;
  gifHighQuality: boolean;
};

function estimateOutputSizeBytes(input: ExportEstimateInput): number {
  const durationSec = Math.max(0.1, input.durationSec);
  const pixels = Math.max(1, input.width * input.height);
  if (input.format === "mp4") {
    const fpsFactor = clamp(input.fps / 30, 0.6, 2);
    const bitsPerPixelPerFrame = 0.07 + (fpsFactor - 1) * 0.015;
    const videoBitrate = Math.max(1_800_000, Math.round(pixels * input.fps * bitsPerPixelPerFrame));
    const audioBitrate = input.includeAudio ? 192_000 : 0;
    return Math.round(((videoBitrate + audioBitrate) * durationSec) / 8);
  }

  const frameCount = Math.max(1, Math.round(durationSec * input.fps));
  const bytesPerPixelFrame = input.gifHighQuality ? 0.24 : 0.18;
  return Math.round(pixels * frameCount * bytesPerPixelFrame);
}

function estimateExportTotalSeconds(input: ExportEstimateInput): number {
  const durationSec = Math.max(0.1, input.durationSec);
  const megapixels = (input.width * input.height) / 1_000_000;
  const fpsFactor = Math.max(0.6, input.fps / 30);
  const estimatedSizeBytes = estimateOutputSizeBytes(input);
  const sizeFactorSec = estimatedSizeBytes / (input.format === "gif" ? 2_000_000 : 8_000_000);
  const formatFactor = input.format === "gif" ? (input.gifHighQuality ? 2.7 : 2.2) : 1.35;
  const renderPhaseSec = durationSec * (0.32 + megapixels * 0.06 + (fpsFactor - 1) * 0.08);
  const encodePhaseSec = durationSec * (0.25 + megapixels * 0.08 + (fpsFactor - 1) * 0.12) * formatFactor;
  return Math.max(12, renderPhaseSec + encodePhaseSec + sizeFactorSec);
}

function aspectValue(aspectRatio: AspectRatio): number {
  if (aspectRatio === "9:16") return 9 / 16;
  if (aspectRatio === "1:1") return 1;
  return 16 / 9;
}

function outputResolution(aspectRatio: AspectRatio, preset: OutputSizePreset): { width: number; height: number } {
  const shortEdge = outputSizePixels[preset];
  const ratio = aspectValue(aspectRatio);
  if (ratio >= 1) {
    return { width: toEven(shortEdge * ratio), height: toEven(shortEdge) };
  }
  return { width: toEven(shortEdge), height: toEven(shortEdge / ratio) };
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function streamHasLiveVideoTrack(stream: MediaStream | null): boolean {
  if (!stream) return false;
  return stream.getVideoTracks().some((track) => track.readyState === "live");
}

async function bindMediaSource(element: HTMLMediaElement | null, stream: MediaStream | null, muted = true): Promise<void> {
  if (!element) return;
  const currentStream = element.srcObject;
  const isStreamSwap = Boolean(stream && currentStream && currentStream !== stream);
  if (!isStreamSwap) {
    element.pause();
  }
  if (!stream) {
    element.pause();
    element.removeAttribute("src");
  }
  element.srcObject = stream;
  element.muted = muted;
  if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
  }
  if (!stream) return;
  try {
    await element.play();
  } catch {
    // Ignore autoplay restrictions for hidden media elements.
  }
}

async function createMixedAudioOutput(desktopStream: MediaStream, micStream: MediaStream | null): Promise<{ mixedAudioStream: MediaStream | null; audioContext: AudioContext | null }> {
  const audioTracks = [...desktopStream.getAudioTracks(), ...(micStream?.getAudioTracks() ?? [])];
  if (audioTracks.length === 0) {
    return { mixedAudioStream: null, audioContext: null };
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  audioTracks.forEach((track) => {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(destination);
  });

  return { mixedAudioStream: destination.stream, audioContext };
}

async function ensureMediaReadyAtStart(media: HTMLMediaElement | null): Promise<void> {
  if (!media) return;
  const waitForAnyEvent = async (events: Array<keyof HTMLMediaElementEventMap>, timeoutMs: number, readyCheck: () => boolean): Promise<void> => {
    if (readyCheck()) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timeoutId);
        events.forEach((eventName) => media.removeEventListener(eventName, finish));
        resolve();
      };
      const timeoutId = window.setTimeout(finish, timeoutMs);
      events.forEach((eventName) => media.addEventListener(eventName, finish, { once: true }));
    });
  };

  await waitForAnyEvent(["loadedmetadata", "durationchange"], 1_500, () => media.readyState >= HTMLMediaElement.HAVE_METADATA);
  await waitForAnyEvent(["loadeddata", "canplay"], 1_500, () => media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);

  const canSeek = Number.isFinite(media.duration) && media.duration > 0;
  if (canSeek) {
    const nearStart = Math.min(0.001, Math.max(0, media.duration - 0.001));
    try {
      if (nearStart > 0) {
        media.currentTime = nearStart;
        await waitForAnyEvent(["seeked", "timeupdate"], 400, () => Math.abs(media.currentTime - nearStart) < 0.005);
      }
      media.currentTime = 0;
      await waitForAnyEvent(["seeked", "timeupdate"], 400, () => media.currentTime <= 0.001);
    } catch {
      // Ignore non-seekable streams.
    }
  } else {
    try {
      media.currentTime = 0;
    } catch {
      // Ignore non-seekable streams.
    }
  }

  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function isLikelyTabSource(source: CaptureSource): boolean {
  const name = source.name.toLowerCase();
  const browserHit = ["chrome", "edge", "firefox", "brave", "opera", "vivaldi", "arc", "safari", "browser"].some((browser) => name.includes(browser));
  return browserHit && (name.includes(" - ") || name.includes(" | ") || name.includes("tab") || name.includes("â€”"));
}

function isBrowserSource(source: CaptureSource): boolean {
  const name = source.name.toLowerCase();
  return ["chrome", "edge", "firefox", "brave", "opera", "vivaldi", "arc", "safari", "browser"].some((browser) => name.includes(browser));
}

function filterSourcesByMode(list: CaptureSource[], mode: CaptureMode): CaptureSource[] {
  if (mode === "screen") {
    return list;
  }
  if (mode === "tabs") {
    const browserSources = list.filter((source) => isBrowserSource(source));
    const tabs = browserSources.filter((source) => isLikelyTabSource(source));
    if (tabs.length > 0) return tabs;
    if (browserSources.length > 0) return browserSources;
    return list;
  }
  return list;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M5 3.8c0-.7.8-1.2 1.5-.8l9.3 5.4c.7.4.7 1.4 0 1.8L6.5 15.6c-.7.4-1.5-.1-1.5-.8V3.8z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
      <rect x="4.4" y="3.4" width="4.3" height="13.2" rx="1.1" />
      <rect x="11.3" y="3.4" width="4.3" height="13.2" rx="1.1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M7.8 14.7L3.4 10.2l1.4-1.4 3 3 7-7 1.4 1.4-8.4 8.5z" />
    </svg>
  );
}

function RecordingIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="currentColor" />
      <circle cx="10" cy="10" r="3" className="fill-slate-950" />
    </svg>
  );
}

function WebcamIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
      <rect x="3.2" y="5.6" width="9.6" height="8.8" rx="2" />
      <path d="M13.8 8.2l3-1.7c.4-.2 1 .1 1 .6v5.8c0 .5-.6.8-1 .6l-3-1.7V8.2z" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
      <path d="M3.8 7.2h3l4-3v11.6l-4-3h-3v-5.6z" />
      <path d="M13.4 7.2a3.6 3.6 0 010 5.6l1.1 1.1a5.2 5.2 0 000-7.8l-1.1 1.1z" />
    </svg>
  );
}

function BackgroundIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
      <path d="M2.8 4.2A2.2 2.2 0 015 2h10a2.2 2.2 0 012.2 2.2v11.6A2.2 2.2 0 0115 18H5a2.2 2.2 0 01-2.2-2.2V4.2zM5 4a.2.2 0 00-.2.2V11l2.6-2.7a1.2 1.2 0 011.7 0l1.3 1.3 2.6-2.7a1.2 1.2 0 011.7 0l.9.9V4.2A.2.2 0 0015 4H5z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
      <path d="M11.2 2.6a1 1 0 00-1.9 0l-.3 1.3a6.3 6.3 0 00-1.5.6L6.3 3.7a1 1 0 00-1.3 0L3.7 5a1 1 0 000 1.3l.8 1.2a6.3 6.3 0 00-.6 1.5l-1.3.3a1 1 0 000 1.9l1.3.3c.1.5.3 1 .6 1.5l-.8 1.2a1 1 0 000 1.3L5 16.3a1 1 0 001.3 0l1.2-.8c.5.3 1 .5 1.5.6l.3 1.3a1 1 0 001.9 0l.3-1.3c.5-.1 1-.3 1.5-.6l1.2.8a1 1 0 001.3 0l1.3-1.3a1 1 0 000-1.3l-.8-1.2c.3-.5.5-1 .6-1.5l1.3-.3a1 1 0 000-1.9l-1.3-.3a6.3 6.3 0 00-.6-1.5l.8-1.2a1 1 0 000-1.3L15 3.7a1 1 0 00-1.3 0l-1.2.8a6.3 6.3 0 00-1.5-.6l-.3-1.3zM10.3 7a3 3 0 110 6 3 3 0 010-6z" />
    </svg>
  );
}

function InlineToggle({
  checked,
  onChange,
  ariaLabel,
  disabled = false
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-11 w-[52px] items-center justify-center disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={`pointer-events-none absolute h-6 w-11 rounded-full transition-colors ${checked ? "bg-pink-500" : "bg-slate-700"}`}
        aria-hidden="true"
      />
      <span
        className={`pointer-events-none absolute h-5 w-5 rounded-full bg-white transition-transform ${checked ? "translate-x-[10px]" : "-translate-x-[10px]"}`}
        aria-hidden="true"
      />
    </button>
  );
}

function ToggleSwitch({
  label,
  checked,
  onChange,
  disabled = false
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between rounded border border-slate-700 bg-slate-950/70 px-3 py-2 ${disabled ? "opacity-60" : ""}`}>
      <span className="text-sm text-slate-200">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-11 w-[52px] items-center justify-center disabled:cursor-not-allowed"
      >
        <span
          className={`pointer-events-none absolute h-6 w-11 rounded-full transition-colors ${checked ? "bg-pink-500" : "bg-slate-700"}`}
          aria-hidden="true"
        />
        <span
          className={`pointer-events-none absolute h-5 w-5 rounded-full bg-white transition-transform ${checked ? "translate-x-[10px]" : "-translate-x-[10px]"}`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  onOpen,
  wrapOptions = false,
  disabled = false
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (next: T) => void;
  onOpen?: () => void;
  wrapOptions?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const dropdownId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const labelId = `${dropdownId}-label`;
  const triggerId = `${dropdownId}-trigger`;
  const listboxId = `${dropdownId}-listbox`;
  const selectedTextId = `${dropdownId}-selected`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((opt) => opt.value === value)
  );
  const selectedOption = options[selectedIndex] ?? options[0];
  const activeOptionId = open ? `${dropdownId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const targetNode = event.target as Node | null;
      const eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
      const hitInsidePath = eventPath.includes(root);
      const hitInsideNode = Boolean(targetNode && root.contains(targetNode));
      const rect = root.getBoundingClientRect();
      const hitInsideBounds =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!hitInsidePath && !hitInsideNode && !hitInsideBounds) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  const maxIndex = Math.max(0, options.length - 1);
  const moveActive = (delta: number) => {
    setActiveIndex((idx) => clamp(idx + delta, 0, maxIndex));
  };
  const pickAt = (idx: number) => {
    const option = options[idx];
    if (!option || disabled) return;
    onChange(option.value);
    setOpen(false);
  };
  const openDropdown = () => {
    if (disabled) return;
    onOpen?.();
    setOpen(true);
    setActiveIndex(selectedIndex);
  };

  return (
    <div ref={rootRef} className={`relative ${disabled ? "opacity-60" : ""}`}>
      <div id={labelId} className="mb-1 text-sm text-slate-200">
        {label}
      </div>
      <button
        id={triggerId}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-labelledby={`${labelId} ${selectedTextId}`}
        aria-activedescendant={activeOptionId}
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => {
            const next = !current;
            if (next) onOpen?.();
            return next;
          });
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) {
              onOpen?.();
              setOpen(true);
              setActiveIndex(selectedIndex);
              return;
            }
            moveActive(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              onOpen?.();
              setOpen(true);
              setActiveIndex(selectedIndex);
              return;
            }
            moveActive(-1);
            return;
          }
          if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            if (!open) {
              openDropdown();
              return;
            }
            pickAt(activeIndex);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key === "Tab") {
            setOpen(false);
          }
        }}
        className="dropdown-trigger flex min-h-[44px] w-full items-start justify-between rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-left text-sm text-slate-100 transition-colors hover:border-slate-500 focus:border-pink-400 focus:outline-none disabled:cursor-not-allowed"
      >
        <span id={selectedTextId} className="min-w-0 whitespace-normal break-words">
          {selectedOption?.label ?? ""}
        </span>
        <span className="ml-3 flex shrink-0 items-center gap-2 pt-0.5">
          {selectedOption?.secondary ? <span className="text-xs text-slate-400">{selectedOption.secondary}</span> : null}
          <svg viewBox="0 0 20 20" className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true">
            <path d="M5.6 7.4L10 11.8l4.4-4.4 1.2 1.2-5.6 5.6-5.6-5.6 1.2-1.2z" fill="currentColor" />
          </svg>
        </span>
      </button>
      {open ? (
        <div
          className={`dropdown-menu absolute left-0 z-40 mt-1 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl shadow-black/40 ${
            wrapOptions ? "w-full min-w-full max-w-full" : "min-w-full w-max max-w-[44rem]"
          }`}
        >
          <ul
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            className={`max-h-60 overscroll-contain text-sm ${wrapOptions ? "overflow-y-auto overflow-x-hidden" : "overflow-auto"}`}
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <li key={option.value}>
                  <button
                    id={`${dropdownId}-option-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    title={option.label}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pickAt(index)}
                    className={`flex min-h-[44px] items-start justify-between gap-3 rounded-md px-2 py-2.5 text-left ${
                      wrapOptions ? "w-full min-w-full" : "w-max min-w-full"
                    } ${
                      active ? "bg-slate-800 text-slate-100" : "text-slate-200 hover:bg-slate-800/80"
                    }`}
                  >
                    <span className={`min-w-0 ${wrapOptions ? "whitespace-normal break-words leading-snug" : "whitespace-nowrap"}`}>{option.label}</span>
                    <span className="ml-2 flex shrink-0 items-center gap-2">
                      {option.secondary ? <span className="text-xs text-slate-400">{option.secondary}</span> : null}
                      {selected ? (
                        <span className="text-pink-400">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("screen");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [sysAudio, setSysAudio] = useState(true);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [studio, setStudio] = useState<StudioData | null>(null);
  const [settings, setSettings] = useState<StudioSceneSettings>(sceneDefaults);
  const [playback, setPlayback] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [outputSize, setOutputSize] = useState<OutputSizePreset>("1080p");
  const [exportFps, setExportFps] = useState<number>(30);
  const [gifHighQuality, setGifHighQuality] = useState(true);
  const [renderedExport, setRenderedExport] = useState<RenderedExport | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [activeSettingsPanel, setActiveSettingsPanel] = useState<SettingsPanel>("recording");
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [exportRendering, setExportRendering] = useState(false);
  const [exportCancelPending, setExportCancelPending] = useState(false);
  const [exportPercent, setExportPercent] = useState<number | null>(null);
  const [exportStageLabel, setExportStageLabel] = useState("Idle");
  const [exportElapsedSec, setExportElapsedSec] = useState(0);
  const [recordNewConfirmOpen, setRecordNewConfirmOpen] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<"record-new" | "start-recording" | null>(null);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [exitConfirmEvent, setExitConfirmEvent] = useState<ExitConfirmationEvent | null>(null);
  const [studioDownloaded, setStudioDownloaded] = useState(false);
  const [exportEtaSec, setExportEtaSec] = useState<number | null>(null);
  const [wallpapers, setWallpapers] = useState<WallpaperAsset[]>([]);
  const [wallpapersLoading, setWallpapersLoading] = useState(false);
  const [wallpapersLoaded, setWallpapersLoaded] = useState(false);
  const [wallpapersLoadError, setWallpapersLoadError] = useState<string | null>(null);
  const [appBackgrounds, setAppBackgrounds] = useState<WallpaperAsset[]>([]);
  const [appBackgroundsLoading, setAppBackgroundsLoading] = useState(false);
  const [appBackgroundsLoaded, setAppBackgroundsLoaded] = useState(false);
  const [appBackgroundsLoadError, setAppBackgroundsLoadError] = useState<string | null>(null);
  const [selectedAppBackgroundUrl, setSelectedAppBackgroundUrl] = useState<string>(() => {
    try {
      return window.localStorage.getItem(APP_BACKGROUND_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark";
    } catch {
      return false;
    }
  });
  const [studioMediaReady, setStudioMediaReady] = useState(false);

  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appContentRef = useRef<HTMLDivElement | null>(null);
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const exportPanelRef = useRef<HTMLDivElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsDialogRef = useRef<HTMLDivElement | null>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const discardDialogRef = useRef<HTMLDivElement | null>(null);
  const discardCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const exitDialogRef = useRef<HTMLDivElement | null>(null);
  const exitCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const exportHeartbeatRef = useRef<number>(0);
  const exportTimerRef = useRef<number | null>(null);
  const exportStartedAtRef = useRef<number>(0);
  const exportEtaSmoothedRef = useRef<number | null>(null);
  const exportCancelRequestedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const recordingSourceIdRef = useRef<string>("");
  const livePipelineRef = useRef<LivePipeline | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const startPerfRef = useRef(0);
  const telemetryRef = useRef<TelemetryEvent[]>([]);
  const telemetryBufferRef = useRef<TelemetryEvent[]>([]);
  const telemetryFlushRef = useRef<number | null>(null);
  const listenersOffRef = useRef<(() => void) | null>(null);
  const webcamModeRef = useRef<WebcamMode>(sceneDefaults.webcamMode);
  const webcamModeTransitionRef = useRef<WebcamModeTransition | null>(null);
  const quickRecordingSizeFallbackAppliedRef = useRef(false);
  const exportRenderActiveRef = useRef(false);
  const exportTargetFpsRef = useRef(60);
  const exportTimingRef = useRef<ExportTimingTrace | null>(null);
  const exportUsesRenderStageRef = useRef(true);
  const recsRef = useRef<{ screen: MediaRecorder | null; webcam: MediaRecorder | null; audio: MediaRecorder | null }>({
    screen: null,
    webcam: null,
    audio: null
  });
  const chunksRef = useRef<{ screen: Blob[]; webcam: Blob[]; audio: Blob[] }>({ screen: [], webcam: [], audio: [] });
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextsRef = useRef<AudioContext[]>([]);
  const [previewFrameSize, setPreviewFrameSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const exportPopoverId = useId();
  const settingsDialogId = useId();
  const settingsDialogTitleId = useId();
  const discardDialogTitleId = useId();
  const discardDialogDescriptionId = useId();
  const exitDialogTitleId = useId();
  const exitDialogDescriptionId = useId();
  const workflowSessionId = useMemo(() => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, []);
  const exportPowerStateRef = useRef<"active" | "locked" | "suspended">("active");
  const exportLockNoticeShownRef = useRef(false);
  const webcamRecoveryInFlightRef = useRef(false);
  const webcamLastMediaTimeRef = useRef(0);
  const webcamLastAdvanceAtRef = useRef(0);

  const frameRateOptions = useMemo<readonly number[]>(() => (exportFormat === "mp4" ? mp4FrameRates : gifFrameRates), [exportFormat]);
  const resolvedOutput = useMemo(() => outputResolution(settings.aspectRatio, outputSize), [settings.aspectRatio, outputSize]);
  const webcamMode = settings.webcamMode;
  const webcamEnabled = webcamMode !== "none";
  const exportRenderKey = useMemo(() => {
    if (!studio) return "";
    return JSON.stringify({
      sessionId: studio.session.sessionId,
      settings,
      webcamMode,
      sysAudio,
      mic,
      exportFormat,
      outputSize,
      exportFps,
      gifHighQuality: exportFormat === "gif" ? gifHighQuality : undefined
    });
  }, [studio, settings, webcamMode, sysAudio, mic, exportFormat, outputSize, exportFps, gifHighQuality]);
  const exportRenderPath = useMemo(() => {
    if (!studio) return null;
    const qualityToken = exportFormat === "gif" ? (gifHighQuality ? "hq" : "std") : "na";
    const toggleToken = `wm-${webcamMode}-sa${sysAudio ? 1 : 0}-m${mic ? 1 : 0}`;
    return `${studio.session.artifacts.projectDir}\\final-${exportFormat}-${outputSize}-${exportFps}-${qualityToken}-${toggleToken}.${exportFormat}`;
  }, [studio, webcamMode, sysAudio, mic, exportFormat, outputSize, exportFps, gifHighQuality]);
  const playbackRemaining = Math.max(0, (studio?.durationSec ?? 0) - playback);
  const canReuseRenderedExport = Boolean(
    renderedExport && renderedExport.key === exportRenderKey && renderedExport.path === exportRenderPath && renderedExport.format === exportFormat
  );
  const captureOptions: DropdownOption<CaptureMode>[] = [
    { value: "screen", label: "Entire Screen" },
    { value: "windows", label: "Windows" },
    { value: "tabs", label: "Tabs" }
  ];
  const sourceOptions = useMemo<DropdownOption<string>[]>(() => {
    if (!sources.length) {
      return [{ value: "", label: "No sources available" }];
    }
    return sources.map((source) => ({ value: source.id, label: source.name }));
  }, [sources]);
  const selectedSourceValue = sourceOptions.some((option) => option.value === selectedSource)
    ? selectedSource
    : (sourceOptions[0]?.value ?? "");
  const recordingSizeValue = useMemo<RecordingSizePreset>(() => {
    if (aspectRatio === "16:9") {
      return "standard-16-9";
    }
    if (aspectRatio === "9:16") return "vertical-9-16";
    return "square-1-1";
  }, [aspectRatio]);
  const recordingSizeOptions: DropdownOption<RecordingSizePreset>[] = [
    {
      value: "standard-16-9",
      label: "Standard 16:9",
      secondary: `${outputResolution("16:9", "1080p").width}x${outputResolution("16:9", "1080p").height}`
    },
    {
      value: "vertical-9-16",
      label: "Vertical 9:16",
      secondary: `${outputResolution("9:16", "1080p").width}x${outputResolution("9:16", "1080p").height}`
    },
    {
      value: "square-1-1",
      label: "Square 1:1",
      secondary: `${outputResolution("1:1", "1080p").width}x${outputResolution("1:1", "1080p").height}`
    }
  ];
  const backgroundOptions: DropdownOption<BackgroundType>[] = [
    { value: "none", label: "None" },
    { value: "gradient", label: "Gradient" },
    { value: "wallpaper", label: "Wallpaper" },
    { value: "custom-image", label: "Custom Images" }
  ];
  const webcamPositionOptions: DropdownOption<WebcamPosition>[] = [
    { value: "top-left", label: "Top Left" },
    { value: "top-right", label: "Top Right" },
    { value: "bottom-left", label: "Bottom Left" },
    { value: "bottom-right", label: "Bottom Right" }
  ];
  const webcamModeOptions: DropdownOption<WebcamMode>[] = [
    { value: "none", label: "None" },
    { value: "full-screen", label: "Full Screen" },
    { value: "small-overlay", label: "Small Overlay" }
  ];
  const exportFormatOptions: DropdownOption<ExportFormat>[] = [
    { value: "mp4", label: "MP4" },
    { value: "gif", label: "GIF" }
  ];
  const outputSizeOptions: DropdownOption<OutputSizePreset>[] = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" }
  ];
  const exportFpsOptions = useMemo<DropdownOption<string>[]>(() => frameRateOptions.map((fps) => ({ value: String(fps), label: `${fps} FPS` })), [frameRateOptions]);
  const webcamSizeRadius = Math.round((settings.webcamScale / sceneDefaults.webcamScale) * 100);
  const selectedSourceLabel = useMemo(() => sourceOptions.find((option) => option.value === selectedSourceValue)?.label ?? "", [sourceOptions, selectedSourceValue]);
  const selectedAppBackgroundAsset = useMemo(
    () => appBackgrounds.find((asset) => asset.fileUrl === selectedAppBackgroundUrl) ?? null,
    [appBackgrounds, selectedAppBackgroundUrl]
  );
  const appShellStyle = useMemo<CSSProperties>(() => {
    const activeBackgroundUrl = selectedAppBackgroundAsset?.fileUrl ?? selectedAppBackgroundUrl;
    if (!activeBackgroundUrl) {
      return {
        backgroundColor: darkMode ? "#070c14" : "#0b1320"
      };
    }
    return {
      backgroundColor: darkMode ? "#070c14" : "#0b1320",
      backgroundImage: darkMode
        ? `linear-gradient(140deg, rgba(7, 12, 20, 0.5) 0%, rgba(11, 17, 30, 0.62) 100%), url("${activeBackgroundUrl}")`
        : `linear-gradient(140deg, rgba(244, 248, 255, 0.2) 0%, rgba(234, 243, 255, 0.14) 100%), url("${activeBackgroundUrl}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat"
    };
  }, [darkMode, selectedAppBackgroundAsset, selectedAppBackgroundUrl]);
  const showPreviewFrame = Boolean(studio || recording || startingRecording || showPreview);
  const canBlurBackground = settings.backgroundType === "wallpaper" || settings.backgroundType === "custom-image";
  const exportInProgress = busy || exportRendering;
  const hasOpenModal = recordNewConfirmOpen || settingsModalOpen || exitConfirmOpen;
  const hasUndownloadedStudio = Boolean(studio && !studioDownloaded);
  const exportEstimateInput = useMemo<ExportEstimateInput | null>(() => {
    if (!studio) return null;
    return {
      format: exportFormat,
      width: resolvedOutput.width,
      height: resolvedOutput.height,
      durationSec: studio.durationSec,
      fps: exportFormat === "mp4" ? Math.max(exportFps, 30) : Math.max(exportFps, 10),
      includeAudio: exportFormat === "mp4" && Boolean(studio.audioUrl),
      gifHighQuality
    };
  }, [studio, exportFormat, resolvedOutput.width, resolvedOutput.height, exportFps, gifHighQuality]);
  const estimatedExportSizeBytes = useMemo(() => (exportEstimateInput ? estimateOutputSizeBytes(exportEstimateInput) : null), [exportEstimateInput]);
  const estimatedExportTotalSec = useMemo(() => (exportEstimateInput ? estimateExportTotalSeconds(exportEstimateInput) : null), [exportEstimateInput]);
  const exportProgressPercent = clamp(exportPercent ?? (exportInProgress ? 2 : 0), 0, 100);
  const exportRemainingLabel = formatEstimatedMinutes(exportEtaSec);
  const liveStatusMessage = useMemo(() => {
    if (error) return `Error: ${error}`;
    if (recording) return "Recording started.";
    if (startingRecording) return "Preparing recording.";
    if (exportInProgress) return `Export in progress. ${Math.round(exportProgressPercent)} percent complete.`;
    if (exportStatus) return exportStatus;
    if (studio) return "Recording ready for preview and export.";
    if (showPreview && selectedSource) return "Live preview is ready.";
    return "Ready.";
  }, [error, recording, startingRecording, exportInProgress, exportProgressPercent, exportStatus, studio, showPreview, selectedSource]);

  function markExportHeartbeat(): void {
    exportHeartbeatRef.current = Date.now();
  }

  function isExportCanceledMessage(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.includes("canceled by user") || normalized.includes("export canceled");
  }

  function throwIfExportCanceled(): void {
    if (exportCancelRequestedRef.current) {
      throw new Error(EXPORT_CANCELED_MESSAGE);
    }
  }

  function formatRendererMemory(): string {
    const perf = performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };
    const memory = perf.memory;
    if (!memory) {
      return "renderer-memory=unavailable";
    }

    const toMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `renderer-memory used=${toMiB(memory.usedJSHeapSize)} total=${toMiB(memory.totalJSHeapSize)} limit=${toMiB(memory.jsHeapSizeLimit)}`;
  }

  function logExportDiagnostic(stage: string, detail = ""): void {
    const suffix = detail ? ` ${detail}` : "";
    console.log(`[export:diag] stage=${stage}${suffix} ${formatRendererMemory()}`);
  }

  function logWorkflowDiagnostic(stage: string, detail = ""): void {
    const suffix = detail ? ` ${detail}` : "";
    console.log(`[workflow:diag] ts=${new Date().toISOString()} epochMs=${Date.now()} session=${workflowSessionId} stage=${stage}${suffix}`);
  }

  function formatTimingSeconds(durationMs: number): string {
    const sec = Math.max(0, durationMs / 1000);
    return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
  }

  function stageLabelFromProgressStage(stage: ExportProgressEvent["stage"]): string {
    if (stage === "rendering") return "Rendering";
    if (stage === "encoding") return "Encoding";
    if (stage === "saving") return "Saving";
    if (stage === "completed") return "Completed";
    if (stage === "failed") return "Failed";
    if (stage === "canceled") return "Canceled";
    return "Preparing";
  }

  function startExportTimingTrace(input: {
    format: ExportFormat;
    sourceDurationSec: number;
    width: number;
    height: number;
    fps: number;
    sourceComposited: boolean;
    backgroundEnabled: boolean;
    webcamEnabled: boolean;
    enhanceEnabled: boolean;
  }): void {
    exportTimingRef.current = {
      format: input.format,
      sourceDurationSec: input.sourceDurationSec,
      width: input.width,
      height: input.height,
      fps: input.fps,
      sourceComposited: input.sourceComposited,
      backgroundEnabled: input.backgroundEnabled,
      webcamEnabled: input.webcamEnabled,
      enhanceEnabled: input.enhanceEnabled,
      startedAtMs: performance.now(),
      renderFrames: 0,
      renderFrameCostMsTotal: 0,
      renderFrameCostMsMax: 0,
      chunkWrites: 0,
      chunkWriteMsTotal: 0,
      chunkWriteMsMax: 0,
      chunkBytes: 0,
      compositorBackgroundMsTotal: 0,
      compositorWindowMsTotal: 0,
      compositorWebcamMsTotal: 0,
      compositorBeautifyMsTotal: 0,
      compositorBackgroundCacheHitFrames: 0,
      compositorProfileFrames: 0
    };
    console.log(
      `[export:timing] start format=${input.format.toUpperCase()} sourceDurationSec=${input.sourceDurationSec.toFixed(2)} size=${input.width}x${
        input.height
      } fps=${input.fps} sourceComposited=${input.sourceComposited ? "yes" : "no"} background=${input.backgroundEnabled ? "on" : "off"} webcam=${
        input.webcamEnabled ? "on" : "off"
      } enhance=${input.enhanceEnabled ? "on" : "off"}`
    );
  }

  function markExportStageStart(stage: "render" | "encode" | "save"): void {
    const trace = exportTimingRef.current;
    if (!trace) return;
    const now = performance.now();
    if (stage === "render" && !trace.renderStartedAtMs) {
      trace.renderStartedAtMs = now;
      setExportStageLabel("Rendering");
      return;
    }
    if (stage === "encode" && !trace.encodeStartedAtMs) {
      trace.encodeStartedAtMs = now;
      setExportStageLabel("Encoding");
      return;
    }
    if (stage === "save" && !trace.saveStartedAtMs) {
      trace.saveStartedAtMs = now;
      setExportStageLabel("Saving");
    }
  }

  function markExportStageEnd(stage: "render" | "encode" | "save"): void {
    const trace = exportTimingRef.current;
    if (!trace) return;
    const now = performance.now();
    if (stage === "render" && trace.renderStartedAtMs && !trace.renderFinishedAtMs) {
      trace.renderFinishedAtMs = now;
      return;
    }
    if (stage === "encode" && trace.encodeStartedAtMs && !trace.encodeFinishedAtMs) {
      trace.encodeFinishedAtMs = now;
      return;
    }
    if (stage === "save" && trace.saveStartedAtMs && !trace.saveFinishedAtMs) {
      trace.saveFinishedAtMs = now;
    }
  }

  function recordExportRenderFrameCost(durationMs: number): void {
    const trace = exportTimingRef.current;
    if (!trace || !Number.isFinite(durationMs) || durationMs < 0) return;
    trace.renderFrames += 1;
    trace.renderFrameCostMsTotal += durationMs;
    trace.renderFrameCostMsMax = Math.max(trace.renderFrameCostMsMax, durationMs);
    if (trace.renderFrames % 300 === 0) {
      const avgMs = trace.renderFrameCostMsTotal / Math.max(1, trace.renderFrames);
      console.log(
        `[export:timing] render-frame samples=${trace.renderFrames} avgMs=${avgMs.toFixed(2)} maxMs=${trace.renderFrameCostMsMax.toFixed(2)}`
      );
    }
  }

  function recordExportChunkWrite(durationMs: number, bytes: number): void {
    const trace = exportTimingRef.current;
    if (!trace) return;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      trace.chunkWrites += 1;
      trace.chunkWriteMsTotal += durationMs;
      trace.chunkWriteMsMax = Math.max(trace.chunkWriteMsMax, durationMs);
    }
    if (Number.isFinite(bytes) && bytes > 0) {
      trace.chunkBytes += bytes;
    }
  }

  function recordCompositorProfile(profile: CompositorFrameProfile): void {
    const trace = exportTimingRef.current;
    if (!trace) return;
    trace.compositorProfileFrames += 1;
    trace.compositorBackgroundMsTotal += profile.backgroundMs;
    trace.compositorWindowMsTotal += profile.windowMs;
    trace.compositorWebcamMsTotal += profile.webcamMs;
    trace.compositorBeautifyMsTotal += profile.beautifyMs;
    if (profile.backgroundCacheHit) {
      trace.compositorBackgroundCacheHitFrames += 1;
    }
  }

  function finishExportTimingTrace(outcome: "success" | "failed" | "canceled", detail = ""): string | null {
    const trace = exportTimingRef.current;
    exportTimingRef.current = null;
    if (!trace) {
      return null;
    }

    const endMs = performance.now();
    const renderMs = trace.renderStartedAtMs ? Math.max(0, (trace.renderFinishedAtMs ?? endMs) - trace.renderStartedAtMs) : 0;
    const encodeMs = trace.encodeStartedAtMs ? Math.max(0, (trace.encodeFinishedAtMs ?? endMs) - trace.encodeStartedAtMs) : 0;
    const saveMs = trace.saveStartedAtMs ? Math.max(0, (trace.saveFinishedAtMs ?? endMs) - trace.saveStartedAtMs) : 0;
    const totalMs = Math.max(0, endMs - trace.startedAtMs);
    const stageDurations = [
      { stage: "rendering", durationMs: renderMs },
      { stage: "encoding", durationMs: encodeMs },
      { stage: "saving", durationMs: saveMs }
    ].filter((item) => item.durationMs > 0);
    const bottleneck = stageDurations.sort((a, b) => b.durationMs - a.durationMs)[0]?.stage ?? "unknown";
    const avgFrameMs = trace.renderFrames > 0 ? trace.renderFrameCostMsTotal / trace.renderFrames : 0;
    const avgChunkWriteMs = trace.chunkWrites > 0 ? trace.chunkWriteMsTotal / trace.chunkWrites : 0;
    const compositorFrames = Math.max(1, trace.compositorProfileFrames);
    const compositorBackgroundAvgMs = trace.compositorBackgroundMsTotal / compositorFrames;
    const compositorWindowAvgMs = trace.compositorWindowMsTotal / compositorFrames;
    const compositorWebcamAvgMs = trace.compositorWebcamMsTotal / compositorFrames;
    const compositorBeautifyAvgMs = trace.compositorBeautifyMsTotal / compositorFrames;
    const backgroundCacheHitRate = (trace.compositorBackgroundCacheHitFrames / compositorFrames) * 100;

    console.log(
      `[export:timing] summary outcome=${outcome} format=${trace.format.toUpperCase()} sourceDurationSec=${trace.sourceDurationSec.toFixed(
        2
      )} size=${trace.width}x${trace.height} fps=${trace.fps} sourceComposited=${trace.sourceComposited ? "yes" : "no"} background=${
        trace.backgroundEnabled ? "on" : "off"
      } webcam=${trace.webcamEnabled ? "on" : "off"} enhance=${trace.enhanceEnabled ? "on" : "off"} render=${formatTimingSeconds(
        renderMs
      )} encode=${formatTimingSeconds(
        encodeMs
      )} save=${formatTimingSeconds(saveMs)} total=${formatTimingSeconds(totalMs)} frameAvgMs=${avgFrameMs.toFixed(2)} frameMaxMs=${trace.renderFrameCostMsMax.toFixed(
        2
      )} chunkWrites=${trace.chunkWrites} chunkWriteAvgMs=${avgChunkWriteMs.toFixed(2)} chunkWriteMaxMs=${trace.chunkWriteMsMax.toFixed(2)} chunkMiB=${(
        trace.chunkBytes /
        (1024 * 1024)
      ).toFixed(2)} compositorFrames=${trace.compositorProfileFrames} compBgAvgMs=${compositorBackgroundAvgMs.toFixed(
        2
      )} compWindowAvgMs=${compositorWindowAvgMs.toFixed(2)} compWebcamAvgMs=${compositorWebcamAvgMs.toFixed(
        2
      )} compEnhanceAvgMs=${compositorBeautifyAvgMs.toFixed(2)} bgCacheHitRate=${backgroundCacheHitRate.toFixed(1)}% bottleneck=${bottleneck}${
        detail ? ` detail=${detail}` : ""
      }`
    );

    return `Render ${formatTimingSeconds(renderMs)} • Encode ${formatTimingSeconds(encodeMs)} • Save ${formatTimingSeconds(saveMs)} • Bottleneck: ${bottleneck}`;
  }

  function isExportConstrainedBySessionState(): boolean {
    return document.visibilityState !== "visible" || exportPowerStateRef.current !== "active";
  }

  function notifyExportLockConstraint(stage: string): void {
    if (exportLockNoticeShownRef.current) {
      return;
    }
    exportLockNoticeShownRef.current = true;
    const guidance =
      "Export continues while the app is running. On some Windows systems, locking the device can pause rendering until you unlock.";
    setExportFeedback({ tone: "info", title: "Background export notice", message: guidance });
    setExportStatus("Export running in background. If rendering pauses while locked, it will resume after unlock.");
    logWorkflowDiagnostic(
      "export-session-constrained",
      `stage=${stage} visibility=${document.visibilityState} powerState=${exportPowerStateRef.current}`
    );
  }

  function shouldKeepLiveWebcamActive(): boolean {
    if (studio) return false;
    if (!selectedSource || !webcamEnabled) return false;
    return showPreview || recording || startingRecording;
  }

  async function recoverLiveWebcamIfNeeded(reason: string): Promise<void> {
    if (webcamRecoveryInFlightRef.current) return;
    if (!shouldKeepLiveWebcamActive()) return;
    const live = livePipelineRef.current;
    const webcamElement = webcamVideoRef.current;
    if (!live || !webcamElement) return;

    const track = live.cameraStream?.getVideoTracks()[0] ?? null;
    const missingLiveTrack = !track || track.readyState !== "live";
    const sourceMismatch = webcamElement.srcObject !== live.cameraStream;
    const shouldResumePlayback = Boolean(webcamElement.srcObject && webcamElement.paused);
    let stalled = false;

    if (!missingLiveTrack && document.visibilityState === "visible" && webcamElement.srcObject === live.cameraStream) {
      const now = performance.now();
      if (!webcamLastAdvanceAtRef.current) {
        webcamLastAdvanceAtRef.current = now;
      }
      const hasCurrentData = webcamElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      if (hasCurrentData && !webcamElement.paused) {
        const currentTime = webcamElement.currentTime;
        if (currentTime > webcamLastMediaTimeRef.current + 0.001) {
          webcamLastMediaTimeRef.current = currentTime;
          webcamLastAdvanceAtRef.current = now;
        } else if (now - webcamLastAdvanceAtRef.current > WEBCAM_STALL_RECOVERY_MS) {
          stalled = true;
        }
      } else if (now - webcamLastAdvanceAtRef.current > WEBCAM_STALL_RECOVERY_MS) {
        stalled = true;
      }
    }

    if (!missingLiveTrack && !sourceMismatch && !shouldResumePlayback && !stalled) {
      return;
    }

    webcamRecoveryInFlightRef.current = true;
    try {
      let streamReacquired = false;
      if (missingLiveTrack) {
        stopStream(live.cameraStream);
        live.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
        if (!streamHasLiveVideoTrack(live.cameraStream)) {
          logWorkflowDiagnostic("webcam-recover:failed", `reason=${reason} step=reacquire`);
          return;
        }
        streamReacquired = true;
      }

      if (streamReacquired || sourceMismatch || shouldResumePlayback || stalled) {
        await bindMediaSource(webcamElement, live.cameraStream, true);
        webcamLastMediaTimeRef.current = webcamElement.currentTime;
        webcamLastAdvanceAtRef.current = performance.now();
        logWorkflowDiagnostic(
          "webcam-recover:success",
          `reason=${reason} reacquired=${streamReacquired ? "yes" : "no"} mismatch=${sourceMismatch ? "yes" : "no"} paused=${
            shouldResumePlayback ? "yes" : "no"
          } stalled=${stalled ? "yes" : "no"}`
        );
      }
    } finally {
      webcamRecoveryInFlightRef.current = false;
    }
  }

  function stopExportTimer(resetElapsed = false): void {
    if (exportTimerRef.current !== null) {
      window.clearInterval(exportTimerRef.current);
      exportTimerRef.current = null;
    }
    exportStartedAtRef.current = 0;
    exportEtaSmoothedRef.current = null;
    setExportEtaSec(null);
    if (resetElapsed) {
      setExportElapsedSec(0);
    }
  }

  function startExportTimer(): void {
    stopExportTimer(true);
    exportStartedAtRef.current = Date.now();
    exportTimerRef.current = window.setInterval(() => {
      if (!exportStartedAtRef.current) return;
      const elapsed = Math.max(0, Math.floor((Date.now() - exportStartedAtRef.current) / 1000));
      setExportElapsedSec(elapsed);
    }, 250);
  }

  function onExportProgressEvent(event: ExportProgressEvent): void {
    markExportHeartbeat();
    setExportStageLabel(stageLabelFromProgressStage(event.stage));
    if (event.stage === "encoding") {
      markExportStageStart("encode");
    } else if (event.stage === "completed" || event.stage === "failed" || event.stage === "canceled") {
      markExportStageEnd("encode");
    }
    const pct = typeof event.percent === "number" && Number.isFinite(event.percent) ? clamp(event.percent, 0, 100) : null;
    if (pct !== null) {
      if (event.stage === "encoding") {
        if (exportUsesRenderStageRef.current) {
          setExportPercent(clamp(72 + pct * 0.26, 72, 98));
        } else {
          setExportPercent(clamp(4 + pct * 0.94, 4, 98));
        }
      } else {
        setExportPercent(pct);
      }
    }
    setExportStatus(event.message);
    if (event.stage === "completed" || event.stage === "failed" || event.stage === "canceled") {
      setExportRendering(false);
      setExportCancelPending(false);
      if (event.stage === "canceled") {
        setExportPercent(null);
      }
    }
    console.log(`[export:progress] stage=${event.stage} message="${event.message}"${pct !== null ? ` percent=${Math.round(pct)}` : ""}${event.detail ? ` detail=${event.detail}` : ""}`);
  }

  function enqueueWrite(task: () => Promise<void>): void {
    queueRef.current = queueRef.current
      .catch(() => {})
      .then(task)
      .catch((err) => {
        console.error(err);
      });
  }

  async function waitForQueueDrain(): Promise<void> {
    let cursor = queueRef.current;
    await cursor.catch(() => {});
    while (cursor !== queueRef.current) {
      cursor = queueRef.current;
      await cursor.catch(() => {});
    }
  }

  async function refreshSources(mode: CaptureMode, reason: "initial" | "poll" | "recording-start" = "initial"): Promise<void> {
    logWorkflowDiagnostic("source-enumeration:start", `mode=${mode} reason=${reason}`);
    try {
      const typeList: Array<"screen" | "window"> = mode === "screen" ? ["screen"] : ["window"];
      const list = await window.desktopAPI.listCaptureSources(typeList);
      const filtered = filterSourcesByMode(list, mode);
      setSources(filtered);
      setSelectedSource((current) => {
        if (filtered.some((source) => source.id === current)) return current;
        return filtered[0]?.id ?? "";
      });
      logWorkflowDiagnostic("source-enumeration:success", `mode=${mode} reason=${reason} sourceCount=${filtered.length}`);
    } catch {
      setError("Failed to load capture sources.");
      setSources([]);
      setSelectedSource("");
      logWorkflowDiagnostic("source-enumeration:failed", `mode=${mode} reason=${reason}`);
    }
  }

  async function loadWallpapers(force = false): Promise<void> {
    if (wallpapersLoading) return;
    if (wallpapersLoaded && !force) return;
    setWallpapersLoading(true);
    setWallpapersLoadError(null);
    try {
      const list = await window.desktopAPI.listWallpapers();
      setWallpapers(list);
      setWallpapersLoaded(true);
    } catch {
      setWallpapers([]);
      setWallpapersLoaded(true);
      setWallpapersLoadError("Unable to load wallpapers from the wallpapers folder.");
    } finally {
      setWallpapersLoading(false);
    }
  }

  async function loadAppBackgrounds(force = false): Promise<void> {
    if (appBackgroundsLoading) return;
    if (appBackgroundsLoaded && !force) return;
    setAppBackgroundsLoading(true);
    setAppBackgroundsLoadError(null);
    try {
      const list = await window.desktopAPI.listAppBackgrounds();
      setAppBackgrounds(list);
      setAppBackgroundsLoaded(true);
    } catch {
      setAppBackgrounds([]);
      setAppBackgroundsLoaded(true);
      setAppBackgroundsLoadError("Unable to load app backgrounds from the design folder.");
    } finally {
      setAppBackgroundsLoading(false);
    }
  }

  useEffect(() => {
    logWorkflowDiagnostic("app-startup", `captureMode=${captureMode} darkMode=${darkMode ? "on" : "off"}`);
  }, []);

  useEffect(() => {
    void refreshSources(captureMode, "initial");
    const id = window.setInterval(() => {
      void refreshSources(captureMode, "poll");
    }, 3500);
    return () => window.clearInterval(id);
  }, [captureMode]);

  useEffect(() => {
    return () => {
      stopExportTimer();
      void stop(true);
    };
  }, []);

  useEffect(() => {
    setExportFps((current) => (frameRateOptions.includes(current) ? current : frameRateOptions[0]));
  }, [frameRateOptions]);

  useEffect(() => {
    if (!studio) setRenderedExport(null);
  }, [studio]);

  useEffect(() => {
    if (!studio) {
      setStudioDownloaded(false);
    }
  }, [studio]);

  useEffect(() => {
    if (!exportInProgress || !estimatedExportTotalSec) {
      exportEtaSmoothedRef.current = null;
      setExportEtaSec(null);
      return;
    }

    const progress = clamp(exportPercent ?? 0, 0, 99.5);
    const elapsed = Math.max(0, exportElapsedSec);
    const progressRatio = progress / 100;
    const heuristicTotalSec = Math.max(estimatedExportTotalSec, elapsed + 8);
    const throughputTotalSec = progressRatio >= 0.02 && elapsed >= 3 ? elapsed / Math.max(progressRatio, 0.001) : null;
    const blendedTotalSec = throughputTotalSec === null ? heuristicTotalSec : throughputTotalSec * 0.82 + heuristicTotalSec * 0.18;
    let nextEtaSec = Math.max(0, blendedTotalSec - elapsed);
    if (exportStageLabel === "Saving") {
      nextEtaSec = Math.min(nextEtaSec, 30);
    }
    if (progress >= 99) {
      nextEtaSec = Math.min(nextEtaSec, 8);
    }

    const previous = exportEtaSmoothedRef.current;
    let smoothed = previous === null ? Math.max(nextEtaSec, heuristicTotalSec * 0.35) : previous * 0.78 + nextEtaSec * 0.22;
    if (previous !== null) {
      const warmup = progressRatio < 0.14 || elapsed < 25;
      const riseAllowance = warmup ? Math.max(12, previous * 0.22) : Math.max(2, previous * 0.04);
      smoothed = Math.min(smoothed, previous + riseAllowance);
      if (!warmup) {
        smoothed = Math.min(smoothed, previous);
      }
    }
    exportEtaSmoothedRef.current = smoothed;
    setExportEtaSec(Math.max(0, smoothed));
  }, [exportInProgress, exportPercent, exportElapsedSec, estimatedExportTotalSec, exportStageLabel]);

  useEffect(() => {
    if (!exportPanelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!exportPanelRef.current) return;
      if (!exportPanelRef.current.contains(event.target as Node)) {
        setExportPanelOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [exportPanelOpen]);

  useEffect(() => {
    void loadAppBackgrounds();
  }, []);

  useEffect(() => {
    if (!settingsModalOpen) return;
    void loadAppBackgrounds();
  }, [settingsModalOpen, appBackgroundsLoaded, appBackgroundsLoading]);

  useEffect(() => {
    if (!appBackgrounds.length) return;
    const hasSelected = appBackgrounds.some((asset) => asset.fileUrl === selectedAppBackgroundUrl);
    if (!hasSelected) {
      setSelectedAppBackgroundUrl(appBackgrounds[0].fileUrl);
    }
  }, [appBackgrounds, selectedAppBackgroundUrl]);

  useEffect(() => {
    if (!selectedAppBackgroundUrl) return;
    try {
      window.localStorage.setItem(APP_BACKGROUND_STORAGE_KEY, selectedAppBackgroundUrl);
    } catch {
      // Ignore local storage failures in constrained environments.
    }
  }, [selectedAppBackgroundUrl]);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", darkMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, darkMode ? "dark" : "light");
    } catch {
      // Ignore local storage failures in constrained environments.
    }
  }, [darkMode]);

  useEffect(() => {
    if (!recordNewConfirmOpen) return;
    const dialog = discardDialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rafId = window.requestAnimationFrame(() => {
      discardCancelButtonRef.current?.focus();
    });
    if (!dialog) return () => window.cancelAnimationFrame(rafId);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDiscardConfirmation();
        return;
      }
      if (event.key === "Tab") {
        trapFocusInContainer(event, dialog);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [recordNewConfirmOpen]);

  useEffect(() => {
    if (!exitConfirmOpen) return;
    const dialog = exitDialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rafId = window.requestAnimationFrame(() => {
      exitCancelButtonRef.current?.focus();
    });
    if (!dialog) return () => window.cancelAnimationFrame(rafId);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelExitConfirmation();
        return;
      }
      if (event.key === "Tab") {
        trapFocusInContainer(event, dialog);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [exitConfirmOpen]);

  useEffect(() => {
    if (!settingsModalOpen) return;
    const dialog = settingsDialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rafId = window.requestAnimationFrame(() => {
      settingsCloseButtonRef.current?.focus();
    });
    if (!dialog) return () => window.cancelAnimationFrame(rafId);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsModalOpen(false);
        return;
      }
      if (event.key === "Tab") {
        trapFocusInContainer(event, dialog);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [settingsModalOpen]);

  useEffect(() => {
    const unsubscribe = window.desktopAPI.onExportProgress((event) => onExportProgressEvent(event));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = window.desktopAPI.onExitConfirmationRequested((event) => {
      setExitConfirmEvent(event);
      setExitConfirmOpen(true);
      setExportPanelOpen(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = window.desktopAPI.onSystemPowerState((event) => {
      if (event.state === "lock-screen") {
        exportPowerStateRef.current = "locked";
      } else if (event.state === "unlock-screen") {
        exportPowerStateRef.current = "active";
      } else if (event.state === "suspend") {
        exportPowerStateRef.current = "suspended";
      } else if (event.state === "resume") {
        exportPowerStateRef.current = "active";
      }
      logWorkflowDiagnostic("system-power-state", `state=${event.state}`);
      if (exportInProgress && isExportConstrainedBySessionState()) {
        notifyExportLockConstraint("system-power-state");
      }
      markExportHeartbeat();
    });

    const onVisibilityChange = () => {
      logWorkflowDiagnostic("renderer-visibility", `state=${document.visibilityState}`);
      if (exportInProgress && isExportConstrainedBySessionState()) {
        notifyExportLockConstraint("visibility-change");
      }
      if (!isExportConstrainedBySessionState()) {
        markExportHeartbeat();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [exportInProgress]);

  useEffect(() => {
    if (!shouldKeepLiveWebcamActive()) {
      webcamLastMediaTimeRef.current = 0;
      webcamLastAdvanceAtRef.current = 0;
      return;
    }

    void recoverLiveWebcamIfNeeded("watchdog-start");
    const onWindowFocus = () => {
      logWorkflowDiagnostic("renderer-focus", `state=${document.visibilityState}`);
      void recoverLiveWebcamIfNeeded("window-focus");
    };
    const onWindowBlur = () => {
      logWorkflowDiagnostic("renderer-blur", `state=${document.visibilityState}`);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void recoverLiveWebcamIfNeeded("visibility-visible");
      }
    };

    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    const intervalId = window.setInterval(() => {
      void recoverLiveWebcamIfNeeded("watchdog");
    }, 1_500);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [studio, selectedSource, webcamEnabled, showPreview, recording, startingRecording]);

  useEffect(() => {
    setSettings((current) => (current.aspectRatio === aspectRatio ? current : { ...current, aspectRatio }));
  }, [aspectRatio]);

  useEffect(() => {
    if (quickRecordingSizeFallbackAppliedRef.current) return;
    quickRecordingSizeFallbackAppliedRef.current = true;
    if (aspectRatio === "16:9" && outputSize === "720p") {
      setOutputSize("1080p");
    }
  }, [aspectRatio, outputSize]);

  useEffect(() => {
    const previousMode = webcamModeRef.current;
    if (previousMode === webcamMode) return;
    webcamModeTransitionRef.current = {
      from: previousMode,
      to: webcamMode,
      startedAt: performance.now(),
      durationMs: WEBCAM_MODE_TRANSITION_MS
    };
    webcamModeRef.current = webcamMode;
  }, [webcamMode]);

  useEffect(() => {
    if (activeSettingsPanel !== "background" || settings.backgroundType !== "wallpaper") return;
    void loadWallpapers();
  }, [activeSettingsPanel, settings.backgroundType, wallpapersLoaded, wallpapersLoading]);

  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const ratio = aspectValue(settings.aspectRatio);
    const updateFrameSize = () => {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(0, rect.width - 8);
      const height = Math.max(0, rect.height - 8);
      if (width < 1 || height < 1) {
        setPreviewFrameSize({ w: 0, h: 0 });
        return;
      }
      let nextW = width;
      let nextH = nextW / ratio;
      if (nextH > height) {
        nextH = height;
        nextW = nextH * ratio;
      }
      setPreviewFrameSize({ w: Math.floor(nextW), h: Math.floor(nextH) });
    };
    updateFrameSize();
    const observer = new ResizeObserver(() => updateFrameSize());
    observer.observe(viewport);
    window.addEventListener("resize", updateFrameSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateFrameSize);
    };
  }, [settings.aspectRatio]);

  useEffect(() => {
    const source = settings.wallpaperUrl.trim();
    if (!source) {
      backgroundImageRef.current = null;
      return;
    }

    let canceled = false;
    const image = new Image();
    image.onload = () => {
      if (!canceled) {
        backgroundImageRef.current = image;
      }
    };
    image.onerror = () => {
      if (!canceled) {
        backgroundImageRef.current = null;
      }
    };
    image.src = source;

    return () => {
      canceled = true;
    };
  }, [settings.wallpaperUrl]);

  async function buildLivePipeline(sourceId: string): Promise<LivePipeline> {
    const desktopStream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxFrameRate: 60 } },
      audio: sysAudio ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } } : false
    } as MediaStreamConstraints);
    const cameraStream = webcamEnabled ? await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null) : null;
    const micStream = mic ? await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => null) : null;

    const mixedAudioOutput = await createMixedAudioOutput(desktopStream, micStream);

    return {
      sourceId,
      webcamEnabled,
      systemAudioEnabled: sysAudio,
      microphoneEnabled: mic,
      desktopStream,
      cameraStream,
      micStream,
      mixedAudioStream: mixedAudioOutput.mixedAudioStream,
      audioContext: mixedAudioOutput.audioContext
    };
  }

  function teardownPipeline(live: LivePipeline | null): void {
    if (!live) return;
    stopStream(live.desktopStream);
    stopStream(live.cameraStream);
    stopStream(live.micStream);
    stopStream(live.mixedAudioStream);
    if (live.audioContext) {
      void live.audioContext.close();
    }
  }

  function teardownLivePipeline(): void {
    const live = livePipelineRef.current;
    livePipelineRef.current = null;
    teardownPipeline(live);
  }

  async function attachLivePreview(live: LivePipeline, force = false): Promise<void> {
    const screenElement = screenVideoRef.current;
    const webcamElement = webcamVideoRef.current;
    const audioElement = audioRef.current;
    if (force || screenElement?.srcObject !== live.desktopStream) {
      await bindMediaSource(screenElement, live.desktopStream, true);
    }
    if (force || webcamElement?.srcObject !== live.cameraStream) {
      await bindMediaSource(webcamElement, live.cameraStream, true);
    }
    if (force || audioElement?.srcObject !== live.mixedAudioStream) {
      await bindMediaSource(audioElement, live.mixedAudioStream, true);
    }
  }

  async function ensureLivePipeline(sourceId: string, attachPreview: boolean, options?: { requireAudioConfigMatch?: boolean }): Promise<boolean> {
    if (!sourceId) return false;
    logWorkflowDiagnostic(
      "preview-pipeline:start",
      `sourceId=${sourceId} attachPreview=${attachPreview ? "yes" : "no"} sysAudio=${sysAudio ? "on" : "off"} mic=${mic ? "on" : "off"} webcam=${webcamEnabled ? "on" : "off"}`
    );
    const requireAudioConfigMatch = options?.requireAudioConfigMatch ?? false;
    const existing = livePipelineRef.current;
    if (
      existing &&
      existing.sourceId === sourceId &&
      (!requireAudioConfigMatch || (existing.systemAudioEnabled === sysAudio && existing.microphoneEnabled === mic))
    ) {
      if (webcamEnabled && !streamHasLiveVideoTrack(existing.cameraStream)) {
        stopStream(existing.cameraStream);
        existing.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
      }
      existing.webcamEnabled = webcamEnabled;
      if (attachPreview) {
        await attachLivePreview(existing);
        setPreviewReady(true);
      }
      logWorkflowDiagnostic("preview-pipeline:ready", `sourceId=${sourceId} reused=full`);
      return true;
    }

    if (existing && existing.sourceId === sourceId && requireAudioConfigMatch && existing.systemAudioEnabled === sysAudio && existing.microphoneEnabled !== mic) {
      if (mic) {
        if (!existing.micStream) {
          existing.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => null);
        }
      } else if (existing.micStream) {
        stopStream(existing.micStream);
        existing.micStream = null;
      }
      stopStream(existing.mixedAudioStream);
      if (existing.audioContext) {
        void existing.audioContext.close();
      }
      const mixedAudioOutput = await createMixedAudioOutput(existing.desktopStream, existing.micStream);
      existing.mixedAudioStream = mixedAudioOutput.mixedAudioStream;
      existing.audioContext = mixedAudioOutput.audioContext;
      existing.microphoneEnabled = mic;
      existing.webcamEnabled = webcamEnabled;
      if (webcamEnabled && !streamHasLiveVideoTrack(existing.cameraStream)) {
        stopStream(existing.cameraStream);
        existing.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
      }
      if (attachPreview) {
        await attachLivePreview(existing);
        setPreviewReady(true);
      }
      logWorkflowDiagnostic("preview-pipeline:ready", `sourceId=${sourceId} reused=audio-refresh`);
      return true;
    }

    const previousLive = livePipelineRef.current;
    let nextLive: LivePipeline | null = null;
    try {
      nextLive = await buildLivePipeline(sourceId);
      if (attachPreview) {
        await attachLivePreview(nextLive, true);
        await ensureMediaReadyAtStart(screenVideoRef.current);
        setPreviewReady(true);
      } else {
        setPreviewReady(false);
      }
      livePipelineRef.current = nextLive;
      if (previousLive && previousLive !== nextLive) {
        teardownPipeline(previousLive);
      }
      logWorkflowDiagnostic("preview-pipeline:ready", `sourceId=${sourceId} reused=no`);
      return true;
    } catch {
      teardownPipeline(nextLive);
      if (!previousLive) {
        setPreviewReady(false);
      }
      setError("Unable to initialize capture. Check permissions.");
      logWorkflowDiagnostic("preview-pipeline:failed", `sourceId=${sourceId}`);
      return false;
    }
  }

  useEffect(() => {
    if (studio || startingRecording || !selectedSource) {
      if (!selectedSource) {
        setPreviewReady(false);
        teardownLivePipeline();
      }
      return;
    }

    if (!showPreview && !recording) {
      logWorkflowDiagnostic("preview-stop", `sourceId=${selectedSource}`);
      setPreviewReady(false);
      teardownLivePipeline();
      void bindMediaSource(screenVideoRef.current, null, true);
      void bindMediaSource(webcamVideoRef.current, null, true);
      void bindMediaSource(audioRef.current, null, true);
      return;
    }

    let cancelled = false;
    logWorkflowDiagnostic("preview-start-requested", `sourceId=${selectedSource}`);
    void ensureLivePipeline(selectedSource, true).then((ok) => {
      if (cancelled) return;
      setPreviewReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [studio, recording, startingRecording, selectedSource, webcamEnabled, showPreview, sysAudio, mic]);

  useEffect(() => {
    if (!studio) return;
    setStudioMediaReady(false);
    setPreviewReady(false);
    teardownLivePipeline();
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
      screenVideoRef.current.muted = true;
    }
    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
      webcamVideoRef.current.muted = true;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.muted = false;
    }
  }, [studio?.session.sessionId]);

  useEffect(() => {
    if (!studio) {
      setStudioMediaReady(false);
      return;
    }
    let cancelled = false;
    setStudioMediaReady(false);
    void (async () => {
      await ensureMediaReadyAtStart(screenVideoRef.current);
      if (cancelled) return;
      syncPlaybackTime(0);
      setPlaying(false);
      setStudioMediaReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [studio?.session.sessionId]);

  useEffect(() => {
    return () => {
      teardownLivePipeline();
    };
  }, []);

  function stopListeners(): void {
    if (listenersOffRef.current) listenersOffRef.current();
    listenersOffRef.current = null;
    if (telemetryFlushRef.current !== null) window.clearInterval(telemetryFlushRef.current);
    telemetryFlushRef.current = null;
  }

  function flushTelemetry(force = false): void {
    const sid = sessionIdRef.current;
    if (!sid || (!force && telemetryBufferRef.current.length === 0)) return;
    const batch = telemetryBufferRef.current.splice(0, telemetryBufferRef.current.length);
    if (!batch.length) return;
    enqueueWrite(() => window.desktopAPI.appendTelemetryEvents(sid, batch));
  }

  function startTelemetry(): void {
    startPerfRef.current = performance.now();
    telemetryRef.current = [];
    telemetryBufferRef.current = [];

    const now = () => performance.now() - startPerfRef.current;
    const push = (e: TelemetryEvent) => {
      telemetryRef.current.push(e);
      telemetryBufferRef.current.push(e);
      if (telemetryBufferRef.current.length > 40) flushTelemetry();
    };

    let lastMove = -1000;
    const move = (ev: MouseEvent) => {
      const t = now();
      if (t - lastMove < 8) return;
      lastMove = t;
      push({ type: "cursor", timestampMs: t, x: ev.clientX, y: ev.clientY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    };
    const down = (ev: MouseEvent) => {
      const elapsedMs = now();
      push({ type: "mouse-down", timestampMs: elapsedMs, x: ev.clientX, y: ev.clientY, button: ev.button, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    };
    const up = (ev: MouseEvent) =>
      push({ type: "mouse-up", timestampMs: now(), x: ev.clientX, y: ev.clientY, button: ev.button, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    const kd = (ev: KeyboardEvent) => push({ type: "key-down", timestampMs: now(), key: ev.key, code: ev.code, repeat: ev.repeat });
    const ku = (ev: KeyboardEvent) => push({ type: "key-up", timestampMs: now(), key: ev.key, code: ev.code, repeat: ev.repeat });

    window.addEventListener("mousemove", move, true);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);

    listenersOffRef.current = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
    };

    telemetryFlushRef.current = window.setInterval(() => flushTelemetry(), 250);
  }

  async function stop(cancel = false): Promise<void> {
    const sid = sessionIdRef.current;
    if (!sid) return;

    stopListeners();

    const activeRecorders = Object.values(recsRef.current).filter((r): r is MediaRecorder => Boolean(r));
    await Promise.all(
      activeRecorders.map(
        (recorder) =>
          new Promise<void>((resolve) => {
            if (recorder.state === "inactive") {
              resolve();
              return;
            }
            recorder.addEventListener("stop", () => resolve(), { once: true });
            try {
              recorder.requestData();
            } catch {
              // Ignore requestData failures from recorders that are stopping.
            }
            recorder.stop();
          })
      )
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    streamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    streamsRef.current = [];

    audioContextsRef.current.forEach((ctx) => {
      void ctx.close();
    });
    audioContextsRef.current = [];
    livePipelineRef.current = null;
    setPreviewReady(false);

    recsRef.current = { screen: null, webcam: null, audio: null };

    flushTelemetry(true);
    await waitForQueueDrain();

    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    sessionIdRef.current = null;

    if (cancel) {
      await window.desktopAPI.cancelStudioSession(sid);
      recordingSourceIdRef.current = "";
      setRecording(false);
      return;
    }

    const done = await window.desktopAPI.finishStudioSession(sid, {
      sourceId: recordingSourceIdRef.current || selectedSource,
      aspectRatio,
      captureSystemAudio: sysAudio,
      captureMicrophone: mic,
      captureWebcam: webcamEnabled,
      durationMs: performance.now() - startPerfRef.current
    });

    recordingSourceIdRef.current = "";
    if (done) {
      setStudioMediaReady(false);
      const screenUrl = URL.createObjectURL(new Blob(chunksRef.current.screen, { type: mimeVideo() ?? "video/webm" }));
      const audioUrl = chunksRef.current.audio.length ? URL.createObjectURL(new Blob(chunksRef.current.audio, { type: mimeAudio() ?? "audio/webm" })) : null;
      setStudio({
        session: done,
        screenUrl,
        webcamUrl: null,
        audioUrl,
        durationSec: Math.max(0.01, (performance.now() - startPerfRef.current) / 1000),
        telemetry: telemetryRef.current.slice(),
        isComposited: true
      });
      setStudioDownloaded(false);
      setSettings((s) => ({ ...s, aspectRatio }));
      setRenderedExport(null);
      setExportStatus("");
      setPlayback(0);
      setPlaying(false);
    }
    setRecording(false);
  }

  async function start(): Promise<void> {
    if (recording || busy || startingRecording) return;
    logWorkflowDiagnostic("recording-start:requested", `captureMode=${captureMode} selectedSource=${selectedSource || "none"}`);
    setStartingRecording(true);
    setError(null);

    try {
      const typeList: Array<"screen" | "window"> = captureMode === "screen" ? ["screen"] : ["window"];
      const latestRaw = await window.desktopAPI.listCaptureSources(typeList).catch(() => []);
      const latest = filterSourcesByMode(latestRaw, captureMode);
      const activeSourceId = latest.find((source) => source.id === selectedSource)?.id ?? latest[0]?.id ?? "";
      logWorkflowDiagnostic("recording-start:source-selection", `captureMode=${captureMode} sourceCount=${latest.length} activeSourceId=${activeSourceId || "none"}`);
      setSources(latest);
      setSelectedSource(activeSourceId);
      if (!activeSourceId) {
        setError("No capture sources available. Open a window or select Entire Screen.");
        return;
      }

      const liveReady = await ensureLivePipeline(activeSourceId, true, { requireAudioConfigMatch: true });
      const live = livePipelineRef.current;
      if (!liveReady || !live || live.sourceId !== activeSourceId) {
        setError("Unable to initialize recording pipeline.");
        return;
      }

      setStudioMediaReady(false);
      setStudio(null);
      setStudioDownloaded(false);
      setPlayback(0);
      setPlaying(false);
      setRenderedExport(null);
      setExportStatus("");
      chunksRef.current = { screen: [], webcam: [], audio: [] };
      queueRef.current = Promise.resolve();

      const session = await window.desktopAPI.createStudioSession();
      if (!session) return;
      sessionIdRef.current = session.sessionId;
      recordingSourceIdRef.current = activeSourceId;

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const canvas = canvasRef.current;
      if (!canvas) {
        setError("Preview canvas is unavailable.");
        return;
      }
      await ensureMediaReadyAtStart(screenVideoRef.current);
      canvas.width = resolvedOutput.width;
      canvas.height = resolvedOutput.height;
      const screenVideo = screenVideoRef.current;
      const startCtx = canvas.getContext("2d");
      if (screenVideo && startCtx) {
        const sourceW = screenVideo.videoWidth || resolvedOutput.width;
        const sourceH = screenVideo.videoHeight || resolvedOutput.height;
        const layout = computeCompositorLayout(resolvedOutput.width, resolvedOutput.height, sourceW, sourceH, settings.backgroundType);
        renderCompositorFrame({
          ctx: startCtx,
          frameWidth: resolvedOutput.width,
          frameHeight: resolvedOutput.height,
          screenVideo,
          sourceWidth: sourceW,
          sourceHeight: sourceH,
          settings,
          backgroundImage: backgroundImageRef.current,
          webcamEnabled,
          webcamVideo: webcamVideoRef.current,
          maxWebcamRadiusSetting: MAX_WEBCAM_RADIUS,
          layout,
          webcamMode
        });
      }
      const composedCanvasStream = canvas.captureStream(60);
      const screenStream = new MediaStream(composedCanvasStream.getVideoTracks());
      const audioStream = new MediaStream(live.mixedAudioStream?.getAudioTracks() ?? []);

      const mk = (kind: RawTrackType, stream: MediaStream, opts: MediaRecorderOptions, store: Blob[]) => {
        if (!stream.getTracks().length) return null;
        const recorder = new MediaRecorder(stream, opts);
        recorder.ondataavailable = (ev) => {
          if (!ev.data.size) return;
          store.push(ev.data);
          const activeSessionId = sessionIdRef.current;
          if (!activeSessionId) return;
          enqueueWrite(async () => window.desktopAPI.appendTrackChunk(activeSessionId, kind, new Uint8Array(await ev.data.arrayBuffer())));
        };
        return recorder;
      };

      recsRef.current.screen = mk("screen", screenStream, { videoBitsPerSecond: rates[aspectRatio], mimeType: mimeVideo() }, chunksRef.current.screen);
      recsRef.current.webcam = null;
      recsRef.current.audio = mk("audio", audioStream, { audioBitsPerSecond: 192_000, mimeType: mimeAudio() }, chunksRef.current.audio);

      streamsRef.current = [composedCanvasStream, live.desktopStream];
      if (live.cameraStream) streamsRef.current.push(live.cameraStream);
      if (live.micStream) streamsRef.current.push(live.micStream);
      if (live.mixedAudioStream) streamsRef.current.push(live.mixedAudioStream);
      audioContextsRef.current = live.audioContext ? [live.audioContext] : [];

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve());
        });
      });
      startTelemetry();
      Object.values(recsRef.current).forEach((recorder) => recorder?.start(1000));
      setElapsed(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => setElapsed((x) => x + 1), 1000);
      logWorkflowDiagnostic("recording-start:ready", `sourceId=${activeSourceId} mic=${mic ? "on" : "off"} sysAudio=${sysAudio ? "on" : "off"}`);
    } catch (error) {
      setError("Unable to start recording. Check permissions.");
      logWorkflowDiagnostic("recording-start:failed", `reason=${error instanceof Error ? error.message : "unknown"}`);
      await stop(true);
    } finally {
      setStartingRecording(false);
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const screenVideo = screenVideoRef.current;
    if (!canvas || !screenVideo) return;
    if (!studio && !previewReady && !recording) return;
    if (studio && !studioMediaReady) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafHandle: number | null = null;
    let timeoutHandle: number | null = null;
    let disposed = false;
    let lastRenderAt = 0;
    const scheduleNextFrame = () => {
      if (disposed) return;
      if (document.visibilityState === "visible") {
        rafHandle = window.requestAnimationFrame(draw);
      } else {
        timeoutHandle = window.setTimeout(() => draw(performance.now()), BACKGROUND_COMPOSITOR_INTERVAL_MS);
      }
    };
    const draw = (timestamp: number) => {
      const exportTargetFps = exportRenderActiveRef.current ? clamp(exportTargetFpsRef.current, 10, 60) : 60;
      const targetFps = exportRenderActiveRef.current ? exportTargetFps : recording || playing ? 60 : 30;
      const minFrameInterval = 1000 / targetFps;
      if (timestamp - lastRenderAt < minFrameInterval) {
        scheduleNextFrame();
        return;
      }
      lastRenderAt = timestamp;

      const out = { w: resolvedOutput.width, h: resolvedOutput.height };
      if (canvas.width !== out.w || canvas.height !== out.h) {
        canvas.width = out.w;
        canvas.height = out.h;
      }

      const reviewMode = Boolean(studio);
      const tMs = reviewMode
        ? (exportRenderActiveRef.current ? screenVideo.currentTime : playing ? screenVideo.currentTime : playback) * 1000
        : performance.now();
      const hasScreenFrame = screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && screenVideo.videoWidth > 0 && screenVideo.videoHeight > 0;
      if (!hasScreenFrame) {
        scheduleNextFrame();
        return;
      }
      const sourceW = screenVideo.videoWidth || out.w;
      const sourceH = screenVideo.videoHeight || out.h;
      const isCompositedReview = Boolean(studio?.isComposited);
      const layout: CompositorLayout = isCompositedReview
        ? computeCompositorLayout(out.w, out.h, sourceW, sourceH, "none")
        : computeCompositorLayout(out.w, out.h, sourceW, sourceH, settings.backgroundType);
      let webcamTransitionFromMode: WebcamMode | null = null;
      let webcamTransitionProgress = 1;
      if (!reviewMode) {
        const transition = webcamModeTransitionRef.current;
        if (transition) {
          if (transition.from === "none" && transition.to !== "none") {
            const webcamVideo = webcamVideoRef.current;
            const webcamReady = Boolean(webcamVideo && webcamVideo.videoWidth > 0 && webcamVideo.videoHeight > 0);
            if (!webcamReady) {
              transition.startedAt = tMs;
            }
          }
          webcamTransitionFromMode = transition.from;
          webcamTransitionProgress = clamp((tMs - transition.startedAt) / Math.max(1, transition.durationMs), 0, 1);
          if (webcamTransitionProgress >= 1) {
            webcamModeTransitionRef.current = null;
            webcamTransitionFromMode = null;
          }
        }
      }
      const webcamVisibleForRender = webcamMode !== "none" || Boolean(webcamTransitionFromMode && webcamTransitionFromMode !== "none");

      const renderStartedAt = exportRenderActiveRef.current ? performance.now() : 0;
      renderCompositorFrame({
        ctx,
        frameWidth: out.w,
        frameHeight: out.h,
        screenVideo,
        sourceWidth: sourceW,
        sourceHeight: sourceH,
        settings,
        backgroundImage: backgroundImageRef.current,
        webcamEnabled: webcamVisibleForRender,
        webcamVideo: webcamVideoRef.current,
        maxWebcamRadiusSetting: MAX_WEBCAM_RADIUS,
        layout,
        webcamMode,
        webcamTransitionFromMode,
        webcamTransitionProgress,
        passthroughSource: isCompositedReview,
        onProfile: exportRenderActiveRef.current ? (profile) => recordCompositorProfile(profile) : undefined
      });
      if (exportRenderActiveRef.current) {
        recordExportRenderFrameCost(performance.now() - renderStartedAt);
      }

      scheduleNextFrame();
    };

    scheduleNextFrame();
    return () => {
      disposed = true;
      if (rafHandle !== null) {
        window.cancelAnimationFrame(rafHandle);
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    };
  }, [studio, studioMediaReady, previewReady, recording, webcamEnabled, webcamMode, settings, playing, playback, resolvedOutput.width, resolvedOutput.height]);

  useEffect(() => {
    const screenVideo = screenVideoRef.current;
    if (!screenVideo || !studio) return;

    const updateTime = () => {
      if (exportRenderActiveRef.current) return;
      const current = Math.max(0, Math.min(studio.durationSec, screenVideo.currentTime));
      setPlayback(current);
    };
    const onPlay = () => {
      if (!exportRenderActiveRef.current) {
        setPlaying(true);
      }
    };
    const onPause = () => {
      if (!exportRenderActiveRef.current) {
        setPlaying(false);
      }
    };
    const onEnded = () => {
      if (exportRenderActiveRef.current) return;
      screenVideo.pause();
      webcamVideoRef.current?.pause();
      audioRef.current?.pause();
      setPlaying(false);
      syncPlaybackTime(0);
    };
    const onLoadedMetadata = () => {
      if (exportRenderActiveRef.current) return;
      updateTime();
    };

    screenVideo.addEventListener("timeupdate", updateTime);
    screenVideo.addEventListener("play", onPlay);
    screenVideo.addEventListener("pause", onPause);
    screenVideo.addEventListener("ended", onEnded);
    screenVideo.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      screenVideo.removeEventListener("timeupdate", updateTime);
      screenVideo.removeEventListener("play", onPlay);
      screenVideo.removeEventListener("pause", onPause);
      screenVideo.removeEventListener("ended", onEnded);
      screenVideo.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [studio?.session.sessionId, studio?.durationSec]);

  function syncPlaybackTime(time: number): void {
    const bounded = Math.max(0, Math.min(studio?.durationSec ?? 0, time));
    setPlayback(bounded);
    if (screenVideoRef.current) screenVideoRef.current.currentTime = bounded;
    if (webcamVideoRef.current) webcamVideoRef.current.currentTime = bounded;
    if (audioRef.current) audioRef.current.currentTime = bounded;
  }

  async function togglePlay(): Promise<void> {
    if (!studio || !screenVideoRef.current || busy) return;
    if (playing) {
      setPlaying(false);
      screenVideoRef.current.pause();
      webcamVideoRef.current?.pause();
      audioRef.current?.pause();
      return;
    }

    if (playback >= studio.durationSec - 0.03) {
      syncPlaybackTime(0);
    } else {
      syncPlaybackTime(playback);
    }

    await screenVideoRef.current.play();
    if (webcamVideoRef.current?.currentSrc) {
      await webcamVideoRef.current.play().catch(() => {});
    }
    if (audioRef.current) await audioRef.current.play();
    setPlaying(true);
  }

  function openBackgroundFilePicker(): void {
    backgroundInputRef.current?.click();
  }

  function handleBackgroundFileSelected(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const hasSupportedType = supportedBackgroundMimeTypes.has(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!hasSupportedType) {
      setError("Unsupported background format. Use JPG, PNG, or WebP.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return;
      setSettings((prev) => ({ ...prev, backgroundType: "custom-image", wallpaperUrl: dataUrl }));
      setError(null);
    };
    reader.onerror = () => {
      setError("Unable to read the selected image.");
    };
    reader.readAsDataURL(file);
  }

  async function renderFinalExport(outputPath: string, format: ExportFormat): Promise<void> {
    if (!studio) {
      throw new Error("No recording is available to export.");
    }

    const canvas = canvasRef.current;
    const screenVideo = screenVideoRef.current;
    if (!canvas || !screenVideo) {
      throw new Error("Export renderer is not ready.");
    }
    await ensureMediaReadyAtStart(screenVideo);
    throwIfExportCanceled();

    const label = format.toUpperCase();
    const renderFps = format === "mp4" ? Math.max(exportFps, 30) : Math.max(exportFps, 15);
    const resumeTime = playback;
    const includeAudio = format === "mp4" && Boolean(studio.audioUrl);
    const targetWidth = resolvedOutput.width;
    const targetHeight = resolvedOutput.height;
    const backgroundEnabled = settings.backgroundType !== "none";
    const enhanceEnabled = webcamEnabled && settings.webcamBeautifyEnabled;
    console.log(
      `[export:ui] started format=${label} output=${outputPath} fps=${format === "mp4" ? renderFps : exportFps} size=${targetWidth}x${targetHeight} durationSec=${studio.durationSec.toFixed(
        2
      )}`
    );
    logExportDiagnostic(
      "export-processing-start",
      `format=${label} durationSec=${studio.durationSec.toFixed(2)} size=${targetWidth}x${targetHeight} fps=${format === "mp4" ? renderFps : exportFps} sourceComposited=${
        studio.isComposited ? "yes" : "no"
      } background=${backgroundEnabled ? "on" : "off"} webcam=${webcamEnabled ? "on" : "off"} enhance=${enhanceEnabled ? "on" : "off"}`
    );
    markExportHeartbeat();
    setExportPercent(0);
    setExportStatus(`Preparing ${label} export...`);
    setPlaying(false);
    setExportRendering(true);

    const canUseDirectEncode = format === "mp4" && studio.isComposited;
    exportUsesRenderStageRef.current = !canUseDirectEncode;
    if (canUseDirectEncode) {
      let directOutputReady = false;
      try {
        screenVideo.pause();
        webcamVideoRef.current?.pause();
        audioRef.current?.pause();
        await window.desktopAPI.deleteFile(outputPath);
        throwIfExportCanceled();
        markExportStageStart("encode");
        setExportPercent(4);
        setExportStatus(`Encoding ${label}...`);
        logExportDiagnostic("encode-direct-start", `input=${studio.session.artifacts.screenPath} output=${outputPath}`);
        const result = await window.desktopAPI.exportMp4({
          inputPath: studio.session.artifacts.screenPath,
          outputPath,
          aspectRatio: settings.aspectRatio,
          fps: renderFps,
          width: targetWidth,
          height: targetHeight,
          durationSec: studio.durationSec,
          audioInputPath: includeAudio ? studio.session.artifacts.audioPath : undefined,
          expectAudio: includeAudio,
          keepAspect: true
        });
        if (!result.success) {
          throw new Error(result.error || "Export failed");
        }
        directOutputReady = true;
        setRenderedExport({ key: exportRenderKey, format, path: outputPath });
        setExportPercent((previous) => clamp(Math.max(previous ?? 0, 98), 0, 98));
        setExportStatus(`${label} rendered successfully.`);
        logExportDiagnostic("encode-direct-complete", `output=${outputPath}`);
        return;
      } catch (e) {
        setRenderedExport(null);
        setExportPercent(null);
        const message = e instanceof Error ? e.message : "Export failed";
        setExportStatus(message);
        logExportDiagnostic("encode-direct-failed", `reason=${message}`);
        console.error(`[export:ui] direct export failed: ${message}`);
        throw new Error(message);
      } finally {
        markExportStageEnd("encode");
        if (!directOutputReady) {
          await window.desktopAPI.deleteFile(outputPath);
        }
        screenVideo.pause();
        webcamVideoRef.current?.pause();
        audioRef.current?.pause();
        setPlaying(false);
        syncPlaybackTime(resumeTime);
        setExportRendering(false);
      }
    }

    markExportStageStart("render");
    exportTargetFpsRef.current = renderFps;

    let tempWebmPath = "";
    let encodedOutputReady = false;
    let renderSessionId: string | null = null;
    let renderSessionClosed = false;
    let chunkWriteError: Error | null = null;
    let chunkCount = 0;
    let chunkBytes = 0;
    let chunkWriteQueue: Promise<void> = Promise.resolve();
    let lastMemoryLogAt = Date.now();
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;

    const maybeLogRenderMemory = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastMemoryLogAt < 10_000) {
        return;
      }
      lastMemoryLogAt = now;
      logExportDiagnostic("render-progress", `chunks=${chunkCount} chunkMiB=${(chunkBytes / (1024 * 1024)).toFixed(2)}`);
    };

    const queueRenderChunk = (blob: Blob): void => {
      if (!blob.size || !renderSessionId || renderSessionClosed) {
        return;
      }

      chunkWriteQueue = chunkWriteQueue
        .then(async () => {
          if (renderSessionClosed) {
            return;
          }
          const buffer = new Uint8Array(await blob.arrayBuffer());
          if (!buffer.byteLength) {
            return;
          }
          const writeStartedAt = performance.now();
          await window.desktopAPI.appendExportRenderChunk(renderSessionId as string, buffer);
          recordExportChunkWrite(performance.now() - writeStartedAt, buffer.byteLength);
          chunkCount += 1;
          chunkBytes += buffer.byteLength;
          maybeLogRenderMemory();
        })
        .catch((error) => {
          if (!chunkWriteError) {
            chunkWriteError = error instanceof Error ? error : new Error("Failed while writing render chunk.");
          }
        });
    };

    try {
      screenVideo.pause();
      webcamVideoRef.current?.pause();
      audioRef.current?.pause();
      exportRenderActiveRef.current = true;

      tempWebmPath = `${studio.session.artifacts.projectDir}\\render-${Date.now()}.webm`;
      await window.desktopAPI.deleteFile(tempWebmPath);
      await window.desktopAPI.deleteFile(outputPath);
      renderSessionId = await window.desktopAPI.createExportRenderSession(tempWebmPath);

      stream = canvas.captureStream(renderFps);
      recorder = new MediaRecorder(stream, { mimeType: mimeVideo() ?? "video/webm", videoBitsPerSecond: 14_000_000 });
      recorder.ondataavailable = (event) => {
        queueRenderChunk(event.data);
      };
      recorder.start(EXPORT_RECORDER_CHUNK_MS);

      const dur = studio.durationSec;
      screenVideo.currentTime = 0;
      if (webcamVideoRef.current?.currentSrc) webcamVideoRef.current.currentTime = 0;
      await screenVideo.play();
      if (webcamVideoRef.current?.currentSrc) {
        await webcamVideoRef.current.play().catch(() => {});
      }

      await new Promise<void>((resolve, reject) => {
        let lastProgressAt = Date.now();
        let lastTime = screenVideo.currentTime;
        let activeElapsedMs = 0;
        let lastTickAt = Date.now();
        const maxActiveRenderMs = Math.max(60_000, dur * 5_000);
        const checkInterval = window.setInterval(() => {
          const now = Date.now();
          const delta = Math.max(0, now - lastTickAt);
          lastTickAt = now;
          if (exportCancelRequestedRef.current) {
            window.clearInterval(checkInterval);
            reject(new Error(EXPORT_CANCELED_MESSAGE));
            return;
          }
          if (chunkWriteError) {
            window.clearInterval(checkInterval);
            reject(chunkWriteError);
            return;
          }
          if (isExportConstrainedBySessionState()) {
            lastProgressAt = now;
            markExportHeartbeat();
            notifyExportLockConstraint("render-playback");
            maybeLogRenderMemory();
            return;
          }
          activeElapsedMs += delta;
          const current = screenVideo.currentTime;
          if (current > lastTime + 0.001) {
            lastProgressAt = now;
            lastTime = current;
          }
          if (activeElapsedMs > maxActiveRenderMs) {
            window.clearInterval(checkInterval);
            reject(new Error(`Export playback timed out after ${Math.round(maxActiveRenderMs / 1000)} seconds of active rendering.`));
            return;
          }
          if (now - lastProgressAt > EXPORT_IDLE_TIMEOUT_MS) {
            window.clearInterval(checkInterval);
            reject(new Error(`Export stalled during render playback (no progress for ${EXPORT_IDLE_TIMEOUT_MS / 1000}s).`));
            return;
          }
          const renderPercent = clamp((current / Math.max(0.001, dur)) * 70, 0, 70);
          setExportPercent(renderPercent);
          setExportStatus(`Rendering ${label}... ${Math.round(renderPercent)}%`);
          markExportHeartbeat();
          maybeLogRenderMemory();
          if (screenVideo.currentTime >= dur - 0.03 || screenVideo.ended) {
            window.clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      const stopped = new Promise<void>((resolve) => {
        if (!recorder) {
          resolve();
          return;
        }
        recorder.onstop = () => resolve();
      });
      recorder.stop();
      await stopped;
      await chunkWriteQueue;
      if (chunkWriteError) {
        throw chunkWriteError;
      }
      throwIfExportCanceled();
      if (!renderSessionId) {
        throw new Error("Render session did not initialize.");
      }
      await window.desktopAPI.finishExportRenderSession(renderSessionId);
      renderSessionClosed = true;
      markExportHeartbeat();
      setExportPercent(72);
      setExportStatus(`Encoding ${label}...`);
      markExportStageEnd("render");
      markExportStageStart("encode");
      logExportDiagnostic("encode-start", `temp=${tempWebmPath} chunks=${chunkCount} chunkMiB=${(chunkBytes / (1024 * 1024)).toFixed(2)}`);
      console.log(`[export:ui] encoder step starting. temp=${tempWebmPath}`);
      throwIfExportCanceled();

      let result: { success: boolean; outputPath?: string; error?: string };
      try {
        result =
          format === "mp4"
            ? await window.desktopAPI.exportMp4({
                inputPath: tempWebmPath,
                outputPath,
                aspectRatio: settings.aspectRatio,
                fps: renderFps,
                width: targetWidth,
                height: targetHeight,
                durationSec: studio.durationSec,
                audioInputPath: includeAudio ? studio.session.artifacts.audioPath : undefined,
                expectAudio: includeAudio,
                keepAspect: true
              })
            : await window.desktopAPI.exportGif({
                inputPath: tempWebmPath,
                outputPath,
                fps: exportFps,
                width: targetWidth,
                height: targetHeight,
                durationSec: studio.durationSec,
                highQuality: gifHighQuality
              });
      } finally {
        markExportStageEnd("encode");
      }

      if (!result.success) throw new Error(result.error || "Export failed");

      encodedOutputReady = true;
      setRenderedExport({ key: exportRenderKey, format, path: outputPath });
      setExportPercent((previous) => clamp(Math.max(previous ?? 0, 98), 0, 98));
      setExportStatus(`${label} rendered successfully.`);
      logExportDiagnostic("encode-complete", `output=${outputPath}`);
      console.log(`[export:ui] encoder step completed output=${outputPath}`);
    } catch (e) {
      markExportStageEnd("render");
      markExportStageEnd("encode");
      setRenderedExport(null);
      setExportPercent(null);
      const message = e instanceof Error ? e.message : "Export failed";
      setExportStatus(message);
      logExportDiagnostic("render-failed", `reason=${message}`);
      console.error(`[export:ui] export render failed: ${message}`);
      throw new Error(message);
    } finally {
      if (!renderSessionClosed && renderSessionId) {
        await window.desktopAPI.cancelExportRenderSession(renderSessionId);
        renderSessionClosed = true;
      }
      if (tempWebmPath) {
        await window.desktopAPI.deleteFile(tempWebmPath);
      }
      if (!encodedOutputReady) {
        await window.desktopAPI.deleteFile(outputPath);
      }
      maybeLogRenderMemory(true);
      exportRenderActiveRef.current = false;
      exportTargetFpsRef.current = 60;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      if (stream) stream.getTracks().forEach((track) => track.stop());
      screenVideo.pause();
      webcamVideoRef.current?.pause();
      audioRef.current?.pause();
      setPlaying(false);
      syncPlaybackTime(resumeTime);
      setExportRendering(false);
    }
  }

  async function saveRenderedExport(sourcePath: string, destinationPath: string, format: ExportFormat): Promise<void> {
    throwIfExportCanceled();
    markExportHeartbeat();
    markExportStageStart("save");
    setExportPercent((previous) => clamp(Math.max(previous ?? 0, 99), 0, 99));
    setExportStatus(`Saving ${format.toUpperCase()}...`);
    logExportDiagnostic("save-start", `source=${sourcePath} destination=${destinationPath}`);
    try {
      const result = await window.desktopAPI.copyExportFile(sourcePath, destinationPath);
      if (!result.success) {
        if ((result.error || "").includes("does not exist")) {
          setRenderedExport(null);
        }
        throw new Error(result.error || "Download failed");
      }
      console.log(`[export:ui] saved output=${destinationPath}`);
      logExportDiagnostic("save-complete", `destination=${destinationPath}`);
      setStudioDownloaded(true);
      setExportStatus("Export complete.");
    } finally {
      markExportStageEnd("save");
    }
  }

  async function exportOutput(): Promise<void> {
    if (!studio || !exportRenderPath || busy) return;

    setExportFeedback(null);
    exportLockNoticeShownRef.current = false;
    exportCancelRequestedRef.current = false;
    setExportCancelPending(false);
    setExportPanelOpen(false);
    setExportStageLabel("Preparing");
    stopExportTimer(true);
    const selectedPath = await window.desktopAPI.chooseExportPath(`studio-export-${Date.now()}`, exportFormat);
    if (!selectedPath) {
      setExportPercent(null);
      setExportRendering(false);
      setExportStatus("Export canceled.");
      setExportStageLabel("Idle");
      stopExportTimer(true);
      return;
    }

    console.log(
      `[export:ui] export requested format=${exportFormat.toUpperCase()} output=${selectedPath} outputPreset=${outputSize} fps=${exportFps} sourceSession=${
        studio.session.sessionId
      } cached=${
        canReuseRenderedExport ? "yes" : "no"
      }`
    );
    logWorkflowDiagnostic(
      "export-start:requested",
      `format=${exportFormat.toUpperCase()} fps=${exportFps} size=${resolvedOutput.width}x${resolvedOutput.height} durationSec=${studio.durationSec.toFixed(2)}`
    );
    logExportDiagnostic(
      "export-requested",
      `durationSec=${studio.durationSec.toFixed(2)} format=${exportFormat.toUpperCase()} fps=${exportFps} size=${resolvedOutput.width}x${resolvedOutput.height} cached=${
        canReuseRenderedExport ? "yes" : "no"
      }`
    );
    const backgroundEnabled = settings.backgroundType !== "none";
    const webcamPipelineEnabled = settings.webcamMode !== "none";
    const enhanceEnabled = webcamPipelineEnabled && settings.webcamBeautifyEnabled;
    const directEncodeCandidate = exportFormat === "mp4" && studio.isComposited && !canReuseRenderedExport;
    logExportDiagnostic(
      "export-pipeline",
      `mode=${
        canReuseRenderedExport ? "reuse-rendered-output" : directEncodeCandidate ? "direct-encode" : "render-then-encode"
      } sourceComposited=${studio.isComposited ? "yes" : "no"}`
    );
    exportUsesRenderStageRef.current = !canReuseRenderedExport && !directEncodeCandidate;
    const configuredExportFps = exportFormat === "mp4" ? Math.max(exportFps, 30) : Math.max(exportFps, 15);
    startExportTimingTrace({
      format: exportFormat,
      sourceDurationSec: studio.durationSec,
      width: resolvedOutput.width,
      height: resolvedOutput.height,
      fps: configuredExportFps,
      sourceComposited: studio.isComposited,
      backgroundEnabled,
      webcamEnabled: webcamPipelineEnabled,
      enhanceEnabled
    });
    const exportNotices: string[] = [];
    if (!canReuseRenderedExport) {
      exportNotices.push(
        "Export can continue in the background. On some Windows systems, locking the device can pause rendering until you unlock."
      );
    }
    if (studio.durationSec >= 25 * 60 && exportFps >= 60) {
      exportNotices.push("Long 60 FPS exports may take longer and use more system resources.");
    }
    if (exportNotices.length > 0) {
      setExportFeedback({
        tone: "info",
        title: "Export notice",
        message: exportNotices.join(" ")
      });
    }
    setBusy(true);
    startExportTimer();
    setExportPercent(2);
    setExportStatus("Exporting video...");
    markExportHeartbeat();
    try {
      const withIdleTimeout = async <T,>(promise: Promise<T>, stage: string): Promise<T> => {
        let watchId: number | null = null;
        let wasConstrained = false;
        const timeoutPromise = new Promise<T>((_, reject) => {
          watchId = window.setInterval(() => {
            if (isExportConstrainedBySessionState()) {
              wasConstrained = true;
              notifyExportLockConstraint(stage);
              markExportHeartbeat();
              return;
            }
            if (wasConstrained) {
              wasConstrained = false;
              logWorkflowDiagnostic("export-session-resumed", `stage=${stage}`);
              markExportHeartbeat();
            }
            if (Date.now() - exportHeartbeatRef.current > EXPORT_IDLE_TIMEOUT_MS) {
              reject(new Error(`Export stalled during ${stage}. No progress for ${EXPORT_IDLE_TIMEOUT_MS / 1000} seconds.`));
            }
          }, 500);
        });
        try {
          return await Promise.race([promise, timeoutPromise]);
        } finally {
          if (watchId !== null) {
            window.clearInterval(watchId);
          }
        }
      };

      if (!canReuseRenderedExport) {
        await withIdleTimeout(renderFinalExport(exportRenderPath, exportFormat), "render/encode");
      }
      await withIdleTimeout(saveRenderedExport(exportRenderPath, selectedPath, exportFormat), "save");
      setExportPercent(100);
      setExportStatus("Export complete.");
      setExportStageLabel("Completed");
      const timingSummary = finishExportTimingTrace("success", selectedPath);
      setExportFeedback({
        tone: "success",
        title: "Export complete",
        message: "Your video has been successfully exported and downloaded.",
        detail: timingSummary ?? undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export failed";
      console.error(`[export:ui] export failed: ${message}`);
      setExportPercent(null);
      setExportRendering(false);
      if (isExportCanceledMessage(message)) {
        finishExportTimingTrace("canceled", message);
        setExportStatus("Export canceled.");
        setExportStageLabel("Canceled");
        setExportFeedback({
          tone: "info",
          title: "Export canceled",
          message: "The export was canceled before completion."
        });
      } else {
        finishExportTimingTrace("failed", message);
        setExportStatus(`Export failed: ${message}`);
        setExportStageLabel("Failed");
        const lockHint = exportLockNoticeShownRef.current
          ? "Locking or suspending the device may pause export rendering. Keep the app active and the device awake during export."
          : undefined;
        setExportFeedback({
          tone: "error",
          title: "Export failed",
          message: "Something went wrong while exporting your video. Please try again.",
          detail: lockHint ? `${message} ${lockHint}` : message
        });
      }
    } finally {
      setBusy(false);
      setExportCancelPending(false);
      exportCancelRequestedRef.current = false;
      exportLockNoticeShownRef.current = false;
      stopExportTimer();
      setExportStageLabel("Idle");
    }
  }

  async function cancelExportInProgress(): Promise<void> {
    if (!exportInProgress || exportCancelPending) {
      return;
    }

    exportCancelRequestedRef.current = true;
    setExportCancelPending(true);
    setExportStatus("Canceling export...");
    setExportStageLabel("Canceling");
    markExportHeartbeat();
    try {
      await window.desktopAPI.cancelExport();
    } catch (error) {
      console.warn(`[export:ui] failed to send cancel request: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  function clearCurrentStudioVideo(): void {
    if (studio) {
      URL.revokeObjectURL(studio.screenUrl);
      if (studio.webcamUrl) URL.revokeObjectURL(studio.webcamUrl);
      if (studio.audioUrl) URL.revokeObjectURL(studio.audioUrl);
    }

    screenVideoRef.current?.pause();
    webcamVideoRef.current?.pause();
    audioRef.current?.pause();
    if (screenVideoRef.current) screenVideoRef.current.currentTime = 0;
    if (webcamVideoRef.current) webcamVideoRef.current.currentTime = 0;
    if (audioRef.current) audioRef.current.currentTime = 0;

    setStudio(null);
    setStudioMediaReady(false);
    setPlayback(0);
    setPlaying(false);
    setElapsed(0);
    setRenderedExport(null);
    setExportStatus("");
    setExportStageLabel("Idle");
    setExportPercent(null);
    setExportRendering(false);
    setExportFeedback(null);
    setExportCancelPending(false);
    exportCancelRequestedRef.current = false;
    setExportPanelOpen(false);
    stopExportTimer(true);
    setError(null);
  }

  function requestRecordNewVideo(): void {
    if (!studio || recording || startingRecording || busy) return;
    if (!hasUndownloadedStudio) {
      clearCurrentStudioVideo();
      return;
    }
    setPendingDiscardAction("record-new");
    setRecordNewConfirmOpen(true);
  }

  function requestStartRecording(): void {
    if (recording) {
      void stop(false);
      return;
    }
    if (busy || startingRecording) return;
    if (hasUndownloadedStudio) {
      setPendingDiscardAction("start-recording");
      setRecordNewConfirmOpen(true);
      return;
    }
    if (studio) {
      clearCurrentStudioVideo();
    }
    void start();
  }

  function cancelDiscardConfirmation(): void {
    setPendingDiscardAction(null);
    setRecordNewConfirmOpen(false);
  }

  function continueDiscardConfirmation(): void {
    const action = pendingDiscardAction;
    setPendingDiscardAction(null);
    setRecordNewConfirmOpen(false);
    if (!action) return;
    if (action === "record-new") {
      clearCurrentStudioVideo();
      return;
    }
    clearCurrentStudioVideo();
    void start();
  }

  function cancelExitConfirmation(): void {
    setExitConfirmOpen(false);
    setExitConfirmEvent(null);
    window.desktopAPI.respondExitConfirmation(false);
  }

  function confirmExitApplication(): void {
    setExitConfirmOpen(false);
    setExitConfirmEvent(null);
    window.desktopAPI.respondExitConfirmation(true);
  }

  return (
    <main className="relative h-screen overflow-hidden p-6 text-slate-100" style={appShellStyle}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveStatusMessage}
      </div>
      <div ref={appContentRef} aria-hidden={hasOpenModal} className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-semibold">Screen Recorder Studio</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={requestRecordNewVideo}
              disabled={!studio || recording || startingRecording || busy}
              className="inline-flex min-h-[44px] items-center rounded-md border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-pink-400 disabled:opacity-60"
            >
              Record New Video
            </button>
            <div ref={exportPanelRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setExportPanelOpen((open) => !open)}
                aria-haspopup="dialog"
                aria-expanded={exportPanelOpen}
                aria-controls={exportPopoverId}
                className="inline-flex min-h-[44px] items-center rounded-md border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-pink-400"
              >
                Export
              </button>
              {exportPanelOpen ? (
                <section id={exportPopoverId} className="app-overlay-surface absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl shadow-black/40">
                  <div className="space-y-2">
                    <Dropdown label="Export Format" value={exportFormat} options={exportFormatOptions} onChange={setExportFormat} />
                    <Dropdown label="Output Size" value={outputSize} options={outputSizeOptions} onChange={setOutputSize} />
                    <Dropdown
                      label="Frame Rate"
                      value={String(exportFps)}
                      options={exportFpsOptions}
                      onChange={(next) => setExportFps(Number(next))}
                    />
                    <div className="text-xs text-slate-400">
                      Actual output: {resolvedOutput.width} x {resolvedOutput.height}
                    </div>
                    <button
                      onClick={() => void exportOutput()}
                      disabled={!studio || busy}
                      className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-pink-400 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                    >
                      Download
                    </button>
                    {exportInProgress ? (
                      <div className="rounded-md border border-slate-600 bg-pink-500/15 p-3 text-xs text-slate-200" role="status" aria-live="polite">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold text-slate-100">Exporting video...</span>
                          <span className="text-sm font-semibold text-slate-100">{Math.round(exportProgressPercent)}%</span>
                        </div>
                        <div className="mt-2 inline-flex items-center gap-2 text-xs text-slate-200">
                          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-600 border-t-pink-400" aria-hidden="true" />
                          <span>Rendering and encoding in progress...</span>
                        </div>
                        <div className="mt-2 space-y-1 text-[11px] text-slate-400">
                          <div>Stage: {exportStageLabel}</div>
                          <div className="flex items-center justify-between gap-3">
                            <span>Estimated time remaining: {exportRemainingLabel}</span>
                            <span>{secs(exportElapsedSec)} elapsed</span>
                          </div>
                          <div>Estimated output size: {formatEstimatedSize(estimatedExportSizeBytes)}</div>
                          {exportStatus ? <div>{exportStatus}</div> : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => void cancelExportInProgress()}
                          disabled={exportCancelPending}
                          className="mt-3 inline-flex min-h-[36px] w-full items-center justify-center rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {exportCancelPending ? "Canceling..." : "Cancel Export"}
                        </button>
                      </div>
                    ) : (
                      <div className="min-h-4 text-xs text-slate-400" role="status" aria-live="polite">
                        {exportStatus}
                      </div>
                    )}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </div>
        {exportFeedback ? (
          <div
            className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-3 text-sm shadow-2xl ${
              exportFeedback.tone === "success"
                ? "border-slate-600 bg-pink-500/15"
                : exportFeedback.tone === "error"
                  ? "border-rose-400/60 bg-rose-500/10"
                  : "border-slate-600 bg-slate-900"
            }`}
            role={exportFeedback.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <div className="min-w-0 pr-2">
              <div className="text-sm font-semibold text-slate-100">
                {exportFeedback.title}
              </div>
              <div className="mt-1 text-xs text-slate-200">
                {exportFeedback.message}
              </div>
              {exportFeedback.detail ? (
                <div className="mt-2 text-[11px] text-slate-400">
                  {exportFeedback.detail}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setExportFeedback(null)}
              className="inline-flex min-h-[36px] shrink-0 items-center justify-center rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:border-pink-400"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="min-h-0 rounded-xl border border-slate-700 bg-slate-900 p-3">
            <div className="flex h-full gap-3">
              <nav aria-label="Settings sections" className="flex w-12 shrink-0 flex-col gap-2">
                <button
                  type="button"
                  aria-label="Recording settings"
                  title="Recording"
                  aria-pressed={activeSettingsPanel === "recording"}
                  onClick={() => setActiveSettingsPanel("recording")}
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    activeSettingsPanel === "recording"
                      ? "border-pink-400 bg-pink-500/15 text-pink-200"
                      : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  <RecordingIcon />
                </button>
                <button
                  type="button"
                  aria-label="Webcam settings"
                  title="Webcam"
                  aria-pressed={activeSettingsPanel === "webcam"}
                  onClick={() => setActiveSettingsPanel("webcam")}
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    activeSettingsPanel === "webcam"
                      ? "border-pink-400 bg-pink-500/15 text-pink-200"
                      : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  <WebcamIcon />
                </button>
                <button
                  type="button"
                  aria-label="Sound settings"
                  title="Sound"
                  aria-pressed={activeSettingsPanel === "sound"}
                  onClick={() => setActiveSettingsPanel("sound")}
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    activeSettingsPanel === "sound"
                      ? "border-pink-400 bg-pink-500/15 text-pink-200"
                      : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  <SoundIcon />
                </button>
                <button
                  type="button"
                  aria-label="Background settings"
                  title="Background"
                  aria-pressed={activeSettingsPanel === "background"}
                  onClick={() => setActiveSettingsPanel("background")}
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    activeSettingsPanel === "background"
                      ? "border-pink-400 bg-pink-500/15 text-pink-200"
                      : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  <BackgroundIcon />
                </button>
                <button
                  type="button"
                  ref={settingsTriggerRef}
                  aria-label="App settings"
                  title="Settings"
                  aria-haspopup="dialog"
                  aria-expanded={settingsModalOpen}
                  aria-controls={settingsDialogId}
                  onClick={() => {
                    setExportPanelOpen(false);
                    void loadAppBackgrounds();
                    setSettingsModalOpen(true);
                  }}
                  className={`mt-auto inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    settingsModalOpen
                      ? "border-pink-400 bg-pink-500/15 text-pink-200"
                      : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  <SettingsIcon />
                </button>
              </nav>

              <div
                className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-700 p-3"
                style={{
                  backgroundColor: darkMode ? "rgba(14, 24, 40, 0.58)" : "rgba(243, 248, 255, 0.6)"
                }}
              >
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-300">
                    {activeSettingsPanel === "recording"
                      ? "Recording"
                      : activeSettingsPanel === "webcam"
                        ? "Webcam"
                        : activeSettingsPanel === "sound"
                          ? "Sound"
                          : "Background"}
                  </div>

                  <div className="space-y-3">
                    {activeSettingsPanel === "recording" ? (
                      <>
                        <div>
                          <div className="mb-1 text-sm text-slate-200">Capture Type</div>
                          <div className="grid grid-cols-1 gap-2">
                            {captureOptions.map((option) => {
                              const active = captureMode === option.value;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => setCaptureMode(option.value)}
                                  className={`min-h-[44px] rounded-lg border px-2 py-2 text-sm font-medium transition-colors ${
                                    active ? "border-pink-400 bg-pink-500/15 text-pink-200" : "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500"
                                  }`}
                                  aria-pressed={active}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <Dropdown
                          label="Screen Source"
                          value={selectedSourceValue}
                          options={sourceOptions}
                          wrapOptions
                          disabled={!sources.length}
                          onOpen={() => {
                            void refreshSources(captureMode);
                          }}
                          onChange={(next) => setSelectedSource(next)}
                        />
                        <Dropdown
                          label="Recording Size"
                          value={recordingSizeValue}
                          options={recordingSizeOptions}
                          onChange={(next) => {
                            const preset = recordingSizePresetConfig(next);
                            setAspectRatio(preset.aspectRatio);
                            setOutputSize(preset.outputSize);
                          }}
                        />
                      </>
                    ) : null}

                    {activeSettingsPanel === "webcam" ? (
                      <>
                        <Dropdown label="Mode" value={webcamMode} options={webcamModeOptions} onChange={(next) => setSettings((s) => ({ ...s, webcamMode: next }))} />
                        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                          <ToggleSwitch
                            label="Enhance"
                            checked={settings.webcamBeautifyEnabled}
                            disabled={webcamMode === "none"}
                            onChange={(next) => setSettings((s) => ({ ...s, webcamBeautifyEnabled: next }))}
                          />
                          <label
                            className={`mt-3 block text-sm text-slate-200 ${
                              webcamMode !== "none" && settings.webcamBeautifyEnabled ? "" : "opacity-60"
                            }`}
                          >
                            <span className="flex items-center justify-between">
                              <span>Face Smooth Radius</span>
                              <span className="text-xs text-slate-400">{settings.webcamBeautifySmoothRadius.toFixed(1)} px</span>
                            </span>
                            <input
                              className="mt-2 w-full accent-pink-500"
                              type="range"
                              min={MIN_WEBCAM_BEAUTIFY_SMOOTH_RADIUS}
                              max={MAX_WEBCAM_BEAUTIFY_SMOOTH_RADIUS}
                              step={0.1}
                              disabled={webcamMode === "none" || !settings.webcamBeautifyEnabled}
                              value={settings.webcamBeautifySmoothRadius}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  webcamBeautifySmoothRadius: clamp(
                                    Number(e.target.value),
                                    MIN_WEBCAM_BEAUTIFY_SMOOTH_RADIUS,
                                    MAX_WEBCAM_BEAUTIFY_SMOOTH_RADIUS
                                  )
                                }))
                              }
                            />
                          </label>
                          <label
                            className={`mt-3 block text-sm text-slate-200 ${
                              webcamMode !== "none" && settings.webcamBeautifyEnabled ? "" : "opacity-60"
                            }`}
                          >
                            <span className="flex items-center justify-between">
                              <span>Brightness / Exposure</span>
                              <span className="text-xs text-slate-400">
                                {settings.webcamBeautifyExposure > 0
                                  ? `+${Math.round(settings.webcamBeautifyExposure)}%`
                                  : `${Math.round(settings.webcamBeautifyExposure)}%`}
                              </span>
                            </span>
                            <input
                              className="mt-2 w-full accent-pink-500"
                              type="range"
                              min={MIN_WEBCAM_BEAUTIFY_EXPOSURE}
                              max={MAX_WEBCAM_BEAUTIFY_EXPOSURE}
                              step={1}
                              disabled={webcamMode === "none" || !settings.webcamBeautifyEnabled}
                              value={settings.webcamBeautifyExposure}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  webcamBeautifyExposure: clamp(
                                    Number(e.target.value),
                                    MIN_WEBCAM_BEAUTIFY_EXPOSURE,
                                    MAX_WEBCAM_BEAUTIFY_EXPOSURE
                                  )
                                }))
                              }
                            />
                          </label>
                        </div>
                        <Dropdown
                          label="Position"
                          value={settings.webcamPosition}
                          options={webcamPositionOptions}
                          disabled={webcamMode !== "small-overlay"}
                          onChange={(next) => setSettings((s) => ({ ...s, webcamPosition: next as WebcamPosition }))}
                        />
                        <label className={`block text-sm text-slate-200 ${webcamMode === "small-overlay" ? "" : "opacity-60"}`}>
                          <span className="flex items-center justify-between">
                            <span>Size</span>
                            <span className="text-xs text-slate-400">{webcamSizeRadius}</span>
                          </span>
                          <input
                            className="mt-2 w-full accent-pink-500"
                            type="range"
                            min={MIN_WEBCAM_SIZE_RADIUS}
                            max={MAX_WEBCAM_SIZE_RADIUS}
                            step={1}
                            disabled={webcamMode !== "small-overlay"}
                            value={webcamSizeRadius}
                            onChange={(e) => {
                              const radius = Number(e.target.value);
                              const minScale = (sceneDefaults.webcamScale * MIN_WEBCAM_SIZE_RADIUS) / 100;
                              const maxScale = (sceneDefaults.webcamScale * MAX_WEBCAM_SIZE_RADIUS) / 100;
                              const nextScale = clamp((sceneDefaults.webcamScale * radius) / 100, minScale, maxScale);
                              setSettings((s) => ({ ...s, webcamScale: nextScale }));
                            }}
                          />
                        </label>
                        <label className={`block text-sm text-slate-200 ${webcamMode === "small-overlay" ? "" : "opacity-60"}`}>
                          <span className="flex items-center justify-between">
                            <span>Shape</span>
                            <span className="text-xs text-slate-400">
                              {settings.webcamRadius >= MAX_WEBCAM_RADIUS
                                ? "Max"
                                : `${Math.round((settings.webcamRadius / MAX_WEBCAM_RADIUS) * 100)}%`}
                            </span>
                          </span>
                          <input
                            className="mt-2 w-full accent-pink-500"
                            type="range"
                            min={0}
                            max={MAX_WEBCAM_RADIUS}
                            step={1}
                            disabled={webcamMode !== "small-overlay"}
                            value={settings.webcamRadius}
                            onChange={(e) => setSettings((s) => ({ ...s, webcamRadius: Number(e.target.value) }))}
                          />
                        </label>
                      </>
                    ) : null}

                    {activeSettingsPanel === "sound" ? (
                      <>
                        <ToggleSwitch label="System Audio" checked={sysAudio} onChange={setSysAudio} />
                        <ToggleSwitch label="Microphone" checked={mic} onChange={setMic} />
                      </>
                    ) : null}

                    {activeSettingsPanel === "background" ? (
                      <>
                        <Dropdown
                          label="Background"
                          value={settings.backgroundType}
                          options={backgroundOptions}
                          onChange={(next) => setSettings((s) => ({ ...s, backgroundType: next }))}
                        />
                        {settings.backgroundType === "custom-image" ? (
                          <div>
                            <input
                              ref={backgroundInputRef}
                              type="file"
                              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                              className="hidden"
                              onChange={handleBackgroundFileSelected}
                            />
                            <button
                              type="button"
                              onClick={openBackgroundFilePicker}
                              className="min-h-[44px] w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 hover:border-pink-400"
                            >
                              Choose Custom Image
                            </button>
                          </div>
                        ) : null}
                        {settings.backgroundType === "wallpaper" ? (
                          <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Wallpapers</div>
                            {wallpapersLoading ? <div className="text-xs text-slate-400">Loading wallpapers...</div> : null}
                            {!wallpapersLoading && wallpapersLoadError ? <div className="text-xs text-red-300">{wallpapersLoadError}</div> : null}
                            {!wallpapersLoading && !wallpapersLoadError && wallpapers.length === 0 ? (
                              <div className="text-xs text-slate-400">No wallpapers found.</div>
                            ) : null}
                            {!wallpapersLoading && wallpapers.length > 0 ? (
                              <div className="grid grid-cols-2 gap-2">
                                {wallpapers.map((wallpaper) => {
                                  const selected = settings.wallpaperUrl === wallpaper.fileUrl;
                                  return (
                                    <button
                                      key={wallpaper.path}
                                      type="button"
                                      title={wallpaper.name}
                                      onClick={() => setSettings((s) => ({ ...s, backgroundType: "wallpaper", wallpaperUrl: wallpaper.fileUrl }))}
                                      className={`group overflow-hidden rounded-md border transition-colors ${
                                        selected ? "border-pink-400" : "border-slate-700 hover:border-slate-500"
                                      }`}
                                    >
                                      <img
                                        src={wallpaper.fileUrl}
                                        alt={wallpaper.name}
                                        loading="lazy"
                                        decoding="async"
                                        className="h-16 w-full bg-slate-950 object-cover"
                                      />
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <label className={`block text-sm text-slate-200 ${canBlurBackground ? "" : "opacity-60"}`}>
                          <span className="flex items-center justify-between">
                            <span>Blur Effect</span>
                            <span className="text-xs text-slate-400">{Math.round(settings.backgroundBlurRadius)} px</span>
                          </span>
                          <input
                            className="mt-2 w-full accent-pink-500"
                            type="range"
                            min={0}
                            max={MAX_BACKGROUND_BLUR}
                            step={1}
                            disabled={!canBlurBackground}
                            value={settings.backgroundBlurRadius}
                            onChange={(e) => setSettings((s) => ({ ...s, backgroundBlurRadius: Number(e.target.value) }))}
                          />
                        </label>
                        <label className="block text-sm text-slate-200">
                          <span className="flex items-center justify-between">
                            <span>Padding</span>
                            <span className="text-xs text-slate-400">{Math.round(settings.windowRadius)} px</span>
                          </span>
                          <input
                            className="mt-2 w-full accent-pink-500"
                            type="range"
                            min={0}
                            max={140}
                            step={1}
                            value={settings.windowRadius}
                            onChange={(e) => setSettings((s) => ({ ...s, windowRadius: Number(e.target.value) }))}
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                </div>

                <div className="pt-3">
                  <div className="rounded-xl border border-slate-700 bg-slate-900 p-2.5">
                    <div className="mb-2 text-sm font-semibold text-slate-200">Record</div>
                    <button
                      onClick={requestStartRecording}
                      disabled={busy || startingRecording}
                      className={`min-h-[44px] w-full rounded-lg px-3 py-2.5 font-semibold text-slate-950 ${recording ? "bg-rose-400" : "bg-pink-400"} disabled:opacity-60`}
                    >
                      {recording ? "Stop Recording" : startingRecording ? "Preparing..." : "Start Recording"}
                    </button>
                    <div className="mt-2 text-xs text-slate-300">{secs(elapsed)} elapsed</div>
                  </div>
                  {error ? (
                    <div className="mt-2 text-sm text-red-300" role="alert" aria-live="assertive">
                      {error}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2">
                <span className="text-sm text-slate-200">Preview</span>
                <InlineToggle ariaLabel="Toggle preview" checked={showPreview} onChange={setShowPreview} disabled={exportRendering} />
              </div>
              {recording || startingRecording ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-rose-400/60 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200">
                  <span className="h-2 w-2 rounded-full bg-rose-400" />
                  {recording ? `REC ${secs(elapsed)}` : "Preparing"}
                </div>
              ) : null}
            </div>
            {selectedSourceLabel ? (
              <div className="mb-3 text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Source:</span>{" "}
                <span className="whitespace-normal break-words">{selectedSourceLabel}</span>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div
                ref={previewViewportRef}
                className={`flex min-h-[260px] flex-1 items-center justify-center rounded-lg border border-slate-700 p-3 ${
                  showPreviewFrame ? "bg-slate-950" : ""
                }`}
                style={
                  showPreviewFrame
                    ? undefined
                    : {
                        backgroundColor: darkMode ? "rgba(14, 24, 40, 0.58)" : "rgba(243, 248, 255, 0.6)"
                      }
                }
              >
                {showPreviewFrame && previewFrameSize.w > 0 && previewFrameSize.h > 0 ? (
                  <div
                    className="relative shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-950"
                    style={{ width: `${previewFrameSize.w}px`, height: `${previewFrameSize.h}px` }}
                  >
                    <canvas
                      ref={canvasRef}
                      className={`absolute inset-0 h-full w-full bg-slate-950 transition-opacity ${exportRendering ? "opacity-0" : "opacity-100"}`}
                    />
                    {exportRendering ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-sm text-slate-300">
                        <div className="w-full max-w-sm rounded-xl border border-slate-600 bg-pink-500/15 p-4 text-center">
                          <div className="text-sm font-semibold text-slate-100">Exporting video...</div>
                          <div className="mt-2 inline-flex items-center gap-2 text-xs text-slate-200">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-pink-400" aria-hidden="true" />
                            <span>Rendering and encoding in progress...</span>
                          </div>
                          <div className="mt-2 space-y-1 text-[11px] text-slate-400">
                            <div>Stage: {exportStageLabel}</div>
                            <div>Estimated time remaining: {exportRemainingLabel}</div>
                            <div>{secs(exportElapsedSec)} elapsed</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void cancelExportInProgress()}
                            disabled={exportCancelPending}
                            className="mt-3 inline-flex min-h-[36px] items-center justify-center rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {exportCancelPending ? "Canceling..." : "Cancel Export"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : showPreviewFrame ? (
                  <div className="text-xs text-slate-400">Preparing frame...</div>
                ) : (
                  <div className="text-center">
                    <div className="text-sm font-semibold text-slate-200">Preview is off</div>
                    <div className="mt-1 text-xs text-slate-400">Enable Preview to inspect layout before recording.</div>
                  </div>
                )}
              </div>

              {studio ? (
                <div className="space-y-3">
                  <input
                    type="range"
                    aria-label="Playback position"
                    min={0}
                    max={studio.durationSec}
                    step={0.01}
                    value={playback}
                    onChange={(e) => {
                      const time = Number(e.target.value);
                      syncPlaybackTime(time);
                    }}
                    className="w-full accent-pink-500"
                  />

                  <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
                    <span className="text-sm text-slate-300">{secs(playback)}</span>
                    <button
                      onClick={() => void togglePlay()}
                      disabled={!studio || busy || exportRendering}
                      className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-full bg-slate-800 disabled:opacity-60"
                    >
                      {playing ? <PauseIcon /> : <PlayIcon />}
                      <span className="sr-only">{playing ? "Pause" : "Play"}</span>
                    </button>
                    <span className="text-right text-sm text-slate-300">-{secs(playbackRemaining)}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-400">
                  {recording
                    ? "Recording in progress."
                    : startingRecording
                      ? "Preparing recording pipeline..."
                      : !showPreview
                        ? "Preview is currently disabled."
                        : !selectedSource
                          ? "Select a capture source to preview."
                          : previewReady
                            ? "Live preview is ready. Adjust settings before recording."
                            : "Preparing live preview..."}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {recordNewConfirmOpen ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4" role="presentation">
          <div
            ref={discardDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={discardDialogTitleId}
            aria-describedby={discardDialogDescriptionId}
            tabIndex={-1}
            className="app-overlay-surface w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50"
          >
            <div id={discardDialogTitleId} className="text-sm font-semibold text-slate-100">
              Discard current recording?
            </div>
            <div id={discardDialogDescriptionId} className="mt-2 text-sm text-slate-100">
              Are you sure? The current video will be lost if it is not downloaded.
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={discardCancelButtonRef}
                type="button"
                onClick={cancelDiscardConfirmation}
                className="min-h-[44px] rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-semibold text-slate-200 hover:border-slate-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={continueDiscardConfirmation}
                className="min-h-[44px] rounded-md bg-pink-400 px-3 py-2 text-sm font-semibold text-slate-950"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exitConfirmOpen ? (
        <div className="absolute inset-0 z-[80] flex items-center justify-center bg-slate-950/75 p-4" role="presentation">
          <div
            ref={exitDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={exitDialogTitleId}
            aria-describedby={exitDialogDescriptionId}
            tabIndex={-1}
            className="app-overlay-surface w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50"
          >
            <div id={exitDialogTitleId} className="text-center text-sm font-semibold text-slate-100">
              {exitConfirmEvent?.title ?? "Exit application?"}
            </div>
            <div id={exitDialogDescriptionId} className="mt-4 text-center text-sm text-slate-100">
              <div className="text-slate-300">{exitConfirmEvent?.detail ?? "Are you sure you want to close the app?"}</div>
            </div>
            <div className="mt-5 flex items-center justify-center gap-5">
              <button
                ref={exitCancelButtonRef}
                type="button"
                onClick={cancelExitConfirmation}
                className="min-h-[44px] min-w-[120px] rounded-md border border-slate-600 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-slate-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmExitApplication}
                className="min-h-[44px] min-w-[120px] rounded-md bg-pink-400 px-4 py-2 text-sm font-semibold text-slate-950"
              >
                Yes / Exit
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsModalOpen ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4" role="presentation" onClick={() => setSettingsModalOpen(false)}>
          <div
            id={settingsDialogId}
            ref={settingsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={settingsDialogTitleId}
            tabIndex={-1}
            className="app-overlay-surface w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div id={settingsDialogTitleId} className="text-sm font-semibold text-slate-100">
                Settings
              </div>
              <button
                ref={settingsCloseButtonRef}
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="min-h-[44px] rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-500"
              >
                Close
              </button>
            </div>
            <div className="space-y-4">
              <ToggleSwitch label="Dark Mode" checked={darkMode} onChange={setDarkMode} />
              <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Choose App Background</div>
                {appBackgroundsLoading ? <div className="text-xs text-slate-400">Loading backgrounds...</div> : null}
                {!appBackgroundsLoading && appBackgroundsLoadError ? <div className="text-xs text-red-300">{appBackgroundsLoadError}</div> : null}
                {!appBackgroundsLoading && !appBackgroundsLoadError && appBackgrounds.length === 0 ? (
                  <div className="text-xs text-slate-400">No app backgrounds found.</div>
                ) : null}
                {!appBackgroundsLoading && appBackgrounds.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {appBackgrounds.map((asset) => {
                      const selected = selectedAppBackgroundAsset?.fileUrl === asset.fileUrl;
                      return (
                        <button
                          key={asset.path}
                          type="button"
                          title={asset.name}
                          onClick={() => setSelectedAppBackgroundUrl(asset.fileUrl)}
                          className={`group overflow-hidden rounded-md border transition-colors ${
                            selected ? "border-pink-400" : "border-slate-700 hover:border-slate-500"
                          }`}
                        >
                          <img
                            src={asset.fileUrl}
                            alt={asset.name}
                            loading="lazy"
                            decoding="async"
                            className="h-20 w-full bg-slate-950 object-cover"
                          />
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="hidden">
        <video ref={screenVideoRef} src={studio?.screenUrl ?? undefined} preload="auto" muted playsInline />
        <video ref={webcamVideoRef} src={studio?.webcamUrl ?? undefined} preload="auto" muted playsInline />
        <audio ref={audioRef} src={studio?.audioUrl ?? undefined} preload="auto" />
      </div>
    </main>
  );
}

