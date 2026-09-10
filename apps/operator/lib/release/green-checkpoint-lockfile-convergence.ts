/**
 * P-008 (green-gate-zero-wait-convergence-2026-09-08) — lockfile-drift auto-convergence on the
 * frozen lineage. Fixes EI-22752586902645795 (R-1, R-2, R-7).
 *
 * The exact-input dependency generation the gate materialises is keyed on LOCKFILE blobs only
 * (`dependency-generation.sh` `dependency_generation_input_manifest_ref`: package-lock.json /
 * npm-shrinkwrap.json outside node_modules and .papercusp, recursing through gitlinks). Under
 * `--ensure-ref <repairHead>` the script publishes from the LIVE integration tree, indexes the
 * generation under the live fingerprint, then re-opens by the REF's fingerprint — so a frozen
 * repairHead whose lockfiles differ from the live tree is a PERMANENT `dependency-prewarm-missing`
 * (exit 74): no run can ever judge it, and the queue parks as an inconclusive forever.
 *
 * The convergence is deliberately narrow. When the ONLY manifest delta between repairHead and the
 * live tree is lockfile blobs the live tree already holds AND those blobs equal the integration
 * ref's committed ones, admitting the integration ref's entries for exactly those paths onto
 * repairHead (whole-blob, through the ordinary ledgered admission door, actor=gate) makes
 * repairHead's fingerprint equal the live fingerprint — the live generation is then reusable with
 * no publish. Every other delta (a live lockfile that is uncommitted, a submodule whose pinned
 * lockfiles differ from its live tree) is reported as a typed, NAMED miss so the caller can log it
 * loudly instead of parking silently.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  admitPathsOntoRepairHead,
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionOutcome,
  type AdmissionRefusal,
  type AdmitPathsInput,
} from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  markFrozenRepairAdmitted,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

/** The ledger actor every P-008 admission is recorded under. */
export const LOCKFILE_CONVERGENCE_ACTOR = "gate";

/** Mirrors the shell manifest's name filter — only these participate in the input fingerprint. */
export const DEPENDENCY_INPUT_LOCKFILE_NAMES: readonly string[] = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

/** Mirrors `dependency_generation_input_manifest_ref`'s path filter exactly. */
export function isDependencyInputLockfilePath(rel: string): boolean {
  const segments = rel.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (!DEPENDENCY_INPUT_LOCKFILE_NAMES.includes(base)) return false;
  return !segments
    .slice(0, -1)
    .some((segment) => segment === ".papercusp" || segment === "node_modules");
}

/** Repo-relative path → blob sha; `null` records an ABSENT path (so a union walk can compare). */
export type LockfileBlobMap = ReadonlyMap<string, string | null>;

export interface LockfileManifestAtRef {
  /** Lockfile blobs at the ref, by repo-relative path. */
  blobs: Map<string, string>;
  /** Submodule gitlinks at the ref: path → pinned commit. */
  gitlinks: Map<string, string>;
}

/** Parse `git ls-tree -r -z <ref>` output into the lockfile manifest + gitlinks. */
export function parseLsTreeLockfileManifest(lsTreeZ: string): LockfileManifestAtRef {
  const blobs = new Map<string, string>();
  const gitlinks = new Map<string, string>();
  for (const record of lsTreeZ.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(/\s+/);
    const rel = record.slice(tab + 1);
    if (!mode || !type || !object || !rel) continue;
    if (type === "commit" && mode === "160000") {
      gitlinks.set(rel, object);
      continue;
    }
    if (type !== "blob" || !isDependencyInputLockfilePath(rel)) continue;
    blobs.set(rel, object);
  }
  return { blobs, gitlinks };
}

export function readLockfileManifestAtRef(
  root: string,
  ref: string,
  git: AdmissionGitRunner = realAdmissionGit,
): LockfileManifestAtRef {
  const r = git(["ls-tree", "-r", "-z", ref], { cwd: root });
  if (r.status !== 0) {
    throw new Error(
      `git ls-tree -r ${ref.slice(0, 12)} in ${root} failed (${r.status}): ${r.stderr.trim()}`,
    );
  }
  return parseLsTreeLockfileManifest(r.stdout);
}

/** Blob shas of the LIVE working-tree files for `paths` (`null` where the file is absent). */
export function readLiveLockfileBlobs(
  root: string,
  paths: Iterable<string>,
  git: AdmissionGitRunner = realAdmissionGit,
  exists: (abs: string) => boolean = existsSync,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const rel of paths) {
    if (!exists(path.join(root, rel))) {
      out.set(rel, null);
      continue;
    }
    const r = git(["hash-object", "--", rel], { cwd: root });
    if (r.status !== 0) {
      throw new Error(
        `git hash-object ${rel} in ${root} failed (${r.status}): ${r.stderr.trim()}`,
      );
    }
    out.set(rel, r.stdout.trim());
  }
  return out;
}

