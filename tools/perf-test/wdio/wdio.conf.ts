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
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { readMeasures, resetMeasures } from "./perf-report";

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
 * Ensure the Tauri app will have an X display, WITHOUT depending on an ambient one.
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538):
 * `@wdio/xvfb` wraps each SPEC WORKER in `xvfb-run`, but the app process is not a
 * child of a worker — it is launched by tauri-driver, which `onPrepare` spawns in
 * the LAUNCHER process. So the app inherits the LAUNCHER's environment, and the
 * worker-level xvfb wrapper does nothing for it. With an ambient `DISPLAY` (an
 * interactive shell on this box has `:1`) that goes unnoticed; run the same command
 * from anywhere without one — a routine, a cron, CI, an operator-spawned job, i.e.
 * exactly the UNATTENDED scheduling this suite exists to enable — and the binary
 * dies on:
 *
 *   thread 'main' panicked at tao-0.35.0/.../event_loop.rs:217:
 *   Failed to initialize gtk backend!: Failed to initialize GTK
 *
 * That is an opaque Rust panic several layers below the test, and it reads as "the
 * desktop build is broken" rather than "there is no display", so it costs a real
 * diagnosis every time. Wrapping tauri-driver in `xvfb-run -a` (auto-pick a free
 * display) makes the runner self-sufficient: the driver, and therefore the app,
 * always has a display, and the suite becomes schedulable unattended.
 *
 * Returns the argv to spawn. Prefers an ambient DISPLAY when present so an
 * interactive/debug run still shows a real window.
 */
function driverCommand(args: readonly string[]): { file: string; argv: string[] } {
  if (process.env.DISPLAY) return { file: "tauri-driver", argv: [...args] };
  try {
    execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "[wdio.conf.ts] No DISPLAY is set and `xvfb-run` is not on PATH, so the Tauri " +
        "binary would panic with an opaque `Failed to initialize GTK` deep in tao. " +
        "Install it with:\n\n  sudo apt install xvfb\n\n" +
        "(or export DISPLAY=:N pointing at a running X server). " +
        "perf-testing-sweep-2026-07-27 / WI-6538 — this used to surface as a Rust " +
        "panic that read like a broken desktop build.",
    );
  }
  // -a: pick a free display number rather than colliding with the many `Xvfb :0`
  // instances other agents' e2e sessions keep alive on this box.
  return { file: "xvfb-run", argv: ["-a", "tauri-driver", ...args] };
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
 * POST this run's measures to the operator so they land in
 * `harness_shared.desktop_perf_runs` — the table the desktop-perf RELEASE GATE
 * reads (perf-testing-sweep-2026-07-27, WI-6538 / WI-6535).
 *
 * Until this existed the runner measured real interactions and discarded them, the
 * table stayed empty from 2026-07-20 onward, and `desktopPerfGate` took its
 * fail-soft "no fresh run" branch on EVERY deploy — a perf gate that had never
 * measured anything. Publishing here is what makes the gate capable of firing.
 *
 * NEVER FAILS THE RUN: a publish problem (operator down, no token, stale build
 * without the ingest route) is logged loudly and swallowed. The perf assertions
 * already passed or failed on their own merits in the workers; turning a healthy
 * run red because a side-channel POST failed would be a worse defect than the one
 * this fixes. The log line is deliberately explicit about WHY, because a silent
 * no-op here is exactly how the original starvation went unnoticed for 8 days.
 */
async function publishMeasures(): Promise<void> {
  const measures = readMeasures();
  if (measures.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[perf-report] NOTHING TO PUBLISH — no measures were recorded, so no run row " +
        "will exist and the desktop-perf gate stays starved. Check that the specs " +
        "actually reached their recordInteractionMs calls.",
    );
    return;
  }

  // The ingest route requires a trusted bearer; the superuser token is the local
  // operator credential (resolves to trust:'trusted' — packages/agent-mcp/src/auth.ts).
  const tokenPath = path.join(os.homedir(), ".papercusp", "superuser-token");
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    // eslint-disable-next-line no-console
    console.error(
      `[perf-report] cannot publish ${measures.length} measure(s): no readable token at ${tokenPath}`,
    );
    return;
  }

  // Default to the green operator on :3070. Override with PAPERCUSP_OPERATOR_URL
  // (e.g. http://127.0.0.1:3170) to target the staging operator — necessary
  // whenever the ingest route is newer than what :3070's release checkout serves.
  const base = (process.env.PAPERCUSP_OPERATOR_URL ?? "http://127.0.0.1:3070").replace(/\/$/, "");
  const url = `${base}/api/admin/testing/desktop-perf-runs`;

  // Best-effort commit correlation so a recorded run is attributable to code.
  let gitSha: string | null = null;
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
    }).trim();
  } catch {
    /* not a git checkout, or git unavailable — the row is still worth recording */
  }

  const failing = measures.filter((m) => !m.ok);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ measures, gitSha, runId: process.env.PAPERCUSP_PERF_RUN_ID ?? null }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `[perf-report] publish REJECTED (${res.status}) by ${url}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[perf-report] published ${measures.length} measure(s) to ${url} ` +
        `(${failing.length} over budget): ${JSON.stringify(await res.json().catch(() => ({})))}`,
    );
    // Only clear once the operator has durably accepted them — a failed publish
    // leaves the file so the next run's onPrepare reset is the deliberate discard.
    resetMeasures();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[perf-report] publish FAILED to ${url}:`, err);
  }
}

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
    // Discard measures from a previously CRASHED run (one that died before
    // onComplete consumed them) so stale timings are never published against this
    // commit — reporting none beats reporting someone else's numbers.
    resetMeasures();
    const driverPort = process.env.TAURI_DRIVER_PORT
      ? Number(process.env.TAURI_DRIVER_PORT)
      : await getFreePort();
    let nativePort = process.env.TAURI_DRIVER_NATIVE_PORT
      ? Number(process.env.TAURI_DRIVER_NATIVE_PORT)
      : await getFreePort();
    while (nativePort === driverPort) nativePort = await getFreePort();

    process.env.TAURI_DRIVER_PORT = String(driverPort);
    // See driverCommand: the app inherits THIS process's environment, so the display
    // must be arranged here — the worker-level @wdio/xvfb wrapper never reaches it.
    const { file, argv } = driverCommand([
      "--port",
      String(driverPort),
      "--native-port",
      String(nativePort),
    ]);
    tauriDriver = spawn(file, argv, { stdio: ["ignore", "inherit", "inherit"] });
  },
  // Publish BEFORE killing the driver so a publish hang can't leave tauri-driver
  // orphaned; the kill is in a finally for the same reason.
  async onComplete() {
    try {
      await publishMeasures();
    } finally {
      tauriDriver?.kill();
    }
  },

  hostname: "127.0.0.1",
  port: resolveDriverPort(),
};
