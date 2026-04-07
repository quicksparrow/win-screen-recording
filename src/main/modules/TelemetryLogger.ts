import fs from "node:fs";
import path from "node:path";
import type { TelemetryEvent, TelemetryFile } from "../../shared/types";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeTelemetryEvent(event: TelemetryEvent): TelemetryEvent | null {
  if (!isFiniteNumber(event.timestampMs) || event.timestampMs < 0) {
    return null;
  }

  if (event.type === "cursor" || event.type === "mouse-down" || event.type === "mouse-up") {
    if (
      !isFiniteNumber(event.x) ||
      !isFiniteNumber(event.y) ||
      !isFiniteNumber(event.viewportWidth) ||
      !isFiniteNumber(event.viewportHeight) ||
      event.viewportWidth <= 0 ||
      event.viewportHeight <= 0
    ) {
      return null;
    }

    if ((event.type === "mouse-down" || event.type === "mouse-up") && !Number.isInteger(event.button)) {
      return null;
    }

    return event;
  }

  if (event.type === "key-down" || event.type === "key-up") {
    if (typeof event.key !== "string" || typeof event.code !== "string" || typeof event.repeat !== "boolean") {
      return null;
    }
    return event;
  }

  return null;
}

export class TelemetryLogger {
  private readonly outputPath: string;
  private readonly events: TelemetryEvent[] = [];

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  appendEvents(events: TelemetryEvent[]): number {
    let accepted = 0;
    for (const event of events) {
      const sanitized = sanitizeTelemetryEvent(event);
      if (!sanitized) {
        continue;
      }
      this.events.push(sanitized);
      accepted += 1;
    }

    return accepted;
  }

  async close(): Promise<{ path: string; count: number }> {
    const payload: TelemetryFile = {
      schemaVersion: 1,
      createdAtIso: new Date().toISOString(),
      events: this.events
    };

    await fs.promises.mkdir(path.dirname(this.outputPath), { recursive: true });
    await fs.promises.writeFile(this.outputPath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: this.outputPath, count: this.events.length };
  }
}

