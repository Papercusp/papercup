/**
 * P-005 / D-008 / D-009 — the gate split's WIRING SEAM, which nothing else covers.
 *
 * WHY THIS FILE EXISTS. `gate-hygiene-split.test.ts` proves `decidePromotion` in isolation:
 * given a failure list, does it classify correctly. That is the DECISION half. It cannot
 * prove the half that actually decides whether `main` moves — the four-axis guard on the
 * condition in green-checkpoint.ts, which chooses what to hand `decidePromotion` and when
 * to skip it entirely:
 *
 *     const hygieneSplit =
 *       green === false && !infraFault && (failingTests?.length ?? 0) > 0 && deps.readRootScripts
 *         ? decidePromotion({ ... })
 *         : null;
 *     if (!green && !hygieneSplit?.promote) { ...the red block, which ends in a return... }
 *
 * D-009 records that three of those four axes were added as a CORRECTION to an earlier
 * wiring plan that would have promoted candidates nobody measured, and that they were
 * "found by reading the code rather than the plan". Reading is how they were found; it is
 * not evidence that they hold. Before this file, `readRootScripts` had no producer anywhere
 * in the tree — not in production and NOT IN ANY TEST (measured 2026-08-29: six occurrences
 * of the identifier across apps/packages/libs/scripts/bin, all six inside green-checkpoint.ts,
 * none an assignment). So the branch that skips a 900-line red block had never once been
 * entered under test, in either direction.
 *
 * That gap matters most at exactly the moment D-036 sequences: activation is an ATTENDED
 * cutover with a named rollback, and the thing being cut over is the rule that decides
 * whether a red holds `main`. The axes below are what makes that rollback unnecessary.
 *
 * WHAT THIS FILE DOES NOT DO. It supplies `readRootScripts` to a STUB dep inside a temp
 * repo. It does not wire a producer into `realCheckpointDeps`, so it does not activate
 * anything: production behaviour after this file is byte-for-byte what it was before, and
 * `hygieneSplit` remains `null` on every real run. Activation stays where D-036 put it.
 *
 * FALSIFIABILITY. The first two cases are POSITIVE CONTROLS and they are load-bearing: a
 * hygiene-only red must actually promote. Without them every "does not promote" assertion
 * below would also pass against a build where the split is dead code — which is precisely
 * the state of the tree today, and precisely the false green this file exists to rule out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGreenCheckpoint,
  type CheckpointDeps,
  type InfraFaultClassification,
} from "./green-checkpoint";
import { git, revParse, advanceReady } from "./git-ops";
import { releaseConfig } from "./release-config";

let repo: string;

async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-verify", "-q", "-m", msg]);
  return revParse(repo, "HEAD");
}

/**
 * A synthetic root-scripts map, NOT the real package.json. The classifier's contract is a
 * pure function of this map, so a synthetic one keeps the test from re-failing every time
 * someone adds or renames a script — and it lets the fixture carry one of each class:
 *
 *   lint:tool-prompts    EXPLICIT hygiene (EXPLICIT_HYGIENE_GATE_SCRIPTS)
 *   gen:contract:check   DERIVED hygiene — qualifies only because `gen:contract` is present
 *   gen:orphan:check     NOT hygiene — no generator behind it, so the pair evidence is absent
 *   test:affected        product — a real script, but not a registered or derivable check
 */
const ROOT_SCRIPTS: Record<string, string> = {
  "lint:tool-prompts": "node scripts/lint-tool-prompts.mjs",
  "gen:contract": "node scripts/gen-contract.mjs",
  "gen:contract:check": "node scripts/gen-contract.mjs --check",
  "gen:orphan:check": "node scripts/gen-orphan.mjs --check",
  "test:affected": "node scripts/affected-tests.mjs",
};

function stubDeps(opts: {
  green: boolean;
  failingTests?: string[];
  infraFault?: InfraFaultClassification;
  /** Omit to reproduce production exactly: no producer ⇒ no split ⇒ every red holds. */
  rootScripts?: Record<string, string>;
}): { deps: CheckpointDeps; calls: string[]; logs: string[] } {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async () => {
      calls.push("setup");
    },
    runGreen: async () => {
      calls.push("runGreen");
      return {
        green: opts.green,
        summary: opts.green ? "all pass" : "failed",
        failingTests: opts.failingTests,
        ...(opts.infraFault ? { infraFault: opts.infraFault } : {}),
      };
    },
    advance: (candidate) => {
      calls.push("advance");
      return advanceReady(repo, candidate, "ready");
    },
    push: async () => {
      calls.push("push");
    },
    broadcast: async () => {
      calls.push("broadcast");
    },
    escalate: async () => {
      calls.push("escalate");
    },
    clearEscalation: async () => {
      calls.push("clearEscalation");
    },
    emitEvent: async () => {},
    log: (line: string) => {
      logs.push(line);
    },
  };
  if (opts.rootScripts) deps.readRootScripts = () => opts.rootScripts!;
  return { deps, calls, logs };
}

const cfg = () =>
  releaseConfig({
    integrationRoot: repo,
    releaseRoot: repo,
    checkpointRoot: repo,
    releaseRef: "ready",
    integrationBranch: "main",
    checkpointLogDir: join(repo, ".checkpoint-logs"),
  });

const VITE_NODE_FAULT: InfraFaultClassification = {
  kind: "vite-node-cache-vanished",
  occurrences: 12,
  roots: ["/tmp/vite-node-cache"],
  note: "vite-node module cache vanished mid-suite",
};

/** Did `main` actually move? The only question this file is really asking. */
const promoted = (calls: readonly string[]): boolean => calls.includes("advance");