export type LockfileDriftReason =
  /** A drifting path's LIVE blob is not the integration ref's committed blob — admitting the
   *  ref's entry would not reproduce the live fingerprint (an uncommitted lockfile edit). */
  | "live-diverges-from-integration-ref"
  /** A submodule pinned by repairHead has lockfiles that differ from its live working tree; a
   *  gitlink bump is not a whole-blob lockfile admission and stays a typed miss. */
  | "submodule-lockfile-drift";

export type LockfileDriftDecision =
  | { kind: "no-drift" }
  | { kind: "convergeable"; paths: string[] }
  | { kind: "not-convergeable"; reason: LockfileDriftReason; paths: string[] };

/**
 * Pure classification. `repairHead` / `integrationRef` are the committed lockfile blobs at each
 * ref; `live` is the working tree's; `submoduleLockfileDrift` names submodules whose pinned
 * lockfiles differ from their live trees (computed by the caller — see `convergeLockfileDrift`).
 */
export function classifyLockfileDrift(input: {
  repairHead: LockfileBlobMap;
  integrationRef: LockfileBlobMap;
  live: LockfileBlobMap;
  submoduleLockfileDrift?: readonly string[];
}): LockfileDriftDecision {
  if (input.submoduleLockfileDrift && input.submoduleLockfileDrift.length > 0) {
    return {
      kind: "not-convergeable",
      reason: "submodule-lockfile-drift",
      paths: [...input.submoduleLockfileDrift].sort(),
    };
  }
  const union = new Set<string>([
    ...input.repairHead.keys(),
    ...input.integrationRef.keys(),
    ...input.live.keys(),
  ]);
  const delta: string[] = [];
  const diverging: string[] = [];
  for (const rel of [...union].sort()) {
    const head = input.repairHead.get(rel) ?? null;
    const live = input.live.get(rel) ?? null;
    if (head === live) continue;
    delta.push(rel);
    if (live !== (input.integrationRef.get(rel) ?? null)) diverging.push(rel);
  }
  if (delta.length === 0) return { kind: "no-drift" };
  if (diverging.length > 0) {
    return {
      kind: "not-convergeable",
      reason: "live-diverges-from-integration-ref",
      paths: diverging,
    };
  }
  return { kind: "convergeable", paths: delta };
}

export type LockfileConvergenceOutcome =
  | { kind: "no-drift" }
  | {
      kind: "converged";
      entry: FrozenRepairAdmission;
      fromRepairHead: string;
      toRepairHead: string;
      paths: string[];
      reason: string;
    }
  | { kind: "not-convergeable"; reason: LockfileDriftReason; paths: string[]; detail: string }
  | { kind: "admission-refused"; refusal: AdmissionRefusal; paths: string[] }
  /** The probe itself failed (git plumbing) — nothing was decided; the caller keeps the typed miss. */
  | { kind: "probe-failed"; detail: string };

export interface LockfileConvergenceInput {
  /** Superproject root holding the frozen lineage and the integration ref. */
  root: string;
  queue: Pick<FrozenCandidateRepairQueue, "candidate" | "repairHead">;
  /** The live integration ref (normally `cfg.integrationBranch`, i.e. `staging`). */
  integrationRef: string;
  nowMs: number;
  git?: AdmissionGitRunner;
  exists?: (abs: string) => boolean;
  /** Seam for tests; defaults to the real ledgered admission door. */
  admit?: (input: AdmitPathsInput) => AdmissionOutcome;
}

function buildAdmissionReason(paths: string[], from: string, integrationRef: string): string {
  return (
    `P-008 lockfile-drift auto-convergence: ${paths.length} lockfile(s) at repairHead ` +
    `${from.slice(0, 12)} differ from the live integration tree only by blobs equal to ` +
    `${integrationRef}'s committed ones (${paths.join(", ")}); admitted whole-blob so the exact-input ` +
    `dependency fingerprint matches the live generation instead of missing with exit 74`
  );
}

/**
 * Detect lockfile drift between `queue.repairHead` and the live tree and, when it is exactly the
 * convergeable shape, admit the integration ref's blobs for those paths onto repairHead under
 * actor=gate. Never throws for a plumbing failure — that is `probe-failed`.
 */
