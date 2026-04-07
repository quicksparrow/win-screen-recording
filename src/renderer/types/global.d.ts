import type { DesktopApi } from "../../shared/types";

declare global {
  interface Window {
    desktopAPI: DesktopApi;
  }
}

export {};

