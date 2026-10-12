/**
 * WI-10005223: the frozen-repair ADMISSION git work, as serializable jobs.
 *
 * The admission builders (repair-head-admission, hunk-exact-admission, the two preflights,
 * judged-sha-containment) are synchronous on purpose: every step is a `spawnSync('git')`,
 * and a sync sequence cannot interleave with a second admission. Run on the operator's MAIN
 * thread, that same property blocked the event loop for the whole sequence — measured avg
 * 4.3-12.4s per admit, max 61.8s, past the sentinel's 20s wedge-kill threshold.
 *
 * This module does not change a single builder. It names each call the admit door makes as
 * a plain-data job and dispatches it to the UNCHANGED sync function, so the same code runs
 * either on a worker thread (admission-offthread.ts, the production path) or inline. Every
 * job input and result is structured-cloneable: the only non-data inputs the builders take —
 * the `git` runner and the `preflight` closure — are never sent. The worker always uses the
 * real git runner, and the preflight is rebuilt here from its plain spec.
 */
import {
  admitPathsOntoRepairHead,
  realAdmissionGit,
  retractAdmission,
  type AdmissionGitResult,
  type AdmissionOutcome,
  type AdmitPathsInput,
} from './repair-head-admission';
import {
  buildCommittedPatchSource,
  buildHunkExactSource,
  type BuildHunkExactSourceInput,
  type HunkExactSourceOutcome,
} from './hunk-exact-admission';
import { containmentForPaths } from './judged-sha-containment';
import { importCompletenessPreflight, readAdmissionBlobBatch } from './admission-import-completeness';
import { resolve, relative, sep } from 'node:path';
import { precheckPopulation, isTestFilePath, type SignatureLike, type FixPrecheckPopulation } from './admission-fix-precheck';
import { buildIndex, isTestFile, selectRelatedTests } from '../../../../scripts/lib/related-tests.mjs';
import {
  chainAdmissionPreflights,
  lockfileManifestConsistencyPreflight,
} from './admission-lockfile-consistency';

/**
 * The admit door's preflight, as data. The door always chains the import-completeness check
 * and the lockfile/manifest consistency check against the same probe ref; only the ref and
 * the whole-blob cohort flag vary.
 */
export interface AdmissionPreflightSpec {
  probeRef: string;
  /** D-045: whole-blob admissions also close the same-source cohort. Omitted = forward check only. */
  enforceSourceCohort?: true;
}

type CommittedPatchInput = Omit<Parameters<typeof buildCommittedPatchSource>[0], 'git'>;
type RetractInput = Omit<Parameters<typeof retractAdmission>[0], 'git'>;

export interface ImmutablePrecheckInput {
  root: string;
  commit: string;
  signature: readonly SignatureLike[];
  admittedPaths: readonly string[];
}

