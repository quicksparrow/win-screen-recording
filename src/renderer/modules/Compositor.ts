import type { BackgroundType, StudioSceneSettings, WebcamMode, WebcamPosition } from "../../shared/types";
export type Rect = { x: number; y: number; w: number; h: number };
export type CropRect = { sx: number; sy: number; sw: number; sh: number };

export interface CompositorLayout {
  sourceCrop: CropRect;
  windowRect: Rect;
}

export interface CompositorRenderInput {
  ctx: CanvasRenderingContext2D;
  frameWidth: number;
  frameHeight: number;
  screenVideo: HTMLVideoElement;
  sourceWidth: number;
  sourceHeight: number;
  settings: StudioSceneSettings;
  backgroundImage: HTMLImageElement | null;
  webcamEnabled: boolean;
  webcamVideo: HTMLVideoElement | null;
  webcamMode: WebcamMode;
  webcamTransitionFromMode?: WebcamMode | null;
  webcamTransitionProgress?: number;
  maxWebcamRadiusSetting: number;
  layout: CompositorLayout;
  passthroughSource?: boolean;
  onProfile?: (profile: CompositorFrameProfile) => void;
}

export interface CompositorFrameProfile {
  backgroundEnabled: boolean;
  backgroundCacheHit: boolean;
  backgroundMs: number;
  windowMs: number;
  webcamEnabled: boolean;
  webcamMs: number;
  beautifyEnabled: boolean;
  beautifyMs: number;
}

const WEBCAM_SAFE_MARGIN_AT_1080 = 24;
const WINDOW_MARGIN_RATIO = 0.08;
const MIN_WINDOW_MARGIN = 12;
const MAX_BACKGROUND_BLUR = 50;
const MAX_WEBCAM_BEAUTIFY_SMOOTH_RADIUS = 8;
const MAX_WEBCAM_BEAUTIFY_EXPOSURE = 40;
type StaticBackgroundCache = {
  key: string;
  sourceImage: HTMLImageElement | null;
  canvas: HTMLCanvasElement;
};
const staticBackgroundCacheByContext = new WeakMap<CanvasRenderingContext2D, StaticBackgroundCache>();

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  sourceW: number,
  sourceH: number,
  alignX = 0.5,
  alignY = 0.5
): void {
  const safeSourceW = Math.max(1, sourceW);
  const safeSourceH = Math.max(1, sourceH);
  const sourceRatio = safeSourceW / safeSourceH;
  const targetRatio = Math.max(0.0001, dw / dh);
  const sxAlign = clamp(alignX, 0, 1);
  const syAlign = clamp(alignY, 0, 1);

  if (sourceRatio > targetRatio) {
    const cropW = safeSourceH * targetRatio;
    const sx = (safeSourceW - cropW) * sxAlign;
    ctx.drawImage(image, sx, 0, cropW, safeSourceH, dx, dy, dw, dh);
    return;
  }

  const cropH = safeSourceW / targetRatio;
  const sy = (safeSourceH - cropH) * syAlign;
  ctx.drawImage(image, 0, sy, safeSourceW, cropH, dx, dy, dw, dh);
}

function drawRoundRectPath(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const r = clamp(radius, 0, Math.min(rect.w, rect.h) / 2);
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.w - r, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h);
  ctx.lineTo(rect.x + r, rect.y + rect.h);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
}

function drawCirclePath(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const effectiveSize = Math.min(rect.w, rect.h);
  const radius = Math.max(0, effectiveSize * 0.5);
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
}

function aspectCropRect(sourceW: number, sourceH: number, targetW: number, targetH: number, alignX = 0.5, alignY = 0.5): CropRect {
  const sw = Math.max(1, sourceW);
  const sh = Math.max(1, sourceH);
  const targetRatio = Math.max(0.0001, targetW / Math.max(1, targetH));
  const sourceRatio = sw / sh;
  const sxAlign = clamp(alignX, 0, 1);
  const syAlign = clamp(alignY, 0, 1);

  if (sourceRatio > targetRatio) {
    const cropW = Math.max(1, sh * targetRatio);
    return {
      sx: (sw - cropW) * sxAlign,
      sy: 0,
      sw: cropW,
      sh
    };
  }

  if (sourceRatio < targetRatio) {
    const cropH = Math.max(1, sw / targetRatio);
    return {
      sx: 0,
      sy: (sh - cropH) * syAlign,
      sw,
      sh: cropH
    };
  }

  return { sx: 0, sy: 0, sw, sh };
}

