import { app, BrowserWindow, ipcMain, powerMonitor, session, type IpcMainEvent } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { registerIpcHandlers } from "./ipc";

let mainWindow: BrowserWindow | null = null;
let allowWindowClose = false;
let closeDialogOpen = false;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(devServerUrl);

app.commandLine.appendSwitch("disable-renderer-backgrounding");

function requestExitConfirmationFromRenderer(windowRef: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      ipcMain.removeListener("app:exit-confirmation-response", onResponse);
      windowRef.removeListener("closed", onWindowClosed);
      resolve(confirmed);
    };

    const onResponse = (event: IpcMainEvent, confirmed: unknown) => {
      if (event.sender !== windowRef.webContents) {
        return;
      }
      finish(confirmed === true);
    };

    const onWindowClosed = () => {
      finish(false);
    };

    const timeoutId = setTimeout(() => {
      finish(false);
    }, 120_000);

    ipcMain.on("app:exit-confirmation-response", onResponse);
    windowRef.once("closed", onWindowClosed);

    if (windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) {
      finish(false);
      return;
    }

    windowRef.webContents.send("app:show-exit-confirmation", {
      title: "Exit application?",
      message: "Exit application?",
      detail: "Are you sure you want to close the app?",
      timestampMs: Date.now()
    });
  });
}

function logWorkflowDiagnostic(stage: string, detail = ""): void {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[workflow:diag:main] ts=${new Date().toISOString()} epochMs=${Date.now()} stage=${stage}${suffix}`);
}

function emitSystemPowerState(state: "lock-screen" | "unlock-screen" | "suspend" | "resume"): void {
  const payload = { state, timestampMs: Date.now() };
  logWorkflowDiagnostic("system-power-state", `state=${state}`);
  BrowserWindow.getAllWindows().forEach((windowRef) => {
    if (windowRef.isDestroyed()) return;
    windowRef.webContents.send("system:power-state", payload);
  });
}

if (!(app as unknown)) {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const relaunchCandidates = [process.env.PORTABLE_EXECUTABLE_FILE, process.execPath, process.argv0, process.argv[0]].filter(
      (value): value is string => Boolean(value)
    );
    const relaunchTarget =
      relaunchCandidates.find((candidate) => fs.existsSync(candidate) && !/\\node(?:\.exe)?$/i.test(candidate)) ??
      relaunchCandidates.find((candidate) => fs.existsSync(candidate)) ??
      process.execPath;
    const child = spawn(relaunchTarget, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env
    });
    child.unref();
  }
  process.exit(0);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      return true;
    }

    if (!isDev || !devServerUrl) {
      return false;
    }

    return value.startsWith(devServerUrl);
  } catch {
    return false;
  }
}

function resolveWindowIconPath(): string | undefined {
  const devIconPath = path.join(process.cwd(), "build", "icon.png");
  if (!app.isPackaged) {
    return fs.existsSync(devIconPath) ? devIconPath : undefined;
  }

  const packagedIconPath = path.join(process.resourcesPath, "icon.png");
  if (fs.existsSync(packagedIconPath)) {
    return packagedIconPath;
  }

  return fs.existsSync(devIconPath) ? devIconPath : undefined;
}

function createMainWindow(): void {
  const iconPath = resolveWindowIconPath();
  logWorkflowDiagnostic("window-create:start", `packaged=${app.isPackaged ? "yes" : "no"} dev=${isDev ? "yes" : "no"}`);
  mainWindow = new BrowserWindow({
    show: false,
    title: "Screen Recorder Studio",
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#f4f8ff",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("close", (event) => {
    if (allowWindowClose) {
      return;
    }

    event.preventDefault();
    if (closeDialogOpen) {
      return;
    }

    closeDialogOpen = true;
    const windowRef = mainWindow;
    if (!windowRef) {
      closeDialogOpen = false;
      return;
    }

    void requestExitConfirmationFromRenderer(windowRef)
      .then((confirmed) => {
        if (!confirmed || windowRef.isDestroyed()) {
          return;
        }
        allowWindowClose = true;
        windowRef.close();
      })
      .finally(() => {
        closeDialogOpen = false;
      });
  });
  mainWindow.once("ready-to-show", () => {
    logWorkflowDiagnostic("window-ready-to-show");
    mainWindow?.show();
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });

  if (isDev && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  mainWindow.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
}

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
});

process.on("uncaughtException", (error) => {
  console.error("[main] uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection", reason);
});

app.whenReady().then(() => {
  logWorkflowDiagnostic("app-ready", `platform=${process.platform}`);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = webContents.getURL();
    const trusted = isTrustedRendererUrl(requestingUrl);
    callback(trusted && permission === "media");
  });

  registerIpcHandlers();
  logWorkflowDiagnostic("ipc-registered");
  createMainWindow();
  powerMonitor.on("lock-screen", () => emitSystemPowerState("lock-screen"));
  powerMonitor.on("unlock-screen", () => emitSystemPowerState("unlock-screen"));
  powerMonitor.on("suspend", () => emitSystemPowerState("suspend"));
  powerMonitor.on("resume", () => emitSystemPowerState("resume"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