export function convergeLockfileDrift(input: LockfileConvergenceInput): LockfileConvergenceOutcome {
  const git = input.git ?? realAdmissionGit;
  const exists = input.exists ?? existsSync;
  const admit = input.admit ?? admitPathsOntoRepairHead;
  let decision: LockfileDriftDecision;
  try {
    const head = readLockfileManifestAtRef(input.root, input.queue.repairHead, git);
    const integration = readLockfileManifestAtRef(input.root, input.integrationRef, git);
    const live = readLiveLockfileBlobs(
      input.root,
      new Set([...head.blobs.keys(), ...integration.blobs.keys()]),
      git,
      exists,
    );
    const submoduleLockfileDrift: string[] = [];
    for (const [sub, pin] of head.gitlinks) {
      if (integration.gitlinks.get(sub) === pin) continue;
      const subRoot = path.join(input.root, sub);
      if (!exists(subRoot)) {
        submoduleLockfileDrift.push(sub);
        continue;
      }
      const pinned = readLockfileManifestAtRef(subRoot, pin, git);
      const subLive = readLiveLockfileBlobs(subRoot, pinned.blobs.keys(), git, exists);
      for (const [rel, sha] of pinned.blobs) {
        if (subLive.get(rel) !== sha) {
          submoduleLockfileDrift.push(sub);
          break;
        }
      }
    }
    decision = classifyLockfileDrift({
      repairHead: head.blobs,
      integrationRef: integration.blobs,
      live,
      submoduleLockfileDrift,
    });
  } catch (error) {
    return {
      kind: "probe-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (decision.kind === "no-drift") return { kind: "no-drift" };
  if (decision.kind === "not-convergeable") {
    return {
      kind: "not-convergeable",
      reason: decision.reason,
      paths: decision.paths,
      detail:
        decision.reason === "live-diverges-from-integration-ref"
          ? `live lockfile(s) are not ${input.integrationRef}'s committed blobs: ${decision.paths.join(", ")}`
          : `submodule(s) pinned by repairHead ${input.queue.repairHead.slice(0, 12)} carry lockfiles that differ from their live trees: ${decision.paths.join(", ")}`,
    };
  }
  const reason = buildAdmissionReason(decision.paths, input.queue.repairHead, input.integrationRef);
  const outcome = admit({
    root: input.root,
    candidate: input.queue.candidate,
    repairHead: input.queue.repairHead,
    paths: decision.paths,
    source: { ref: input.integrationRef },
    actor: LOCKFILE_CONVERGENCE_ACTOR,
    reason,
    nowMs: input.nowMs,
    git,
  });
  if (!outcome.ok) return { kind: "admission-refused", refusal: outcome, paths: decision.paths };
  return {
    kind: "converged",
    entry: outcome.entry,
    fromRepairHead: input.queue.repairHead,
    toRepairHead: outcome.commit,
    paths: decision.paths,
    reason,
  };
}

/** Fold a `converged` outcome into the queue row (advances repairHead; P-001 retest marker set). */
export function applyLockfileConvergence(
  queue: FrozenCandidateRepairQueue,
  outcome: Extract<LockfileConvergenceOutcome, { kind: "converged" }>,
): FrozenCandidateRepairQueue {
  return markFrozenRepairAdmitted(queue, outcome.entry);
}

/** One log line per outcome; the not-convergeable/refused shapes are LOUD by design (R-7). */
export function describeLockfileConvergence(outcome: LockfileConvergenceOutcome): string {
  switch (outcome.kind) {
    case "no-drift":
      return "no lockfile drift against the live integration tree";
    case "converged":
      return (
        `CONVERGED: admitted ${outcome.paths.length} lockfile(s) whole-blob onto ` +
        `${outcome.fromRepairHead.slice(0, 8)} → ${outcome.toRepairHead.slice(0, 8)} (actor=${LOCKFILE_CONVERGENCE_ACTOR}): ${outcome.paths.join(", ")}`
      );
    case "not-convergeable":
      return `⚠ LOCKFILE_DRIFT_NOT_CONVERGEABLE reason=${outcome.reason} — ${outcome.detail}; the repair head stays a typed dependency-prewarm miss until a fixer admits the dependency change`;
    case "admission-refused":
      return `⚠ LOCKFILE_DRIFT_ADMISSION_REFUSED code=${outcome.refusal.code} paths=${outcome.paths.join(", ")} — ${outcome.refusal.detail}`;
    case "probe-failed":
      return `⚠ LOCKFILE_DRIFT_PROBE_FAILED — ${outcome.detail}; nothing decided`;
  }
}
