/**
 * (EI-20493378309289396) PACKAGED-TOPOLOGY regression test for the gateway
 * sidecar's parent-death watch.
 *
 * WHY THIS FILE EXISTS AT ALL — both halves of this bug were already covered,
 * and the bug still shipped:
 *
 *   • `sidecar-spawn-shared.test.ts` proves the spawn PLAN declares the
 *     spawner's pid.
 *   • `serve.test.ts` proves the WATCH fires/doesn't fire for given pids.
 *
 * Neither crosses the seam between them, and the seam is where the defect
 * lived: the plan's env is what the watch later reads. `sidecar-spawn-shared`
 * cannot import serve.ts (apps/operator -> packages/operator-core is the only
 * legal direction), so it RESTATES the orphan rule in a local helper — a
 * hand-copy that stays green if `isOrphanedFromParent` or
 * `resolveExpectedParentPid` ever changes underneath it. This file is the
 * other direction: apps/operator MAY import operator-core, so both real
 * implementations are composed here and nothing is restated.
 *
 * It is also the only test that drives the watch through its ENV path. Every
 * case in serve.test.ts passes `expectedPpid` explicitly, so the
 * `resolveExpectedParentPid()` call inside `startParentDeathWatch` — the exact
 * line that consumes what the spawn plan wrote — is otherwise never executed
 * under test.
 *
 * THE TOPOLOGY (measured on a fresh 0.0.16 deb in a pristine Ubuntu 24.04 VM):
 *
 *     desktop (4500)
 *        └── primary operator (5674)          <- inherits PARENT_PID=4500
 *              └── gateway sidecar child      <- real ppid is 5674, NOT 4500
 *
 * The desktop is perfectly ALIVE throughout. The child nonetheless compared an
 * inherited 4500 against its real ppid 5674, concluded it had been orphaned,
 * and SIGTERMed itself before the watch even armed — 5 respawn attempts, then
 * re-arm and repeat, forever (1,134 "is gone" lines in 3h10m on the macOS rig;
 * :8788 never bound, so agents silently fell back to direct credential paths).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSidecarSpawnPlan } from "@papercusp/operator-core/lib/process-supervision/sidecar-spawn-shared";

let tmpHome: string;
let origHome: string | undefined;
let origPapercuspHome: string | undefined;
let serve: typeof import("./serve");

beforeAll(async () => {
  // serve.ts derives its path constants from homedir() at module load; point
  // HOME at a temp dir before importing so nothing binds to real ~/.papercusp.
  origHome = process.env.HOME;
  origPapercuspHome = process.env.PAPERCUSP_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "packaged-topology-test-"));
  process.env.HOME = tmpHome;
  delete process.env.PAPERCUSP_HOME;
  serve = await import("./serve");
});

afterAll(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origPapercuspHome !== undefined)
    process.env.PAPERCUSP_HOME = origPapercuspHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** The desktop that main.rs launched, and that stays ALIVE the whole time. */
const DESKTOP_PID = 4500;
/** The primary operator the desktop spawned — the gateway child's REAL parent. */
const OPERATOR_PID = 5674;

/**
 * The operator process's own env, as main.rs's `spawn_serve` leaves it. This is
 * what a spawned child inherits when the spawn plan does not override it.
 */
const operatorEnv = (): Record<string, string> => ({
  PAPERCUSP_DESKTOP: "1",
  PAPERCUSP_DESKTOP_PARENT_PID: String(DESKTOP_PID),
});

/**
 * The packaged gateway spawn plan, from the REAL resolver. Paths mirror the
 * shipped macOS bundle (`bundled-reexec` mode — the packaged branch).
 */
const packagedGatewayPlanEnv = (): Record<string, string> =>
  resolveSidecarSpawnPlan({
    selfPath:
      "/Applications/Papercusp Server.app/Contents/Resources/sidecar/serve.mjs",
    devScriptPath: "/repo/packages/operator-core/lib/inference-gateway/bin.ts",
    bundledModeEnvVar: "PAPERCUSP_GATEWAY_SIDECAR_MODE",
    execPath:
      "/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/node",
    spawnerPid: OPERATOR_PID,
  }).env;

/**
 * PERMANENT WRONG-IMPLEMENTATION CONTROL — the pre-fix plan env. The old
 * resolver set only the divert var and left the parent declaration to be
 * inherited. Every assertion about the fixed path must FAIL against this, or
 * the test is satisfied by the broken implementation and guards nothing.
 */
const preFixPlanEnv = (): Record<string, string> => ({
  PAPERCUSP_GATEWAY_SIDECAR_MODE: "1",
});

/** The child's effective env, exactly as every spawner builds it. */
const childEnv = (planEnv: Record<string, string>): Record<string, string> => ({
  ...operatorEnv(),
  ...planEnv,
});

/**
 * Boot the child under `planEnv` and report whether its parent-death watch
 * self-terminates it. Runs the REAL `startParentDeathWatch`, reading the pid
 * out of the REAL `resolveExpectedParentPid` via process.env — no
 * `expectedPpid` override, because the env read is the thing under test.
 *
 * `ppid` defaults to the child's true parent in this topology (the operator),
 * and `alivePids` says which processes are actually running.
 */
