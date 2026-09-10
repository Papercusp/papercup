import { describe, expect, it } from "vitest";
import type {
  AdmissionGitRunner,
  AdmissionOutcome,
  AdmitPathsInput,
} from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  LOCKFILE_CONVERGENCE_ACTOR,
  classifyLockfileDrift,
  convergeLockfileDrift,
  describeLockfileConvergence,
  isDependencyInputLockfilePath,
  parseLsTreeLockfileManifest,
} from "./green-checkpoint-lockfile-convergence";

const HEAD = "a".repeat(40);
const CAND = "c".repeat(40);
const NEW_HEAD = "d".repeat(40);

function lsTree(entries: Array<[mode: string, type: string, object: string, rel: string]>): string {
  return entries.map(([m, t, o, r]) => `${m} ${t} ${o}\t${r}`).join("\0") + "\0";
}

/** A fake git that answers ls-tree per (cwd, ref) and hash-object per (cwd, path). */
function fakeGit(opts: {
  trees: Record<string, string>; // key `${cwd}|${ref}` → ls-tree -z output
  liveBlobs: Record<string, string>; // key `${cwd}|${rel}` → sha
}): AdmissionGitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((argv, o) => {
    calls.push([...argv]);
    if (argv[0] === "ls-tree") {
      const out = opts.trees[`${o.cwd}|${argv[3]}`];
      return out === undefined
        ? { status: 128, stdout: "", stderr: `fatal: not a tree object ${argv[3]}` }
        : { status: 0, stdout: out, stderr: "" };
    }
    if (argv[0] === "hash-object") {
      const sha = opts.liveBlobs[`${o.cwd}|${argv[2]}`];
      return sha === undefined
        ? { status: 128, stdout: "", stderr: "fatal: no such path" }
        : { status: 0, stdout: `${sha}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected git ${argv.join(" ")}` };
  }) as AdmissionGitRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe("isDependencyInputLockfilePath (mirrors dependency-generation.sh)", () => {
  it("accepts root and nested lockfiles, rejects everything else", () => {
    expect(isDependencyInputLockfilePath("package-lock.json")).toBe(true);
    expect(isDependencyInputLockfilePath("apps/operator/npm-shrinkwrap.json")).toBe(true);
    expect(isDependencyInputLockfilePath("package.json")).toBe(false);
    expect(isDependencyInputLockfilePath("node_modules/x/package-lock.json")).toBe(false);
    expect(isDependencyInputLockfilePath("apps/node_modules/x/package-lock.json")).toBe(false);
    expect(isDependencyInputLockfilePath(".papercusp/scratch/package-lock.json")).toBe(false);
    expect(isDependencyInputLockfilePath("libs/.papercusp/package-lock.json")).toBe(false);
  });
});

describe("parseLsTreeLockfileManifest", () => {
  it("keeps lockfile blobs and gitlinks, drops other blobs", () => {
    const parsed = parseLsTreeLockfileManifest(
      lsTree([
        ["100644", "blob", "1".repeat(40), "package-lock.json"],
        ["100644", "blob", "2".repeat(40), "package.json"],
        ["160000", "commit", "3".repeat(40), "libs/papercusp"],
        ["100644", "blob", "4".repeat(40), "apps/operator/package-lock.json"],
      ]),
    );
    expect([...parsed.blobs.entries()]).toEqual([
      ["package-lock.json", "1".repeat(40)],
      ["apps/operator/package-lock.json", "4".repeat(40)],
    ]);
    expect([...parsed.gitlinks.entries()]).toEqual([["libs/papercusp", "3".repeat(40)]]);
  });
});

describe("classifyLockfileDrift", () => {
  const m = (o: Record<string, string | null>) => new Map(Object.entries(o));
  it("no-drift when repairHead's lockfiles equal the live tree's", () => {
    expect(
      classifyLockfileDrift({
        repairHead: m({ "package-lock.json": "x" }),
        integrationRef: m({ "package-lock.json": "y" }),
        live: m({ "package-lock.json": "x" }),
      }),
    ).toEqual({ kind: "no-drift" });
  });
  it("convergeable when every drifting path's live blob is the integration ref's", () => {
    expect(
      classifyLockfileDrift({
        repairHead: m({ "package-lock.json": "x", "a/package-lock.json": "old" }),
        integrationRef: m({ "package-lock.json": "y", "a/package-lock.json": null }),
        live: m({ "package-lock.json": "y", "a/package-lock.json": null }),
      }),
    ).toEqual({ kind: "convergeable", paths: ["a/package-lock.json", "package-lock.json"] });
  });
  it("not-convergeable when a live lockfile is an uncommitted edit", () => {
    expect(
      classifyLockfileDrift({
        repairHead: m({ "package-lock.json": "x" }),
        integrationRef: m({ "package-lock.json": "y" }),
        live: m({ "package-lock.json": "dirty" }),
      }),
    ).toEqual({
      kind: "not-convergeable",
      reason: "live-diverges-from-integration-ref",
      paths: ["package-lock.json"],
    });
  });
  it("submodule lockfile drift is a typed miss even with no superproject delta", () => {
    expect(
      classifyLockfileDrift({
        repairHead: m({ "package-lock.json": "x" }),
        integrationRef: m({ "package-lock.json": "x" }),
        live: m({ "package-lock.json": "x" }),
        submoduleLockfileDrift: ["libs/papercusp"],
      }),
    ).toEqual({
      kind: "not-convergeable",
      reason: "submodule-lockfile-drift",
      paths: ["libs/papercusp"],
    });
  });
});

describe("convergeLockfileDrift", () => {
  const root = "/repo";
  const baseTrees = {
    [`${root}|${HEAD}`]: lsTree([
      ["100644", "blob", "old".padEnd(40, "0"), "package-lock.json"],
      ["160000", "commit", "s".repeat(40), "libs/papercusp"],
    ]),
    [`${root}|staging`]: lsTree([
      ["100644", "blob", "new".padEnd(40, "0"), "package-lock.json"],
      ["160000", "commit", "s".repeat(40), "libs/papercusp"],
    ]),
  };

  it("admits the integration ref's lockfile whole-blob under actor=gate and reports the new head", () => {
    const git = fakeGit({
      trees: baseTrees,
      liveBlobs: { [`${root}|package-lock.json`]: "new".padEnd(40, "0") },
    });
    const admitCalls: AdmitPathsInput[] = [];
    const admit = (input: AdmitPathsInput): AdmissionOutcome => {
      admitCalls.push(input);
      return {
        ok: true,
        commit: NEW_HEAD,
        tree: "t".repeat(40),
        diff: [...input.paths],
        unchanged: [],
        lineageRef: `refs/papercusp/frozen/${CAND}`,
        published: true,
        entry: {
          atMs: input.nowMs,
          actor: input.actor,
          fromRepairHead: input.repairHead,
          toRepairHead: NEW_HEAD,
          paths: [...input.paths],
        } as AdmissionOutcome extends { entry: infer E } ? E : never,
      } as AdmissionOutcome;
    };
    const outcome = convergeLockfileDrift({
      root,
      queue: { candidate: CAND, repairHead: HEAD },
      integrationRef: "staging",
      nowMs: 1_700_000_000_000,
      git,
      exists: () => true,
      admit,
    });
    expect(outcome.kind).toBe("converged");
    if (outcome.kind !== "converged") throw new Error("unreachable");
    expect(outcome.toRepairHead).toBe(NEW_HEAD);
    expect(outcome.paths).toEqual(["package-lock.json"]);
    expect(admitCalls).toHaveLength(1);
    expect(admitCalls[0]).toMatchObject({
      root,
      candidate: CAND,
      repairHead: HEAD,
      paths: ["package-lock.json"],
      source: { ref: "staging" },
      actor: LOCKFILE_CONVERGENCE_ACTOR,
    });
    expect(admitCalls[0]?.reason).toContain("P-008 lockfile-drift auto-convergence");
    expect(describeLockfileConvergence(outcome)).toContain("CONVERGED");
  });

  it("refuses to admit when the live lockfile is not the integration ref's blob", () => {
    const git = fakeGit({
      trees: baseTrees,
      liveBlobs: { [`${root}|package-lock.json`]: "dirty".padEnd(40, "0") },
    });
    let admitted = 0;
    const outcome = convergeLockfileDrift({
      root,
      queue: { candidate: CAND, repairHead: HEAD },
      integrationRef: "staging",
      nowMs: 1,
      git,
      exists: () => true,
      admit: () => {
        admitted += 1;
        throw new Error("must not admit");
      },
    });
    expect(admitted).toBe(0);
    expect(outcome).toMatchObject({
      kind: "not-convergeable",
      reason: "live-diverges-from-integration-ref",
      paths: ["package-lock.json"],
    });
    expect(describeLockfileConvergence(outcome)).toContain("LOCKFILE_DRIFT_NOT_CONVERGEABLE");
  });

  it("a submodule whose pinned lockfiles differ from its live tree is a typed miss, not an admission", () => {
    const subPin = "p".repeat(40);
    const git = fakeGit({
      trees: {
        [`${root}|${HEAD}`]: lsTree([
          ["100644", "blob", "x".repeat(40), "package-lock.json"],
          ["160000", "commit", subPin, "libs/papercusp"],
        ]),
        [`${root}|staging`]: lsTree([
          ["100644", "blob", "x".repeat(40), "package-lock.json"],
          ["160000", "commit", "q".repeat(40), "libs/papercusp"],
        ]),
        [`${root}/libs/papercusp|${subPin}`]: lsTree([
          ["100644", "blob", "pinned".padEnd(40, "0"), "package-lock.json"],
        ]),
      },
      liveBlobs: {
        [`${root}|package-lock.json`]: "x".repeat(40),
        [`${root}/libs/papercusp|package-lock.json`]: "live".padEnd(40, "0"),
      },
    });
    const outcome = convergeLockfileDrift({
      root,
      queue: { candidate: CAND, repairHead: HEAD },
      integrationRef: "staging",
      nowMs: 1,
      git,
      exists: () => true,
      admit: () => {
        throw new Error("must not admit");
      },
    });
    expect(outcome).toMatchObject({
      kind: "not-convergeable",
      reason: "submodule-lockfile-drift",
      paths: ["libs/papercusp"],
    });
  });

  it("a plumbing failure is probe-failed, never a throw or an admission", () => {
    const git = fakeGit({ trees: {}, liveBlobs: {} });
    const outcome = convergeLockfileDrift({
      root,
      queue: { candidate: CAND, repairHead: HEAD },
      integrationRef: "staging",
      nowMs: 1,
      git,
      exists: () => true,
      admit: () => {
        throw new Error("must not admit");
      },
    });
    expect(outcome.kind).toBe("probe-failed");
  });
});
