/**
 * WebdriverIO config for driving the packaged Papercusp Tauri binary
 * via tauri-driver (https://v2.tauri.app/develop/tests/webdriver/).
 *
 * Prereqs:
 *   1. cargo install tauri-driver          (✓ installed)
 *   2. sudo apt install webkit2gtk-driver  (Linux only — required for WebKitGTK WebDriver;
 *      preflight-checked in onPrepare below, so a missing install now fails fast with a
 *      clear message instead of a silent multi-minute session timeout — WI-5662)
 *   3. Build the desktop app:               pnpm --filter @papercusp/desktop build
 *   4. Set TAURI_APP_PATH below to the binary in the resulting bundle
 *
 * Then: pnpm --filter @papercusp/perf-test-wdio test
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Allocate a free ephemeral TCP port from the OS: bind to :0, read back what
 * the kernel assigned, close immediately, return it. Two independent calls
 * are used below (driver port + native port) rather than one fixed value —
 * this box runs dozens of concurrent agent/e2e sessions, so any hardcoded
 * port is a collision waiting to happen (WI-5662 point 3).
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("getFreePort: could not resolve an ephemeral port")));
      }
    });
  });
}

/**
 * tauri-driver defaults `--native-port` (the port it spawns the OS-native
 * WebDriver on) to **4445** — see tauri-driver 2.0.6 `src/cli.rs`. This repo's
 * config used to pass only `--port 4445` (its OWN intermediary-server port)
 * and never set `--native-port`, so the native WebKitWebDriver's *default*
 * native-port (4445) collided with tauri-driver's own `--port` (also 4445,
 * since that's the very value this config chose). tauri-driver's own HTTP
 * server always wins the bind race, so WebKitWebDriver crashed on startup
 * with `FATAL: Unable to listen for HTTP server at host 127.0.0.1 and port
 * 4445` (its stderr, inherited through tauri-driver's stdio) and became a
 * zombie — leaving every `POST /session` to time out against a tauri-driver
 * that had no native driver behind it. 100% deterministic, unrelated to box
 * load. Root-caused + reproduced live 2026-07-20 (WI-5662): confirmed via
 * `tauri-driver --port 4445` alone (FATAL + defunct WebKitWebDriver) vs.
 * `tauri-driver --port 4445 --native-port 4444` (both bind cleanly). Fix:
 * always pass EXPLICIT, DISTINCT `--port`/`--native-port` values — ephemeral
 * ones, per the box-collision note above.
 */
function assertNativeWebDriverAvailable(): void {
  if (process.platform !== "linux") return; // macOS: safaridriver ships with the OS
  try {
    execFileSync("which", ["WebKitWebDriver"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "[wdio.conf.ts] WebKitWebDriver not found on PATH. tauri-driver needs it to drive " +
        "the WebKitGTK-backed Tauri webview on Linux. Install it with:\n\n" +
        "  sudo apt install webkit2gtk-driver\n\n" +
        "(desktop-performance-suite-2026-07-20 / WI-5662 — this used to fail as an opaque " +
        "5-minute session timeout instead of this preflight message.)"
    );
  }
}

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

/**
 * The port workers actually connect on. wdio's `local` runner FORKS a
 * SEPARATE child process per spec file — `onPrepare` below runs only in the
 * launcher process, so mutating the exported `config` object from inside it
 * is invisible to worker processes (different process, different memory; a
 * first attempt at this fix did exactly that and every worker still hit the
 * stale port). What DOES reach workers: `@wdio/local-runner` reads
 * `process.env` fresh at fork time (after `onPrepare` resolves) and passes it
 * to each worker, and each worker re-imports this config file fresh in its
 * own process. So the real (ephemeral, collision-free) port is decided ONCE
 * in `onPrepare`, stashed in `process.env.TAURI_DRIVER_PORT` there, and read
 * back here at module scope — which runs once per process: the launcher's
 * own first import gets the (unused) placeholder below, and each worker's
 * import — happening after the launcher set the env var — gets the real one.
 */
function resolveDriverPort(): number {
  const fromEnv = process.env.TAURI_DRIVER_PORT;
  return fromEnv ? Number(fromEnv) : 4445; // placeholder; see doc comment above
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "wry",
      // @wdio/protocols ≥9 auto-injects `webSocketUrl: true` (opting into
      // WebDriver BiDi) for any capability whose browserName isn't "safari"
      // — see webdriver/build/node.js's newSession assembly. WebKitWebDriver
      // does not implement BiDi, so it flatly rejects that injected
      // capability with "Failed to match capabilities" — a session-creation
      // failure that only became visible once the port-binding bug above was
      // fixed (confirmed live via a raw curl POST /session repro, WI-5662).
      // This opts back out to classic (non-BiDi) WebDriver, which
      // WebKitWebDriver does support.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application: TAURI_APP_PATH },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Preflight-check the native driver, allocate two DISTINCT ephemeral ports
  // (see assertNativeWebDriverAvailable's doc comment for why they must
  // differ), spawn tauri-driver, and publish the chosen port via env (see
  // resolveDriverPort's doc comment for why that — not mutating `config`
  // in-place — is what actually reaches worker processes).
  async onPrepare() {
    assertNativeWebDriverAvailable();
    const driverPort = process.env.TAURI_DRIVER_PORT
      ? Number(process.env.TAURI_DRIVER_PORT)
      : await getFreePort();
    let nativePort = process.env.TAURI_DRIVER_NATIVE_PORT
      ? Number(process.env.TAURI_DRIVER_NATIVE_PORT)
      : await getFreePort();
    while (nativePort === driverPort) nativePort = await getFreePort();

    process.env.TAURI_DRIVER_PORT = String(driverPort);
    tauriDriver = spawn(
      "tauri-driver",
      ["--port", String(driverPort), "--native-port", String(nativePort)],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
  },
  onComplete() {
    tauriDriver?.kill();
  },

  hostname: "127.0.0.1",
  port: resolveDriverPort(),
};