const childSelfTerminatesAtBoot = (
  planEnv: Record<string, string>,
  opts: { ppid?: number; alivePids?: number[] } = {},
): boolean => {
  const ppid = opts.ppid ?? OPERATOR_PID;
  const alivePids = opts.alivePids ?? [DESKTOP_PID, OPERATOR_PID];
  const env = childEnv(planEnv);

  const restore = { ...process.env };
  // Fake timers so a watch that does NOT fire immediately leaves no live 5s
  // interval behind; we only assert the pre-arm/immediate verdict here.
  vi.useFakeTimers();
  try {
    Object.assign(process.env, env);
    let fired = 0;
    serve.startParentDeathWatch(() => void fired++, {
      currentPpid: () => ppid,
      parentAlive: (pid: number) => alivePids.includes(pid),
    });
    return fired > 0;
  } finally {
    vi.useRealTimers();
    for (const k of Object.keys(process.env))
      if (!(k in restore)) delete process.env[k];
    Object.assign(process.env, restore);
  }
};

describe("packaged gateway sidecar survives the desktop→operator→sidecar topology (EI-20493378309289396)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the spawn plan's parent declaration reaches the watch as the OPERATOR pid", () => {
    // The seam itself: what resolveSidecarSpawnPlan writes is what
    // resolveExpectedParentPid reads. Both real implementations, composed.
    const resolved = serve.resolveExpectedParentPid(
      childEnv(packagedGatewayPlanEnv()),
    );
    expect(resolved).toEqual({ pid: OPERATOR_PID, declaredByLauncher: true });

    // CONTROL: pre-fix, the watch resolved the DESKTOP pid instead — a process
    // that is alive and well but is not this child's parent.
    expect(serve.resolveExpectedParentPid(childEnv(preFixPlanEnv()))).toEqual({
      pid: DESKTOP_PID,
      declaredByLauncher: true,
    });
  });

  it("REGRESSION: the gateway child does NOT self-terminate at boot", () => {
    expect(childSelfTerminatesAtBoot(packagedGatewayPlanEnv())).toBe(false);

    // CONTROL: the pre-fix env kills the child on every boot — the respawn
    // storm that left :8788 unbound. Note the desktop is ALIVE in both arms;
    // this was never a dead-parent detection, it was a reparenting
    // false-positive.
    expect(childSelfTerminatesAtBoot(preFixPlanEnv())).toBe(true);
  });

  it("keeps the divert var — the parent declaration must not displace it", () => {
    // Without this the re-exec'd bundle boots as a full operator, not a gateway.
    expect(packagedGatewayPlanEnv().PAPERCUSP_GATEWAY_SIDECAR_MODE).toBe("1");
  });

  it("CALIBRATION: the watch still fires when the OPERATOR genuinely dies", () => {
    // The fix must not buy quiet by making the watch blind. Same fixed env,
    // same unchanged ppid — but the declared parent is gone. This is the case
    // only the launcher handoff can see, and it must survive the fix.
    expect(
      childSelfTerminatesAtBoot(packagedGatewayPlanEnv(), {
        alivePids: [DESKTOP_PID],
      }),
    ).toBe(true);
  });

  it("CALIBRATION: the watch still fires when the child is reparented away", () => {
    // Orphaned to init while the operator is gone — must self-terminate rather
    // than run on holding :8788 under stale env.
    expect(
      childSelfTerminatesAtBoot(packagedGatewayPlanEnv(), {
        ppid: 1,
        alivePids: [DESKTOP_PID],
      }),
    ).toBe(true);
  });

  it("the headless-rig opt-out still wins in the packaged topology", () => {
    // deb-hetzner-matrix / local-matrix run the packaged sidecar with
    // PAPERCUSP_DESKTOP=1 for parity but launch from a shell that exits right
    // after spawn. They opt out explicitly; the fix must not override that.
    const restore = process.env.PAPERCUSP_PARENT_DEATH_WATCH;
    process.env.PAPERCUSP_PARENT_DEATH_WATCH = "0";
    try {
      expect(
        childSelfTerminatesAtBoot(preFixPlanEnv(), { ppid: 1, alivePids: [] }),
      ).toBe(false);
    } finally {
      if (restore === undefined)
        delete process.env.PAPERCUSP_PARENT_DEATH_WATCH;
      else process.env.PAPERCUSP_PARENT_DEATH_WATCH = restore;
    }
  });

  it("dev (tsx) mode carries the same declaration — the bug is not packaged-only", () => {
    // A desktop `npm run dev` operator also inherits PAPERCUSP_DESKTOP_PARENT_PID,
    // so a dev plan that left env alone would reproduce this identically.
    const devEnv = resolveSidecarSpawnPlan({
      selfPath:
        "/repo/packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts",
      devScriptPath: "/repo/packages/operator-core/lib/inference-gateway/bin.ts",
      bundledModeEnvVar: "PAPERCUSP_GATEWAY_SIDECAR_MODE",
      execPath: "/usr/bin/node",
      spawnerPid: OPERATOR_PID,
    }).env;
    expect(serve.resolveExpectedParentPid(childEnv(devEnv))).toEqual({
      pid: OPERATOR_PID,
      declaredByLauncher: true,
    });
    expect(childSelfTerminatesAtBoot(devEnv)).toBe(false);
  });
});
