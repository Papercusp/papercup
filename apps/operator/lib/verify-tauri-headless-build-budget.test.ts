/**
 * EI-20229366113827667 — a cold cargo build must not consume the bridge
 * readiness budget.
 *
 * The verifier is an integration script that boots a real Tauri/Xvfb/sidecar
 * stack, so the recurrence guard pins the phase transition at the script's
 * wiring site and exercises the timing contract with a synthetic tauri.log.
 * The synthetic log deliberately places Cargo's Running marker at T+150s —
 * inside the separate build budget but beyond the 180s bridge budget that used
 * to be charged from launch.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without ever mutating the
// shared checkout (where git-sync would happily commit the mutant mid-probe).
const SCRIPT =
  process.env.PROBE_SCRIPT ??
  resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const src = readFileSync(SCRIPT, "utf8");

describe("EI-20229366113827667 — build and bridge readiness use separate clocks", () => {
  it("leaves frontend readiness to the bounded owned-origin gate, not the CLI pre-build timer", () => {
    const launch = src.match(/npm run tauri -- dev[^\n]+/)?.[0];
    expect(launch).toContain("--no-dev-server-wait");
    const originGate = src.slice(
      src.indexOf('HEALTH_TIMEOUT="${VERIFY_TAURI_HEALTH_TIMEOUT:-120}"'),
      src.indexOf('log "origin health confirmed:'),
    );
    expect(originGate).toContain("fetch('/api/health')");
    expect(originGate).toContain("fetch('/')");
    expect(originGate).toContain('"apiHealth"[[:space:]]*:[[:space:]]*200');
    expect(originGate).toContain('"rootHtml"[[:space:]]*:[[:space:]]*200');
    expect(originGate).toContain("HEALTH_DEADLINE");
    expect(originGate).toContain("exit 1");
  });

  it("exposes an independent bounded cargo-build timeout", () => {
    expect(src).toMatch(/VERIFY_TAURI_BUILD_TIMEOUT/);
    expect(src).toMatch(
      /BUILD_TIMEOUT="\$\{VERIFY_TAURI_BUILD_TIMEOUT:-300\}"/,
    );
    expect(src).toMatch(/VERIFY_TAURI_TIMEOUT.*AFTER the desktop/);
  });

  it("waits for the desktop binary marker before entering the bridge wait", () => {
    const buildWait = src.match(
      /  until desktop_binary_started;[\s\S]*?\n  done/,
    )?.[0];
    const bridgeWait = src.match(
      /    until grep -q "dev bridge listening"[\s\S]*?\n    done/,
    )?.[0];

    expect(buildWait, "the build-phase wait must remain explicit").toBeTruthy();
    expect(
      bridgeWait,
      "the bridge-phase wait must remain explicit",
    ).toBeTruthy();
    expect(src.indexOf(buildWait!)).toBeLessThan(src.indexOf(bridgeWait!));
    expect(buildWait).toContain("BUILD_TIMEOUT");
    expect(buildWait).toContain("port_lost_to_squatter");

    const bridgeStart = src.indexOf(bridgeWait!);
    const reset = src.lastIndexOf("ELAPSED=0", bridgeStart);
    expect(reset).toBeGreaterThan(src.indexOf(buildWait!));
    expect(reset).toBeLessThan(bridgeStart);
    expect(src.slice(bridgeStart)).toContain(
      "bridge did not come up within ${TIMEOUT}s after the desktop binary started",
    );
  });

  it("keeps a synthetic cold build at T+150s alive through bridge readiness", () => {
    const syntheticLog = [
      ...Array.from({ length: 75 }, (_, i) => `cargo build progress ${i}`),
      "Running `/tmp/target/debug/papercusp-desktop`",
      ...Array.from({ length: 10 }, (_, i) => `bridge startup progress ${i}`),
      "dev bridge listening",
    ].join("\n");

    const buildTimeout = 300;
    const bridgeTimeout = 180;
    let phase: "build" | "bridge" = "build";
    let elapsed = 0;
    let toreDown = false;

    for (const line of syntheticLog.split("\n")) {
      if (phase === "build" && /Running .*papercusp-desktop/.test(line)) {
        phase = "bridge";
        elapsed = 0;
        continue;
      }
      if (phase === "bridge" && line.includes("dev bridge listening")) break;

      elapsed += 2;
      if (elapsed >= (phase === "build" ? buildTimeout : bridgeTimeout)) {
        toreDown = true;
        break;
      }
    }

    expect(toreDown).toBe(false);
    expect(phase).toBe("bridge");
    expect(src).toContain("desktop binary started after ${BUILD_ELAPSED}s");
    expect(src).toContain('ELAPSED="$BUILD_ELAPSED"');
  });
});

/**
 * Regression guard for the COLORIZED marker.
 *
 * The build/bridge split above shipped green while being unable to detect a
 * desktop start at all. tauri runs `cargo run ... --color always --`, so the
 * marker reaches tauri.log as `ESC[1mESC[92m     RunningESC[0m \`...\``, and the
 * original predicate `grep -qE "Running .*papercusp-desktop"` requires a
 * LITERAL SPACE after "Running" where the next byte is ESC. It could therefore
 * never match: every run burned the full BUILD_TIMEOUT and died with "desktop
 * binary did not start ... (cargo build phase)" while the desktop was up and
 * serving. Raising the budget only changed how long the failure took.
 *
 * It shipped green because the suite above builds its fixture UNCOLORED and
 * then re-implements the regex in TypeScript (`/Running .*papercusp-desktop/`)
 * instead of running the shell predicate — so the test encoded the same wrong
 * assumption as the code and could not fail.
 *
 * These tests do the opposite on both counts: the fixture carries real escape
 * bytes, and the assertion EXECUTES the script's own functions rather than a
 * copy of them.
 */