function coverCropFromTopLeft(sourceW: number, sourceH: number, targetW: number, targetH: number): CropRect {
  return aspectCropRect(sourceW, sourceH, targetW, targetH, 0, 0);
}

function anchoredCropForWindow(sourceW: number, sourceH: number, targetW: number, targetH: number): CropRect {
  const targetRatio = Math.max(0.0001, targetW / Math.max(1, targetH));
  const alignX = targetRatio <= 1 ? 0 : 0.5;
  return aspectCropRect(sourceW, sourceH, targetW, targetH, alignX, 0);
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t)
  };
}

function scaleRect(rect: Rect, scale: number): Rect {
  const clampedScale = Math.max(0.01, scale);
  const scaledW = rect.w * clampedScale;
  const scaledH = rect.h * clampedScale;
  return {
    x: rect.x + (rect.w - scaledW) / 2,
    y: rect.y + (rect.h - scaledH) / 2,
    w: scaledW,
    h: scaledH
  };
}

function webcamFrameRect(canvasW: number, canvasH: number, size: number, position: WebcamPosition, margin: number): Rect {
  const clampedSize = Math.max(8, Math.min(size, Math.min(canvasW, canvasH) - margin * 2));
  const left = margin;
  const right = canvasW - margin - clampedSize;
  const top = margin;
  const bottom = canvasH - margin - clampedSize;

  if (position === "top-left") return { x: left, y: top, w: clampedSize, h: clampedSize };
  if (position === "top-right") return { x: right, y: top, w: clampedSize, h: clampedSize };
  if (position === "bottom-left") return { x: left, y: bottom, w: clampedSize, h: clampedSize };
  return { x: right, y: bottom, w: clampedSize, h: clampedSize };
}

function drawBackgroundLayer(ctx: CanvasRenderingContext2D, frameWidth: number, frameHeight: number, settings: StudioSceneSettings, backgroundImage: HTMLImageElement | null): void {
  if (settings.backgroundType === "none") {
    return;
  }

  if (settings.backgroundType === "gradient") {
    const gradient = ctx.createLinearGradient(0, 0, frameWidth, frameHeight);
    gradient.addColorStop(0, settings.gradientFrom);
    gradient.addColorStop(1, settings.gradientTo);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, frameWidth, frameHeight);
    return;
  }

  if ((settings.backgroundType === "wallpaper" || settings.backgroundType === "custom-image") && backgroundImage && backgroundImage.width > 0 && backgroundImage.height > 0) {
    const blurRadius = clamp(settings.backgroundBlurRadius, 0, MAX_BACKGROUND_BLUR);
    const blurBleed = blurRadius > 0 ? Math.ceil(blurRadius * 2) : 0;
    ctx.save();
    if (blurRadius > 0) {
      ctx.filter = `blur(${blurRadius}px)`;
    }
    drawImageCover(
      ctx,
      backgroundImage,
      -blurBleed,
      -blurBleed,
      frameWidth + blurBleed * 2,
      frameHeight + blurBleed * 2,
      backgroundImage.width,
      backgroundImage.height
    );
    ctx.restore();
    return;
  }

  ctx.fillStyle = settings.solidColor;
  ctx.fillRect(0, 0, frameWidth, frameHeight);
}

function backgroundLayerCacheKey(frameWidth: number, frameHeight: number, settings: StudioSceneSettings): string {
  return [
    frameWidth,
    frameHeight,
    settings.backgroundType,
    settings.gradientFrom,
    settings.gradientTo,
    settings.solidColor,
    settings.backgroundBlurRadius.toFixed(3),
    settings.wallpaperUrl
  ].join("|");
}

