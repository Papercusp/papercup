/**
 * git-pipeline-position — "where is my change, and is it live?" in ONE read
 * (git-sync-dx-hardening-2026-06-17 P-002 / EI-1164).
 *
 * Given a repo-relative PATH or a commit SHA, resolve its position along the
 * sync → green-checkpoint → release pipeline:
 *   committed locally → on `origin/staging` → in `origin/main` (passed the green
 *   gate) → reached the live `:3070` operator (the deployed sha).
 *
 * The three audits all hit the same DX tax: answering this took 4+ forensic git
 * + PG + curl commands. This joins it. Reuses `devDeployState` (the integration
 * tree root + the deployed sha) and `gitPipelineSnapshot` (the green-checkpoint
 * gate / stall context).
 *
 * READ-ONLY: no `git fetch`, no mutation — it reads the already-fetched origin
 * refs (git-sync fetches every tick) so it can never perturb the pipeline.
 *
 * A submodule path resolves inside that submodule (which tracks its OWN default
 * branch, not staging) — the exact pathspec confusion the audits flagged; the
 * result is annotated so the reader isn't misled.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { devDeployState, type DevDeployState } from './dev-deploy-state';
import { gitPipelineSnapshot, type GitPipelineSnapshot } from './git-pipeline-stats';

const pexec = promisify(execFile);

/** Injectable git runner (returns trimmed stdout, or null on any failure). */
export type GitRunner = (repo: string, args: string[]) => Promise<string | null>;