async function runRed(opts: Parameters<typeof stubDeps>[0]) {
  const ready = await commit("a", "1", "ready");
  await git(repo, ["branch", "ready", ready]);
  await commit("b", "2", "candidate");
  const { deps, calls, logs } = stubDeps(opts);
  const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
  return { result, calls, logs };
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  repo = mkdtempSync(join(tmpdir(), "hygiene-wiring-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@e.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe("P-005 wiring — POSITIVE CONTROLS (every negative below is vacuous without these)", () => {
  it("CALIBRATION: an ordinary green advances, so `advance` is a live signal in this harness", async () => {
    const { calls } = await runRed({ green: true });
    expect(
      promoted(calls),
      "instrument check failed: a plain green did not advance, so no assertion in this file " +
        `can distinguish 'held by the split' from 'never got there'. calls=${JSON.stringify(calls)}`,
    ).toBe(true);
  });

  it("an EXPLICIT hygiene check failing alone promotes — the split is reached and acts", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(
      promoted(calls),
      "a red whose only failure is a registered hygiene check did NOT promote. Either the " +
        "condition never reached decidePromotion, or the split is inert — and if it is inert, " +
        "every 'does not promote' case in this file is passing for the wrong reason.",
    ).toBe(true);
  });

  it("a DERIVED gen:X:check failing alone promotes — the pair derivation reaches the seam", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["gen:contract:check"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(promoted(calls)).toBe(true);
  });

  it("TWO hygiene entries together promote — the paired control for the infraFault axis below", async () => {
    // Every negative in this file is designed as a SINGLE-VARIABLE differential against a
    // passing control: same failing list, one thing changed, opposite outcome. That is what
    // makes each negative non-vacuous without mutating production code to prove it. The
    // infraFault case uses this exact two-entry list, so this control is what licenses
    // reading its red as "infraFault blocked it" rather than "two entries never promoted".
    const { calls } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts", "gen:contract:check"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(promoted(calls)).toBe(true);
  });

  it("a hygiene-promoted advance is never renderable as a clean green", async () => {
    const { result, logs } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts"],
      rootScripts: ROOT_SCRIPTS,
    });
    // The debt survives onto the verdict: a consumer reading `green` alone would see a
    // promotion with no trace of the failure that was waved past.
    expect(result.hygieneDebt?.length ?? 0).toBeGreaterThan(0);
    expect(result.hygieneDebt?.[0]?.entry).toBe("lint:tool-prompts");
    expect(
      logs.some((l) => l.includes("NOT a clean green")),
      `the loud disclosure line is missing; logs=${JSON.stringify(logs)}`,
    ).toBe(true);
  });
});

describe("P-005 wiring — the four fail-closed axes (D-009)", () => {
  it("AXIS readRootScripts: absent ⇒ today's behaviour exactly, a hygiene-only red still holds", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts"],
      // no rootScripts — this is production as it stands today
    });
    expect(
      promoted(calls),
      "with no producer the split must not exist at all. A promotion here would mean the " +
        "gate's promotion rule already changed for every co-hosted install, unannounced.",
    ).toBe(false);
  });

  it("AXIS !infraFault: a host fault never converts an ABORT into a promotion", async () => {
    // EI-20767792192323374: on a host fault the failing list is INNOCENT files (measured
    // 4,789 of 5,505). Here every named entry is hygiene, so a split that ignored infraFault
    // would classify a meaningless list as all-clear and promote.
    const { calls } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts", "gen:contract:check"],
      infraFault: VITE_NODE_FAULT,
      rootScripts: ROOT_SCRIPTS,
    });
    expect(
      promoted(calls),
      "an infra-fault run promoted. The arm that renders `green: null` lives INSIDE the red " +
        "block, so skipping the block turns a deliberate abort into a promotion — the exact " +
        "regression D-009's second guard was added to prevent.",
    ).toBe(false);
  });

  it("AXIS failingTests.length > 0: an EMPTY failure list is 'died with the process', not 'nothing failed'", async () => {
    // buildSelfWatchdogCheckpointResult renders a red with failingTests: []. decidePromotion
    // reads an empty list as "a verdict was rendered and nothing failed" and returns
    // promote:true — vacuously. The length guard is the only thing standing between that
    // reading and a promotion nobody measured.
    const { calls } = await runRed({
      green: false,
      failingTests: [],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(promoted(calls)).toBe(false);
  });

  it("AXIS product failure: one unclassifiable entry beside any amount of hygiene still holds", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["lint:tool-prompts", "gen:contract:check", "test:affected"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(
      promoted(calls),
      "a product failure was promoted past because hygiene outnumbered it. Promotion requires " +
        "EVERY failure to be hygiene, never a majority.",
    ).toBe(false);
  });
});

describe("P-005 wiring — unknown entries fail CLOSED at the seam, not just in the classifier", () => {
  it("a test FILE path is product, so it holds even when it looks like a check", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["lib/broken.test.ts"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(promoted(calls)).toBe(false);
  });

  it("a gen:X:check with NO generator behind it is not a freshness check and holds", async () => {
    // The pair IS the evidence. `gen:orphan:check` is in ROOT_SCRIPTS; `gen:orphan` is not.
    // Naming alone must never buy hygiene status, or the class becomes self-declared.
    const { calls } = await runRed({
      green: false,
      failingTests: ["gen:orphan:check"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(
      promoted(calls),
      "a checker with no generator was treated as hygiene — the hygiene class would then be " +
        "claimable by naming convention alone.",
    ).toBe(false);
  });

  it("a bare workspace name names a whole suite, not a check, and holds", async () => {
    const { calls } = await runRed({
      green: false,
      failingTests: ["@papercusp/web"],
      rootScripts: ROOT_SCRIPTS,
    });
    expect(promoted(calls)).toBe(false);
  });
});
