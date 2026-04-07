import fs from "node:fs";
import path from "node:path";

export class StorageManager {
  private stream: fs.WriteStream | null = null;
  private streamError: Error | null = null;

  async openChunkWriter(filePath: string): Promise<void> {
    if (this.stream) {
      await this.closeChunkWriter();
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    this.streamError = null;
    const stream = fs.createWriteStream(filePath, {
      flags: "w",
      highWaterMark: 1024 * 1024
    });
    stream.on("error", (error) => {
      this.streamError = error;
    });

    this.stream = stream;

    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", (error) => reject(error));
    });
  }

  async writeChunk(chunk: Buffer): Promise<void> {
    if (!this.stream) {
      throw new Error("Chunk writer is not initialized.");
    }
    if (this.streamError) {
      throw this.streamError;
    }

    await new Promise<void>((resolve, reject) => {
      this.stream?.write(chunk, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async closeChunkWriter(): Promise<void> {
    if (!this.stream) {
      return;
    }

    const stream = this.stream;
    this.stream = null;

    await new Promise<void>((resolve, reject) => {
      stream.once("error", (error) => reject(error));
      stream.end(() => resolve());
    });

    if (this.streamError) {
      throw this.streamError;
    }
  }
}
