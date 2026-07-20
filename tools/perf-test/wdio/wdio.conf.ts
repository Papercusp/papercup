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
import { existsSync } from "node:fs";
import path from "node:path";

const TAURI_DRIVER_PORT = 4445;

/**
 * Resolve the packaged Tauri binary. `TAURI_APP_PATH` wins; otherwise try the
 * real build locations in preference order. NOTE: the desktop app is the
 * in-repo `papercusp-desktop` submodule (binary name `papercusp-desktop`) — the
 * old default here pointed at the retired `libs/papercusp/apps/desktop` path
 * with the wrong binary name, so a plain `npm test` never found the binary
 * (desktop-performance-suite-2026-07-20 P-008). RELEASE is strongly preferred:
 * a DEBUG build runs several-fold slower, so its interaction timings blow the
 * release-tuned budgets — use debug only for wiring/smoke, never budget asserts.
 */
function resolveTauriAppPath(): string {
  if (process.env.TAURI_APP_PATH) return process.env.TAURI_APP_PATH;
  const repoRoot = path.resolve(__dirname, "../../..");
  const cargoTarget = process.env.CARGO_TARGET_DIR || null;
  const candidates = [
    cargoTarget && path.join(cargoTarget, "release", "papercusp-desktop"),
    path.join(repoRoot, "papercusp-desktop", "src-tauri", "target", "release", "papercusp-desktop"),
    cargoTarget && path.join(cargoTarget, "debug", "papercusp-desktop"),
    path.join(repoRoot, "papercusp-desktop", "src-tauri", "target", "debug", "papercusp-desktop"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  // Fall back to the canonical release path so a "not built yet" failure names
  // the expected location.
  return found ?? candidates[0];
}

const TAURI_APP_PATH = resolveTauriAppPath();

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
