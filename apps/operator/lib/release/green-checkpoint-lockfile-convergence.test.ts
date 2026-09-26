import { describe, expect, it } from "vitest";
import type {
  AdmissionGitRunner,
  AdmissionOutcome,
  AdmitPathsInput,
} from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  LOCKFILE_CONVERGENCE_ACTOR,
  changedWorkspaceLockEntries,
  classifyLockfileDrift,
  convergeLockfileDrift,
  describeLockfileConvergence,
  isDependencyInputLockfilePath,
  manifestPathForLockEntry,
  parseLockPackages,
  parseLsTreeLockfileManifest,
} from "./green-checkpoint-lockfile-convergence";

const HEAD = "a".repeat(40);
const CAND = "c".repeat(40);
const NEW_HEAD = "d".repeat(40);

function lockText(packages: Record<string, unknown>): string {
  return JSON.stringify({ name: "root", lockfileVersion: 3, requires: true, packages }, null, 2);
}

function lsTree(entries: Array<[mode: string, type: string, object: string, rel: string]>): string {
  return entries.map(([m, t, o, r]) => `${m} ${t} ${o}\t${r}`).join("\0") + "\0";
}

/**
 * A fake git that answers `ls-tree -r` per (cwd, ref), path-scoped `ls-tree <ref> -- <rel>` per
 * (cwd, ref, rel), `cat-file blob` per sha, and hash-object per (cwd, path).
 */