function ensureStaticBackgroundLayer(
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  settings: StudioSceneSettings,
  backgroundImage: HTMLImageElement | null
): HTMLCanvasElement | null {
  if (settings.backgroundType === "none") {
    return null;
  }

  const key = backgroundLayerCacheKey(frameWidth, frameHeight, settings);
  const existing = staticBackgroundCacheByContext.get(ctx);
  if (
    existing &&
    existing.key === key &&
    existing.sourceImage === backgroundImage &&
    existing.canvas.width === frameWidth &&
    existing.canvas.height === frameHeight
  ) {
    return existing.canvas;
  }

  const layerCanvas = existing?.canvas ?? document.createElement("canvas");
  if (layerCanvas.width !== frameWidth) {
    layerCanvas.width = frameWidth;
  }
  if (layerCanvas.height !== frameHeight) {
    layerCanvas.height = frameHeight;
  }

  const layerCtx = layerCanvas.getContext("2d");
  if (!layerCtx) {
    return null;
  }
  layerCtx.clearRect(0, 0, frameWidth, frameHeight);
  drawBackgroundLayer(layerCtx, frameWidth, frameHeight, settings, backgroundImage);
  staticBackgroundCacheByContext.set(ctx, {
    key,
    sourceImage: backgroundImage,
    canvas: layerCanvas
  });
  return layerCanvas;
}

export function computeCompositorLayout(frameWidth: number, frameHeight: number, sourceWidth: number, sourceHeight: number, backgroundType: BackgroundType): CompositorLayout {
  if (backgroundType === "none") {
    return {
      // Keep a full-bleed frame without stretching by top-left anchored cover cropping.
      sourceCrop: coverCropFromTopLeft(sourceWidth, sourceHeight, frameWidth, frameHeight),
      windowRect: {
        x: 0,
        y: 0,
        w: Math.max(1, frameWidth),
        h: Math.max(1, frameHeight)
      }
    };
  }

  const margin = Math.max(MIN_WINDOW_MARGIN, Math.round(Math.min(frameWidth, frameHeight) * WINDOW_MARGIN_RATIO));
  const windowRect: Rect = {
    x: margin,
    y: margin,
    w: Math.max(1, frameWidth - margin * 2),
    h: Math.max(1, frameHeight - margin * 2)
  };
  const sourceCrop = anchoredCropForWindow(sourceWidth, sourceHeight, windowRect.w, windowRect.h);

  return { sourceCrop, windowRect };
}