/** Runs on the admission worker. Neither inventory nor blob reads consult the working tree. */
export function immutablePrecheckPopulation(input: ImmutablePrecheckInput):
  | { ok: true; population: FixPrecheckPopulation }
  | { ok: false; detail: string } {
  const root = resolve(input.root);
  const unavailable = (detail: string) => ({ ok: false as const, detail });
  type Entry = { mode: string; type: string; sha: string; file: string };
  const treeAt = (cwd: string, commit: string): Entry[] => {
    const tree = realAdmissionGit(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd });
    if (tree.status !== 0) throw new Error(`cannot read pinned tree ${cwd}@${commit}: ${tree.stderr.trim()}`);
    return tree.stdout.split('\0').filter(Boolean).map((row) => {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error(`malformed pinned tree in ${cwd}`);
      return { mode: match[1]!, type: match[2]!, sha: match[3]!, file: match[4]! };
    });
  };
  try {
    const top = treeAt(root, input.commit);
    const admitted = new Set(input.admittedPaths.map((file) => file.trim().replaceAll('\\', '/').replace(/^\.\//, '')));
    const gitlinks = top.filter((entry) => entry.type === 'commit' && admitted.has(entry.file));
    // Keep ordinary admissions' existing exact-file policy. Directory gitlinks are the gap.
    if (gitlinks.length === 0) return { ok: true, population: precheckPopulation(input) };
    const blobs = new Map<string, string | null>();
    const ownRoots = gitlinks.map((entry) => resolve(root, entry.file));
    const collect = (cwd: string, commit: string, entries: Entry[], depth: number): void => {
      if (depth > 8) throw new Error(`pinned submodule nesting exceeds inventory bound at ${cwd}`);
      const sources = entries.filter((entry) => entry.type === 'blob' && /\.[cm]?[jt]sx?$/.test(entry.file));
      const batch = readAdmissionBlobBatch(cwd, [...new Set(sources.filter((entry) => entry.mode !== '120000').map((entry) => entry.sha))]);
      if (!batch.ok) throw new Error(`${cwd}@${commit}: ${batch.detail}`);
      for (const entry of entries) {
        if (entry.type === 'blob') blobs.set(resolve(cwd, entry.file), entry.mode === '120000' ? null : batch.contents.get(entry.sha) ?? null);
        else if (entry.type === 'commit') {
          const child = resolve(cwd, entry.file);
          const identity = realAdmissionGit(['rev-parse', '--show-toplevel'], { cwd: child });
          if (identity.status !== 0 || resolve(identity.stdout.trim()) !== child)
            throw new Error(`pinned submodule object store unavailable: ${child}@${entry.sha}`);
          collect(child, entry.sha, treeAt(child, entry.sha), depth + 1);
        }
      }
    };
    collect(root, input.commit, top, 0);
    const sources = [...blobs.keys()].filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    const fs = { list: () => sources, read: (file: string) => blobs.get(file) ?? null, exists: (file: string) => blobs.has(file) };
    const index = buildIndex({ rootDir: root, fs });
    // A gitlink moves a directory. Expand it to immutable descendants for the existing selector.
    const changedPaths = [...blobs.keys()].filter((file) => ownRoots.some((own) => file.startsWith(own + sep)));
    const selected = selectRelatedTests({ rootDir: root, changedPaths, index, fs, judgedSha: input.commit });
    const related = selected.mode === 'full' ? sources.filter(isTestFile) : selected.selected;
    const tests = sources.filter((file) => isTestFilePath(file));
    const own = tests.filter((file) => ownRoots.some((own) => file.startsWith(own + sep)));
    const unmeasuredRoots = ownRoots.filter((ownRoot) => !own.some((file) => file.startsWith(ownRoot + sep)));
    if (unmeasuredRoots.length > 0) return unavailable(`admitted gitlink has no discoverable test files: ${unmeasuredRoots.join(', ')}; no test measurement can certify its paired dependencies`);
    // Router spellings absent from the selector's test regex cannot silently disappear.
    const affectedTestFiles = [...new Set([...related, ...own, ...tests.filter((file) => !isTestFile(file))])]
      .map((file) => relative(root, file).split(sep).join('/')).sort();
    return { ok: true, population: precheckPopulation({ ...input, affectedTestFiles }) };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export type AdmissionJob =
  | { kind: 'git'; argv: string[]; cwd: string }
  | { kind: 'precheck-population'; input: ImmutablePrecheckInput }
  | { kind: 'containment'; paths: string[]; judgedSha: string; root: string; branch: string }
  | { kind: 'committed-patch'; input: CommittedPatchInput }
  | { kind: 'hunk-exact'; input: Omit<BuildHunkExactSourceInput, 'git'> }
  | {
      kind: 'admit';
      input: Omit<AdmitPathsInput, 'git' | 'preflight'>;
      preflight: AdmissionPreflightSpec | null;
    }
  | { kind: 'retract'; input: RetractInput };

export interface AdmissionJobResults {
  git: AdmissionGitResult;
  'precheck-population': ReturnType<typeof immutablePrecheckPopulation>;
  containment: ReturnType<typeof containmentForPaths>;
  'committed-patch': ReturnType<typeof buildCommittedPatchSource>;
  'hunk-exact': HunkExactSourceOutcome;
  admit: AdmissionOutcome;
  retract: boolean;
}

export type AdmissionJobKind = AdmissionJob['kind'];
export type AdmissionJobOf<K extends AdmissionJobKind> = Extract<AdmissionJob, { kind: K }>;

/** Rebuild the admit door's preflight closure from its plain spec (on whichever thread runs the job). */
export function admissionPreflightFromSpec(
  root: string,
  spec: AdmissionPreflightSpec,
): NonNullable<AdmitPathsInput['preflight']> {
  return chainAdmissionPreflights(
    importCompletenessPreflight({
      root,
      probeRef: spec.probeRef,
      ...(spec.enforceSourceCohort ? { enforceSourceCohort: true } : {}),
    }),
    lockfileManifestConsistencyPreflight({ root, probeRef: spec.probeRef }),
  );
}

/** Run one job synchronously against the unchanged builders. Throws exactly what they throw. */
export function executeAdmissionJob<K extends AdmissionJobKind>(job: AdmissionJobOf<K>): AdmissionJobResults[K];
export function executeAdmissionJob(job: AdmissionJob): AdmissionJobResults[AdmissionJobKind] {
  switch (job.kind) {
    case 'git':
      return realAdmissionGit(job.argv, { cwd: job.cwd });
    case 'precheck-population':
      return immutablePrecheckPopulation(job.input);
    case 'containment':
      return containmentForPaths(job.paths, job.judgedSha, job.root, undefined, job.branch);
    case 'committed-patch':
      return buildCommittedPatchSource(job.input);
    case 'hunk-exact':
      return buildHunkExactSource(job.input);
    case 'admit':
      return admitPathsOntoRepairHead({
        ...job.input,
        ...(job.preflight ? { preflight: admissionPreflightFromSpec(job.input.root, job.preflight) } : {}),
      });
    case 'retract':
      return retractAdmission(job.input);
    default: {
      const unknown: never = job;
      throw new Error(`unknown admission job kind: ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

/** Wire messages between the host and the admission worker. */
export type AdmissionWorkerRequest = { id: number; job: AdmissionJob };
export type AdmissionWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: { name: string; message: string; stack?: string } };

/** Minimal port surface so the worker loop is testable without a real thread. */
export interface AdmissionJobPort {
  on(event: 'message', listener: (message: AdmissionWorkerRequest) => void): unknown;
  postMessage(message: AdmissionWorkerResponse): void;
}

/**
 * The worker-side loop: announce readiness (the host treats any failure BEFORE this as a load
 * failure, never as a job failure), then run each request to completion. A worker thread runs
 * one message handler at a time, so jobs never interleave — the builders' sync invariant holds.
 */
export function serveAdmissionJobs(port: AdmissionJobPort): void {
  port.on('message', (request) => {
    try {
      const value = executeAdmissionJob(request.job);
      port.postMessage({ type: 'result', id: request.id, ok: true, value });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      port.postMessage({
        type: 'result',
        id: request.id,
        ok: false,
        error: { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) },
      });
    }
  });
  port.postMessage({ type: 'ready' });
}