const realGit: GitRunner = async (repo, args) => {
  try {
    const { stdout } = await pexec('git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
};

/** Is `sha` an ancestor-or-equal of `ref` (i.e. does ref's history contain it)? */
async function refContains(git: GitRunner, repo: string, ref: string, sha: string): Promise<boolean> {
  // `${ref}..${sha}` = commits reachable from sha but NOT from ref. Zero of them
  // means ref's history already contains sha (sha is an ancestor-or-equal of ref).
  // rev-list prints a count on success, so this works through the plain GitRunner —
  // unlike `merge-base --is-ancestor`, whose 0/1 exit a stdout-only runner swallows.
  const contained = await git(repo, ['rev-list', '--count', `${ref}..${sha}`]);
  return contained === '0';
}

export interface PipelinePositionInput {
  path?: string;
  sha?: string;
}

export interface PipelinePosition {
  input: { path: string | null; sha: string | null };
  repoRoot: string;
  /** Set when the path resolved inside a submodule. */
  submodule: string | null;
  /** The commit whose pipeline position we report. */
  targetSha: string | null;
  targetShortSha: string | null;
  targetSubject: string | null;
  /** The path has uncommitted edits in the working tree (not yet committed). */
  dirtyUncommitted: boolean;
  positions: {
    committedLocal: boolean;
    onStaging: boolean;
    inMain: boolean;
    deployed: boolean;
  };
  deployedSha: string | null;
  gate: {
    stalled: boolean;
    consecutiveReds: number;
    lastGreenAtMs: number | null;
    /** WI-282: the green-checkpoint is WEDGED / not firing (visible even at 0 reds). */
    fireStale: boolean;
    fireStaleReason: string | null;
  };
  /**
   * EI-7846: provenance for the CURRENT gate/deploy verdict — distinct from the
   * per-target `positions` above (which answer "where is THIS path/sha"), this
   * answers "what does the pipeline consider green right now, and did the live
   * deploy actually come from that verdict, or was it pinned/forced ahead of or
   * behind it?" Derived entirely from already-loaded `deploy` state
   * (git-pipeline-stats.ts's `GitPipelineSnapshot.deploy`, the same
   * `devDeployState()` the /admin Git tab reads) — no new git calls except the
   * one ancestor check for `deployOrigin`.
   */
  verdictProvenance: {
    /** The full sha of `ready` — the green pin the LAST full-suite gate verdict produced. */
    lastGreenSha: string | null;
    lastGreenShortSha: string | null;
    /** How long ago that commit was made (ms) — the age of the current green pin. */
    lastGreenAgeMs: number | null;
    /** True iff `ready` (the green pin) is exactly at `main` HEAD — main is fully
     *  fast-forwarded to the newest green verdict, no un-gated commits ahead of it. */
    mainFastForwarded: boolean | null;
    /** Commits `ready` has that the deployed ref doesn't (0 once the live host has
     *  caught up to the latest green verdict). */
    deployedBehindReady: number | null;
    /**
     * 'gate-green': the deployed sha IS the last green pin (normal auto-deploy path).
     * 'stale-behind-gate': deployed is an ancestor of `ready` — safe lag, will catch
     *   up on the next release-trigger tick.
     * 'ahead-of-gate': deployed carries commits `ready` does NOT — it was force-deployed
     *   past the gate (release:deploy --execute bypassing the green pin), not sourced
     *   from a full-suite green verdict. Flag this before trusting "deployed" as "tested".
     * 'unknown': insufficient data (no `ready` pin, or no deployed sha) to classify.
     */
    deployOrigin: 'gate-green' | 'stale-behind-gate' | 'ahead-of-gate' | 'unknown';
  };
  gitSyncLastStatus: string | null;
  /** One human-readable line. */
  summary: string;
  notes: string[];
}

export interface PipelinePositionDeps {
  git?: GitRunner;
  loadDeploy?: () => Promise<DevDeployState>;
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
}

/** Parse `.gitmodules` submodule paths (best-effort). */
async function submodulePaths(git: GitRunner, root: string): Promise<string[]> {
  const out = await git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((p): p is string => !!p);
}

/** Pure: render the one-line human summary from the resolved facts. */
export function summarizePosition(p: Omit<PipelinePosition, 'summary'>): string {
  const tick = (b: boolean) => (b ? '✓' : '✗');
  const label = p.input.path ?? p.input.sha ?? '(none)';
  if (!p.targetSha) {
    return `${label}: no commit found${p.dirtyUncommitted ? ' (uncommitted edits present, not yet committed)' : ''}.`;
  }
  const subj = p.targetSubject ? ` "${p.targetSubject.slice(0, 60)}"` : '';
  const dirty = p.dirtyUncommitted ? ' ⚠ +uncommitted edits' : '';
  if (p.submodule) {
    return `${label} @${p.targetShortSha}${subj} [submodule ${p.submodule}]: committed ${tick(
      p.positions.committedLocal,
    )} · pushed-to-origin ${tick(p.positions.onStaging)}${dirty} — superproject→main→deploy chain not tracked for submodule paths.`;
  }
  const gateNote = !p.positions.inMain && p.gate.fireStale
    ? ` (green gate WEDGED — not firing: ${p.gate.fireStaleReason ?? 'stale'})`
    : !p.positions.inMain && p.gate.stalled
      ? ` (green gate STALLED: ${p.gate.consecutiveReds} reds)`
      : !p.positions.inMain && p.gate.consecutiveReds > 0
        ? ` (gate red: ${p.gate.consecutiveReds})`
        : '';
  return `${label} @${p.targetShortSha}${subj}: committed ${tick(p.positions.committedLocal)} · staging ${tick(
    p.positions.onStaging,
  )} · main ${tick(p.positions.inMain)}${gateNote} · deployed ${tick(p.positions.deployed)}${
    p.positions.deployed ? ' (live)' : ''
  }${dirty}.`;
}

export async function gitPipelinePosition(
  inp: PipelinePositionInput,
  deps: PipelinePositionDeps = {},
): Promise<PipelinePosition> {
  const git = deps.git ?? realGit;
  const loadDeploy = deps.loadDeploy ?? devDeployState;
  const loadSnapshot = deps.loadSnapshot ?? (() => gitPipelineSnapshot());

  const notes: string[] = [];
  const deploy = await loadDeploy();
  const root = deploy.integrationRoot;
  const deployedSha = deploy.deployed?.sha ?? null;

  // Resolve a submodule, if the path is inside one.
  let submodule: string | null = null;
  let gitDir = root;
  let relPath = inp.path ? inp.path.replace(/^\.?\//, '') : null;
  if (relPath) {
    const subs = await submodulePaths(git, root);
    const hit = subs.find((s) => relPath === s || relPath!.startsWith(s + '/'));
    if (hit) {
      submodule = hit;
      gitDir = path.join(root, hit);
      relPath = relPath.slice(hit.length).replace(/^\//, '');
      notes.push(
        `Path is inside submodule '${hit}'; positions resolved in that submodule, which tracks its own default branch (not staging).`,
      );
    }
  }

  // Dirty (uncommitted) check for a path.
  let dirtyUncommitted = false;
  if (inp.path) {
    const st = await git(gitDir, ['status', '--porcelain', '--', relPath || '.']);
    dirtyUncommitted = !!st && st.length > 0;
  }

  // Resolve the target sha: explicit sha, else the path's last commit.
  let targetSha: string | null = null;
  if (inp.sha) {
    targetSha = (await git(gitDir, ['rev-parse', '--verify', `${inp.sha}^{commit}`])) ?? null;
    if (!targetSha) notes.push(`SHA '${inp.sha}' did not resolve in ${submodule ?? 'the superproject'}.`);
  } else if (relPath) {
    targetSha = await git(gitDir, ['log', '-1', '--pretty=%H', '--', relPath]);
    if (!targetSha) notes.push(`No commit has touched '${relPath}' yet${dirtyUncommitted ? ' (it is newly created / uncommitted)' : ''}.`);
  } else {
    notes.push('Provide a path or a sha.');
  }

  const targetSubject = targetSha ? await git(gitDir, ['log', '-1', '--pretty=%s', targetSha]) : null;
  const targetShortSha = targetSha ? targetSha.slice(0, 9) : null;

  const positions = {
    committedLocal: false,
    onStaging: false,
    inMain: false,
    deployed: false,
  };
  if (targetSha) {
    positions.committedLocal = await refContains(git, gitDir, 'HEAD', targetSha);
    if (submodule) {
      // Submodules track their own default branch; "pushed" == on origin/HEAD.
      positions.onStaging = await refContains(git, gitDir, 'origin/HEAD', targetSha);
    } else {
      positions.onStaging = await refContains(git, root, 'origin/staging', targetSha);
      positions.inMain = await refContains(git, root, 'origin/main', targetSha);
      positions.deployed = deployedSha ? await refContains(git, root, deployedSha, targetSha) : false;
    }
  }

  const snap = await loadSnapshot();
  const gate = {
    stalled: snap.gate.stalled,
    consecutiveReds: snap.gate.consecutiveReds,
    lastGreenAtMs: snap.gate.lastGreenAtMs,
    fireStale: snap.gate.fireStale,
    fireStaleReason: snap.gate.fireStaleReason,
  };

  // EI-7846: verdict provenance, derived from the snapshot's already-loaded deploy
  // state (ready = the green pin; readyAtMainHead / deployedBehindReady are already
  // computed there) — no new I/O except the one ancestor check for deployOrigin.
  const ready = snap.deploy?.ready ?? null;
  let deployOrigin: PipelinePosition['verdictProvenance']['deployOrigin'] = 'unknown';
  if (ready && deployedSha) {
    if (deployedSha === ready.sha) {
      deployOrigin = 'gate-green';
    } else {
      // Is the deployed sha an ancestor-or-equal of the green pin (safe lag), or does
      // it carry commits the green pin doesn't (force-deployed past the gate)?
      const deployedIsAncestorOfReady = await refContains(git, root, ready.sha, deployedSha);
      deployOrigin = deployedIsAncestorOfReady ? 'stale-behind-gate' : 'ahead-of-gate';
    }
  }
  const verdictProvenance: PipelinePosition['verdictProvenance'] = {
    lastGreenSha: ready?.sha ?? null,
    lastGreenShortSha: ready?.shortSha ?? null,
    lastGreenAgeMs: ready ? Date.now() - ready.committedAtMs : null,
    mainFastForwarded: snap.deploy?.readyAtMainHead ?? null,
    deployedBehindReady: snap.deploy?.deployedBehindReady ?? null,
    deployOrigin,
  };

  const base: Omit<PipelinePosition, 'summary'> = {
    input: { path: inp.path ?? null, sha: inp.sha ?? null },
    repoRoot: root,
    submodule,
    targetSha,
    targetShortSha,
    targetSubject,
    dirtyUncommitted,
    positions,
    verdictProvenance,
    deployedSha,
    gate,
    gitSyncLastStatus: snap.gitSync.lastStatus,
    notes,
  };
  return { ...base, summary: summarizePosition(base) };
}
