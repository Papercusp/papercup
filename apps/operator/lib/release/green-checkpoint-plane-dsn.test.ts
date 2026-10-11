/**
 * WI-10006055: every gate path that runs a LIVE-plane lint must hand it the gate's operator
 * DSN. The first fix forwarded the DSN only through the main post-suite call. Three other
 * paths ran the same lints without one — runPostSuiteAtRef (no options), runGateAtRef and
 * runRepairTickLegs (raw suite env) — so those lints resolved `$PAPERCUSP_HOME/embedded-pg.json`
 * (the installed Server sidecar, 522 agent_facts rows). Round 24 of frozen queue ad82b273
 * reported `lint:plane-integrity` red at 382606c4 (`agent_facts.enforcement 0/522`, plane
 * metrics "regressed"), while the same lints passed against the operator DB (221k+ rows).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_PLANE_LINT_SCRIPTS,
  NON_TEST_GATE_SCRIPTS,
  gateScriptEnv,
  runPostSuiteLegs,
  type CheckpointExec,
} from "./green-checkpoint";

const OPERATOR_DSN = "postgresql://op@localhost:5432/papercusp";

/** Pin the gate process's DSN keys so the default is measured, not inherited. */
function stubGateDsn(url: string | undefined): void {
  vi.stubEnv("HARNESS_ADMIN_DATABASE_URL", "");
  vi.stubEnv("HARNESS_DATABASE_URL", "");
  vi.stubEnv("DATABASE_URL", url ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("live-plane lints get the gate's operator DSN on every path (WI-10006055)", () => {
  it("classifies every script of the lint:plane-integrity re-run group as a live-plane lint", () => {
    const group = NON_TEST_GATE_SCRIPTS["lint:plane-integrity"];
    // Calibration: an empty group would make the containment check below vacuous.
    expect(group?.length ?? 0).toBeGreaterThan(0);
    for (const script of group ?? []) {
      expect(LIVE_PLANE_LINT_SCRIPTS.has(script), script).toBe(true);
    }
  });

  it("gateScriptEnv adds the DSN to a plane lint only, and defaults it from the gate process", () => {
    stubGateDsn(OPERATOR_DSN);
    const suiteEnv = { NODE_ENV: "test" };

    expect(gateScriptEnv("lint:plane-producers", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBe(
      OPERATOR_DSN,
    );
    expect(gateScriptEnv("lint:plane-ratchet", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBe(
      OPERATOR_DSN,
    );
    // A non-plane leg stays DSN-free: the candidate suite must not touch the operator DB.
    expect(gateScriptEnv("lint:tsc", suiteEnv)).toBe(suiteEnv);
    expect(gateScriptEnv("test:lane-stateful", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBeUndefined();
    // An explicit empty override opts out.
    expect(gateScriptEnv("lint:plane-producers", suiteEnv, {}).HARNESS_ADMIN_DATABASE_URL).toBeUndefined();
    // The suite env object is never mutated.
    expect(suiteEnv).toEqual({ NODE_ENV: "test" });
  });

  it("gateScriptEnv leaves a plane lint's resolution alone when the gate itself has no DSN", () => {
    stubGateDsn(undefined);
    expect(
      gateScriptEnv("lint:plane-producers", { NODE_ENV: "test" }).HARNESS_ADMIN_DATABASE_URL,
    ).toBeUndefined();
  });

  it("runPostSuiteLegs with no options (the runPostSuiteAtRef call) still hands plane lints the DSN", async () => {
    stubGateDsn(OPERATOR_DSN);
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-plane-dsn-default-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            ["lint:tsc", "lint:plane-producers", "lint:plane-ratchet"].map((script) => [
              script,
              `node ${script}.mjs`,
            ]),
          ),
        }),
      );
      const seen = new Map<string, string | undefined>();
      const exec: CheckpointExec = async (cmd, args, opts) => {
        const runIndex = args.indexOf("run");
        const id = cmd === "npm" && runIndex >= 0 ? args[runIndex + 1]! : cmd;
        seen.set(id, opts?.env?.HARNESS_ADMIN_DATABASE_URL);
        return { code: 0, stdout: "", stderr: "" };
      };

      await runPostSuiteLegs(dir, { NODE_ENV: "test" }, exec, "apps/operator");

      // Calibration: both kinds of leg actually ran, so the assertions below measure something.
      expect(seen.has("lint:plane-producers")).toBe(true);
      expect(seen.has("lint:tsc")).toBe(true);
      expect(seen.get("lint:plane-producers")).toBe(OPERATOR_DSN);
      expect(seen.get("lint:plane-ratchet")).toBe(OPERATOR_DSN);
      expect(seen.get("lint:tsc")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