export function renderCompositorFrame(input: CompositorRenderInput): void {
  const {
    ctx,
    frameWidth,
    frameHeight,
    screenVideo,
    sourceWidth,
    sourceHeight,
    settings,
    backgroundImage,
    webcamEnabled,
    webcamMode,
    webcamTransitionFromMode = null,
    webcamTransitionProgress = 1,
    webcamVideo,
    maxWebcamRadiusSetting,
    layout,
    passthroughSource = false,
    onProfile
  } = input;
  const profilingEnabled = typeof onProfile === "function";
  let backgroundEnabled = false;
  let backgroundCacheHit = false;
  let backgroundMs = 0;
  let windowMs = 0;
  let webcamRenderEnabled = false;
  let webcamMs = 0;
  let beautifyEnabled = false;
  let beautifyMs = 0;

  ctx.clearRect(0, 0, frameWidth, frameHeight);

  if (passthroughSource) {
    const crop = layout.sourceCrop;
    const windowRect = layout.windowRect;
    const windowStartedAt = profilingEnabled ? performance.now() : 0;
    ctx.drawImage(screenVideo, crop.sx, crop.sy, crop.sw, crop.sh, windowRect.x, windowRect.y, windowRect.w, windowRect.h);
    if (profilingEnabled) {
      windowMs = performance.now() - windowStartedAt;
      onProfile?.({
        backgroundEnabled,
        backgroundCacheHit,
        backgroundMs,
        windowMs,
        webcamEnabled: webcamRenderEnabled,
        webcamMs,
        beautifyEnabled,
        beautifyMs
      });
    }
    return;
  }
  backgroundEnabled = settings.backgroundType !== "none";
  const backgroundStartedAt = profilingEnabled ? performance.now() : 0;
  const cachedBackgroundLayer = ensureStaticBackgroundLayer(ctx, frameWidth, frameHeight, settings, backgroundImage);
  backgroundCacheHit = Boolean(cachedBackgroundLayer);
  if (cachedBackgroundLayer) {
    ctx.drawImage(cachedBackgroundLayer, 0, 0);
  } else {
    drawBackgroundLayer(ctx, frameWidth, frameHeight, settings, backgroundImage);
  }
  if (profilingEnabled) {
    backgroundMs = performance.now() - backgroundStartedAt;
  }

  const windowRect = layout.windowRect;
  const crop = layout.sourceCrop;
  const windowStartedAt = profilingEnabled ? performance.now() : 0;
  if (settings.backgroundType === "none") {
    ctx.drawImage(screenVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, frameWidth, frameHeight);
  } else {
    const windowRadius = clamp(settings.windowRadius, 0, Math.min(windowRect.w, windowRect.h) / 2);
    const showShadow = settings.shadowEnabled;
    if (showShadow) {
      ctx.save();
      ctx.shadowColor = `rgba(2,6,23,${settings.shadowOpacity})`;
      ctx.shadowBlur = settings.shadowBlur;
      ctx.shadowOffsetY = settings.shadowOffsetY;
      ctx.fillStyle = "rgba(2,6,23,0.72)";
      drawRoundRectPath(ctx, windowRect, windowRadius);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    drawRoundRectPath(ctx, windowRect, windowRadius);
    ctx.clip();
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(windowRect.x, windowRect.y, windowRect.w, windowRect.h);
    ctx.drawImage(screenVideo, crop.sx, crop.sy, crop.sw, crop.sh, windowRect.x, windowRect.y, windowRect.w, windowRect.h);
    ctx.restore();
  }
  if (profilingEnabled) {
    windowMs = performance.now() - windowStartedAt;
  }

  if (webcamEnabled && webcamVideo && webcamVideo.videoWidth > 0 && webcamVideo.videoHeight > 0) {
    webcamRenderEnabled = true;
    const webcamStartedAt = profilingEnabled ? performance.now() : 0;
    const safeMargin = Math.max(
      8,
      Math.round((Math.min(frameWidth, frameHeight) / 1080) * WEBCAM_SAFE_MARGIN_AT_1080)
    );
    const overlaySize = Math.max(48, Math.round(Math.min(frameWidth, frameHeight) * settings.webcamScale));
    const overlayFrame = webcamFrameRect(frameWidth, frameHeight, overlaySize, settings.webcamPosition, safeMargin);
    const normalizedRadius = clamp(settings.webcamRadius / Math.max(1, maxWebcamRadiusSetting), 0, 1);
    const smallOverlayRect: Rect = {
      x: overlayFrame.x,
      y: overlayFrame.y,
      w: overlayFrame.w,
      h: overlayFrame.h
    };
    const smallOverlayEffectiveSize = Math.min(smallOverlayRect.w, smallOverlayRect.h);
    const smallOverlayRadius = smallOverlayEffectiveSize * 0.5 * normalizedRadius;
    const smallOverlayCircleMode = normalizedRadius >= 0.999;
    const fullScreenRect: Rect = { x: 0, y: 0, w: frameWidth, h: frameHeight };

    const rectForMode = (mode: WebcamMode): Rect => (mode === "full-screen" ? fullScreenRect : smallOverlayRect);
    const shapeForMode = (mode: WebcamMode): { radius: number; circle: boolean } =>
      mode === "small-overlay" ? { radius: smallOverlayRadius, circle: smallOverlayCircleMode } : { radius: 0, circle: false };

    const transitionActive =
      webcamTransitionFromMode !== null && webcamTransitionFromMode !== webcamMode && webcamTransitionProgress < 1;
    const easedTransition = easeInOutCubic(clamp(webcamTransitionProgress, 0, 1));

    let webcamFrame: Rect;
    let webcamRadius: number;
    let webcamCircleClip = false;
    let webcamOpacity = 1;
    if (transitionActive && webcamTransitionFromMode) {
      if (webcamTransitionFromMode !== "none" && webcamMode !== "none") {
        webcamFrame = lerpRect(rectForMode(webcamTransitionFromMode), rectForMode(webcamMode), easedTransition);
        const fromShape = shapeForMode(webcamTransitionFromMode);
        const toShape = shapeForMode(webcamMode);
        webcamRadius = lerp(fromShape.radius, toShape.radius, easedTransition);
        webcamCircleClip = fromShape.circle && toShape.circle;
      } else if (webcamTransitionFromMode === "none") {
        const targetRect = rectForMode(webcamMode);
        const targetShape = shapeForMode(webcamMode);
        webcamFrame = scaleRect(targetRect, lerp(0.92, 1, easedTransition));
        webcamRadius = targetShape.radius;
        webcamCircleClip = targetShape.circle;
        webcamOpacity = easedTransition;
      } else {
        const startRect = rectForMode(webcamTransitionFromMode);
        const startShape = shapeForMode(webcamTransitionFromMode);
        webcamFrame = scaleRect(startRect, lerp(1, 0.96, easedTransition));
        webcamRadius = startShape.radius;
        webcamCircleClip = startShape.circle;
        webcamOpacity = 1 - easedTransition;
      }
    } else {
      if (webcamMode === "none") {
        return;
      }
      webcamFrame = rectForMode(webcamMode);
      const webcamShape = shapeForMode(webcamMode);
      webcamRadius = webcamShape.radius;
      webcamCircleClip = webcamShape.circle;
    }

    ctx.save();
    if (webcamCircleClip) {
      drawCirclePath(ctx, webcamFrame);
    } else if (webcamRadius > 0.01) {
      drawRoundRectPath(ctx, webcamFrame, webcamRadius);
    } else {
      ctx.beginPath();
      ctx.rect(webcamFrame.x, webcamFrame.y, webcamFrame.w, webcamFrame.h);
      ctx.closePath();
    }
    ctx.clip();
    const baseOpacity = clamp(webcamOpacity, 0, 1);
    const webcamBeautifyEnabled = settings.webcamBeautifyEnabled;
    const smoothRadius = webcamBeautifyEnabled ? clamp(settings.webcamBeautifySmoothRadius, 0, MAX_WEBCAM_BEAUTIFY_SMOOTH_RADIUS) : 0;
    const exposure = webcamBeautifyEnabled ? clamp(settings.webcamBeautifyExposure, -MAX_WEBCAM_BEAUTIFY_EXPOSURE, MAX_WEBCAM_BEAUTIFY_EXPOSURE) : 0;
    const brightness = 1 + exposure / 100;
    const brightnessFilter = `brightness(${brightness.toFixed(3)})`;
    beautifyEnabled = webcamBeautifyEnabled && (smoothRadius > 0.01 || Math.abs(exposure) > 0.01);

    if (!webcamBeautifyEnabled || (smoothRadius <= 0.01 && Math.abs(exposure) <= 0.01)) {
      ctx.globalAlpha = baseOpacity;
      drawImageCover(ctx, webcamVideo, webcamFrame.x, webcamFrame.y, webcamFrame.w, webcamFrame.h, webcamVideo.videoWidth, webcamVideo.videoHeight);
      ctx.globalAlpha = 1;
      ctx.restore();
      if (profilingEnabled) {
        webcamMs = performance.now() - webcamStartedAt;
      }
      onProfile?.({
        backgroundEnabled,
        backgroundCacheHit,
        backgroundMs,
        windowMs,
        webcamEnabled: webcamRenderEnabled,
        webcamMs,
        beautifyEnabled,
        beautifyMs
      });
      return;
    }

    const beautifyStartedAt = profilingEnabled ? performance.now() : 0;
    ctx.globalAlpha = baseOpacity;
    ctx.filter = brightnessFilter;
    drawImageCover(ctx, webcamVideo, webcamFrame.x, webcamFrame.y, webcamFrame.w, webcamFrame.h, webcamVideo.videoWidth, webcamVideo.videoHeight);

    if (smoothRadius > 0.1) {
      const smoothBlend = clamp(0.08 + smoothRadius * 0.03, 0.08, 0.32);
      ctx.globalAlpha = baseOpacity * smoothBlend;
      ctx.filter = `${brightnessFilter} blur(${smoothRadius.toFixed(2)}px)`;
      drawImageCover(ctx, webcamVideo, webcamFrame.x, webcamFrame.y, webcamFrame.w, webcamFrame.h, webcamVideo.videoWidth, webcamVideo.videoHeight);
    }
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.restore();
    if (profilingEnabled) {
      beautifyMs = performance.now() - beautifyStartedAt;
      webcamMs = performance.now() - webcamStartedAt;
    }
  }
  onProfile?.({
    backgroundEnabled,
    backgroundCacheHit,
    backgroundMs,
    windowMs,
    webcamEnabled: webcamRenderEnabled,
    webcamMs,
    beautifyEnabled,
    beautifyMs
  });
}