function fakeGit(opts: {
  trees: Record<string, string>; // key `${cwd}|${ref}` → ls-tree -z output
  liveBlobs: Record<string, string>; // key `${cwd}|${rel}` → sha
  /** key `${cwd}|${ref}|${rel}` → `${mode} ${type} ${object}`; an unlisted path is ABSENT. */
  paths?: Record<string, string>;
  /** `${cwd}|${ref}` pairs a path-scoped ls-tree may resolve (besides `trees` keys). */
  refs?: string[];
  /** blob sha → content, for `cat-file blob`. */
  blobs?: Record<string, string>;
}): AdmissionGitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((argv, o) => {
    calls.push([...argv]);
    if (argv[0] === "ls-tree" && argv[3] === "--") {
      const ref = argv[2];
      const rel = argv[4];
      const known = `${o.cwd}|${ref}`;
      if (!(known in opts.trees) && !(opts.refs ?? []).includes(known)) {
        return { status: 128, stdout: "", stderr: `fatal: not a tree object ${ref}` };
      }
      const hit = opts.paths?.[`${o.cwd}|${ref}|${rel}`];
      return { status: 0, stdout: hit ? `${hit}\t${rel}\0` : "", stderr: "" };
    }
    if (argv[0] === "cat-file") {
      const text = opts.blobs?.[argv[2] ?? ""];
      return text === undefined
        ? { status: 128, stdout: "", stderr: `fatal: bad object ${argv[2]}` }
        : { status: 0, stdout: text, stderr: "" };
    }
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

describe("lock/manifest helpers (WI-10003229)", () => {
  it("changedWorkspaceLockEntries ignores installed entries and key order", () => {
    expect(
      changedWorkspaceLockEntries(
        {
          "": { name: "r", workspaces: ["a"] },
          a: { name: "a" },
          "node_modules/z": { version: "1" },
          "a/node_modules/q": { version: "1" },
          gone: { name: "gone" },
        },
        {
          "": { workspaces: ["a"], name: "r" },
          a: { name: "a", dependencies: { z: "*" } },
          "node_modules/z": { version: "2" },
          "a/node_modules/q": { version: "2" },
          added: { name: "added" },
        },
      ),
    ).toEqual(["a", "added", "gone"]);
  });
  it("manifestPathForLockEntry resolves relative to the lockfile's directory", () => {
    expect(manifestPathForLockEntry("package-lock.json", "")).toBe("package.json");
    expect(manifestPathForLockEntry("package-lock.json", "libs/x")).toBe("libs/x/package.json");
    expect(manifestPathForLockEntry("apps/a/package-lock.json", "")).toBe("apps/a/package.json");
    expect(manifestPathForLockEntry("apps/a/package-lock.json", "../b")).toBe("apps/b/package.json");
    expect(() => manifestPathForLockEntry("package-lock.json", "../outside")).toThrow(/outside/);
  });
  it("parseLockPackages tolerates an absent or v1 lock and rejects a malformed one", () => {
    expect(parseLockPackages(null)).toEqual({});
    expect(parseLockPackages(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toEqual({});
    expect(() => parseLockPackages("[]")).toThrow();
    expect(() => parseLockPackages(JSON.stringify({ packages: [] }))).toThrow();
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
    // A resolution-only lock change: workspace entries are identical, only an installed
    // (node_modules) entry moved — so no manifest can disagree and admission is consistent.
    const git = fakeGit({
      trees: baseTrees,
      liveBlobs: { [`${root}|package-lock.json`]: "new".padEnd(40, "0") },
      blobs: {
        ["old".padEnd(40, "0")]: lockText({ "": { name: "root" }, "node_modules/x": { version: "1.0.0" } }),
        ["new".padEnd(40, "0")]: lockText({ "": { name: "root" }, "node_modules/x": { version: "1.0.1" } }),
      },
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

  describe("WI-10003229: the lock must be a function of repairHead's manifests (through gitlinks)", () => {
    // The f6bf2977 shape: staging's lock adds a dependency to the `libs/papercusp-shared`
    // workspace entry; that manifest change lives behind a gitlink bump (OLD_PIN → NEW_PIN)
    // the frozen lineage never received. The submodule holds no lockfile of its own, so the
    // pre-existing submodule-lockfile-drift probe sees nothing.
    const SUB = "libs/papercusp-shared";
    const OLD_PIN = "1".repeat(40);
    const NEW_PIN = "2".repeat(40);
    const LOCK_OLD = "e".repeat(40);
    const LOCK_NEW = "f".repeat(40);
    const lockBlobs = {
      [LOCK_OLD]: lockText({
        "": { name: "root", workspaces: [SUB] },
        [SUB]: { name: "@papercusp/shared", version: "1.0.0" },
        "node_modules/@papercusp/shared": { resolved: SUB, link: true },
      }),
      [LOCK_NEW]: lockText({
        "": { workspaces: [SUB], name: "root" }, // key order differs: must NOT count as a change
        [SUB]: {
          name: "@papercusp/shared",
          version: "1.0.0",
          dependencies: { "@papercusp/module-singleton": "*" },
        },
        "node_modules/@papercusp/shared": { resolved: SUB, link: true },
        "node_modules/@papercusp/module-singleton": { resolved: "libs/module-singleton", link: true },
      }),
    };
    const trees = {
      [`${root}|${HEAD}`]: lsTree([
        ["100644", "blob", LOCK_OLD, "package-lock.json"],
        ["160000", "commit", OLD_PIN, SUB],
      ]),
      [`${root}|staging`]: lsTree([
        ["100644", "blob", LOCK_NEW, "package-lock.json"],
        ["160000", "commit", NEW_PIN, SUB],
      ]),
      // The submodule carries no lockfile — the hole the old probe could not see.
      [`${root}/${SUB}|${OLD_PIN}`]: lsTree([["100644", "blob", "9".repeat(40), "package.json"]]),
    };
    function subGit(manifestAtOld: string, manifestAtNew: string) {
      return fakeGit({
        trees,
        liveBlobs: { [`${root}|package-lock.json`]: LOCK_NEW },
        blobs: lockBlobs,
        refs: [`${root}/${SUB}|${NEW_PIN}`],
        paths: {
          [`${root}|${HEAD}|libs`]: `040000 tree ${"7".repeat(40)}`,
          [`${root}|${HEAD}|${SUB}`]: `160000 commit ${OLD_PIN}`,
          [`${root}|staging|libs`]: `040000 tree ${"8".repeat(40)}`,
          [`${root}|staging|${SUB}`]: `160000 commit ${NEW_PIN}`,
          [`${root}/${SUB}|${OLD_PIN}|package.json`]: `100644 blob ${manifestAtOld}`,
          [`${root}/${SUB}|${NEW_PIN}|package.json`]: `100644 blob ${manifestAtNew}`,
        },
      });
    }

    it("refuses (never admits) when the changed entry's manifest behind the gitlink differs", () => {
      let admitted = 0;
      const outcome = convergeLockfileDrift({
        root,
        queue: { candidate: CAND, repairHead: HEAD },
        integrationRef: "staging",
        nowMs: 1,
        git: subGit("a".repeat(40), "b".repeat(40)),
        exists: () => true,
        admit: () => {
          admitted += 1;
          throw new Error("must not admit");
        },
      });
      expect(admitted).toBe(0);
      expect(outcome).toMatchObject({
        kind: "not-convergeable",
        reason: "lockfile-manifest-diverges",
        paths: [`${SUB}/package.json`],
        manifestDivergence: [
          { lockfile: "package-lock.json", entry: SUB, manifest: `${SUB}/package.json`, gitlink: SUB },
        ],
      });
      const line = describeLockfileConvergence(outcome);
      expect(line).toContain("LOCKFILE_DRIFT_NOT_CONVERGEABLE reason=lockfile-manifest-diverges");
      expect(line).toContain(`behind gitlink ${SUB}`);
    });

    it("calibration: the same lock change converges when the manifest already matches", () => {
      const outcome = convergeLockfileDrift({
        root,
        queue: { candidate: CAND, repairHead: HEAD },
        integrationRef: "staging",
        nowMs: 1,
        git: subGit("b".repeat(40), "b".repeat(40)),
        exists: () => true,
        admit: (input) =>
          ({
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
            },
          }) as unknown as AdmissionOutcome,
      });
      expect(outcome).toMatchObject({ kind: "converged", paths: ["package-lock.json"] });
    });

    it("an unresolvable submodule pin is probe-failed (unverifiable), never an admission", () => {
      const git = fakeGit({
        trees,
        liveBlobs: { [`${root}|package-lock.json`]: LOCK_NEW },
        blobs: lockBlobs,
        // NEW_PIN is NOT resolvable inside the submodule's object store.
        paths: {
          [`${root}|${HEAD}|libs`]: `040000 tree ${"7".repeat(40)}`,
          [`${root}|${HEAD}|${SUB}`]: `160000 commit ${OLD_PIN}`,
          [`${root}|staging|libs`]: `040000 tree ${"8".repeat(40)}`,
          [`${root}|staging|${SUB}`]: `160000 commit ${NEW_PIN}`,
          [`${root}/${SUB}|${OLD_PIN}|package.json`]: `100644 blob ${"a".repeat(40)}`,
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
      expect(outcome.kind).toBe("probe-failed");
    });

    it("a superproject manifest that differs is refused too, with no gitlink named", () => {
      const git = fakeGit({
        trees: {
          [`${root}|${HEAD}`]: lsTree([["100644", "blob", LOCK_OLD, "package-lock.json"]]),
          [`${root}|staging`]: lsTree([["100644", "blob", LOCK_NEW, "package-lock.json"]]),
        },
        liveBlobs: { [`${root}|package-lock.json`]: LOCK_NEW },
        blobs: {
          [LOCK_OLD]: lockText({ "": { name: "root" }, "apps/x": { name: "x" } }),
          [LOCK_NEW]: lockText({ "": { name: "root" }, "apps/x": { name: "x", dependencies: { y: "1" } } }),
        },
        paths: {
          [`${root}|${HEAD}|apps/x/package.json`]: `100644 blob ${"a".repeat(40)}`,
          [`${root}|staging|apps/x/package.json`]: `100644 blob ${"b".repeat(40)}`,
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
        reason: "lockfile-manifest-diverges",
        paths: ["apps/x/package.json"],
        manifestDivergence: [{ entry: "apps/x", gitlink: null }],
      });
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
