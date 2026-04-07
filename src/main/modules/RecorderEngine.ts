import type { AspectRatio } from "../../shared/types";
import { StorageManager } from "./StorageManager";

export interface RecorderStartOptions {
  sourceId: string;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  aspectRatio: AspectRatio;
  outputFile: string;
}

export class RecorderEngine {
  private readonly storage = new StorageManager();

  async startRecording(options: RecorderStartOptions): Promise<void> {
    // Stub for desktop stream + audio graph setup; chunk persistence is delegated to StorageManager.
    await this.storage.openChunkWriter(options.outputFile);
  }

  async appendChunk(data: Buffer): Promise<void> {
    await this.storage.writeChunk(data);
  }

  async stopRecording(): Promise<void> {
    await this.storage.closeChunkWriter();
  }
}

