/**
 * WebdriverIO config for driving the packaged Papercusp Tauri binary
 * via tauri-driver (https://v2.tauri.app/develop/tests/webdriver/).
 *
 * Prereqs:
 *   1. cargo install tauri-driver          (✓ installed)
 *   2. sudo apt install webkit2gtk-driver  (Linux only — required for WebKitGTK WebDriver)
 *   3. Build the desktop app:               pnpm --filter @papercusp/desktop build
 *   4. Set TAURI_APP_PATH below to the binary in the resulting bundle
 *
 * Then: pnpm --filter @papercusp/perf-test-wdio test
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const TAURI_DRIVER_PORT = 4445;

// Path to the packaged Tauri binary — adjust after `tauri build` produces it.
const TAURI_APP_PATH =
  process.env.TAURI_APP_PATH ??
  path.resolve(
    __dirname,
    "../../../libs/papercusp/apps/desktop/src-tauri/target/release/papercusp"
  );

let tauriDriver: ChildProcess | null = null;

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "wry",
      "tauri:options": { application: TAURI_APP_PATH },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Spawn tauri-driver before the session, kill it after.
  onPrepare() {
    tauriDriver = spawn("tauri-driver", ["--port", String(TAURI_DRIVER_PORT)], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  },
  onComplete() {
    tauriDriver?.kill();
  },

  hostname: "127.0.0.1",
  port: TAURI_DRIVER_PORT,
};