describe("binary-start detection survives cargo --color always", () => {
  // Exactly the byte sequence observed in a live run's tauri.log. ESC is built
  // from an escape sequence rather than pasted, so the fixture cannot silently
  // lose its control bytes (and so this file stays clean for
  // lint:no-control-bytes, which is a green-checkpoint leg).
  const ESC = "\x1b";
  const COLORIZED = `${ESC}[1m${ESC}[92m     Running${ESC}[0m \`/home/u/.cargo-target-dev3/debug/papercusp-desktop\``;

  /** Runs the SCRIPT'S OWN predicate, extracted verbatim, against a fixture. */
  const detects = (logBody: string): boolean => {
    const stripAnsi = src.match(/^strip_ansi\(\)[\s\S]*?\n}/m)?.[0];
    const started = src.match(/^desktop_binary_started\(\)[\s\S]*?\n}/m)?.[0];
    expect(stripAnsi, "strip_ansi() must exist to be tested").toBeTruthy();
    expect(
      started,
      "desktop_binary_started() must exist to be tested",
    ).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), "vth-color-"));
    try {
      const logPath = join(dir, "tauri.log");
      writeFileSync(logPath, logBody);
      const out = spawnSync(
        "bash",
        [
          "-c",
          `${stripAnsi}\n${started}\nLOG="$1"; desktop_binary_started && echo YES || echo NO`,
          "_",
          logPath,
        ],
        { encoding: "utf8" },
      );
      return out.stdout.trim().endsWith("YES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("detects the colorized Running marker", () => {
    expect(
      detects(
        ["cargo build progress", COLORIZED, "dev bridge listening"].join("\n"),
      ),
    ).toBe(true);
  });

  it("still detects the uncolored marker", () => {
    expect(detects("Running `/tmp/target/debug/papercusp-desktop`")).toBe(true);
  });

  it("does not fire before the binary starts", () => {
    expect(
      detects(
        ["Compiling papercusp-desktop v0.0.15", "warning: unused"].join("\n"),
      ),
    ).toBe(false);
  });

  it("CONTROL: the original predicate cannot match the colorized marker", () => {
    // Proves the fixture is realistic rather than trivially passing — if this
    // ever matches, the fixture has lost its escape bytes and the guard above is
    // vacuous. This is the assertion that would have caught the regression.
    expect(/Running .*papercusp-desktop/.test(COLORIZED)).toBe(false);
  });

  it("does not reintroduce the literal-space regex in executable code", () => {
    // Scoped to non-comment lines on purpose: the script SHOULD keep quoting the
    // broken predicate in its explanatory comment (that is where the reason this
    // fix exists is recorded), and an unscoped check flags that documentation as
    // if it were the defect. Only an executable occurrence is the regression.
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(codeOnly).not.toMatch(/grep -qE "Running \.\*papercusp-desktop"/);
  });
});
