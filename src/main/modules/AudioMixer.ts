export interface AudioLevels {
  microphone: number;
  system: number;
}

export class AudioMixer {
  private micVolume = 1;
  private systemVolume = 1;

  setMicVolume(volume: number): void {
    this.micVolume = Math.min(1, Math.max(0, volume));
  }

  setSystemVolume(volume: number): void {
    this.systemVolume = Math.min(1, Math.max(0, volume));
  }

  getLevels(): AudioLevels {
    return { microphone: this.micVolume, system: this.systemVolume };
  }
}

