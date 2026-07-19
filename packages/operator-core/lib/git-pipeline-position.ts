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

/* ------------------------------------------------------------------------- *
 * EI-10895 — the RUNTIME-OWNER map.
 *
 * The pipeline this tool tracks (commit → origin/staging → green main → :3070)
 * is the activation path for exactly ONE process: the release operator. But the
 * box runs several other long-lived hosts, and every one of them executes
 * `npx tsx` STRAIGHT FROM THE STAGING WORKING TREE — no build, no dist/, no
 * release checkout:
 *
 *   inference gateway (:8788)  WorkingDirectory=<staging>   tsx packages/operator-core/lib/inference-gateway/bin.ts
 *   bg-host (routines/DBOS)    WorkingDirectory=<staging>   tsx bin/hono-host.ts (BACKGROUND_WORKERS=1)
 *   embed-sidecar (:3384)      WorkingDirectory=<staging>   esbuild-bundles on ExecStartPre, then runs it
 *
 * For code owned by those hosts the file ON DISK IS ALREADY WHAT RUNS on the
 * next start — so the ONLY thing between your edit and it being live is a
 * RESTART. Reporting `deployed ✗` and advising "sleep on the deploy
 * (deploy:await)" for such a path is not just unhelpful, it is WRONG: the
 * deploy will happily land and the behavior will not change, because the
 * process that runs that code never reads the release checkout. (This cost me
 * an hour on WI-4541 — a gateway admission fix, waiting on a deploy that could
 * never have activated it.)
 * ------------------------------------------------------------------------- */

/** The long-lived process that actually EXECUTES a given source path. */
export type RuntimeHost = 'operator-release' | 'gateway' | 'bg-host' | 'embed-sidecar' | 'tauri-desktop';

/** A `dev:restart { target }` value. */
export type RestartTargetName = 'dev' | 'staging' | 'gateway' | 'bg-host' | 'embed-sidecar';

export interface RuntimeOwnership {
  host: RuntimeHost;
  /**
   * Does the release pipeline (git-sync → green main → :3070 deploy) actually
   * carry this code into the process that runs it? FALSE for every staging-tree
   * tsx host — for those, a deploy is a no-op and a restart is the activation.
   */
  releasePipelineApplies: boolean;
  /** The `dev:restart` target that loads the edit, when a restart is the activation. */
  restartTarget: RestartTargetName | null;
  /** One line: how THIS edit becomes live. */
  activation: string;
}

interface RuntimeOwnerEntry {
  match: RegExp;
  /**
   * A path can be executed by MORE than one long-lived process (EI-16183's
   * sibling bug, WI-5440): `own` is normally a single `RuntimeOwnership`, but
   * for a file with genuinely distinct consumers on DIFFERENT activation
   * routes, list all of them — `classifyRuntimeOwners` returns the full set,
   * so a caller who collapses to one (the legacy `classifyRuntimeOwner`)
   * never silently hides the other route.
   */
  own: RuntimeOwnership | RuntimeOwnership[];
}

const RUNTIME_OWNERS: RuntimeOwnerEntry[] = [
  // WI-5440: success-metrics.ts has TWO real consumers on DIFFERENT activation
  // routes — the scout ideation cycle (bg-host, routinesTick) AND
  // buildProgramSuccessReport, called by the `blender:success-metrics` MCP tool
  // which is served by the RELEASE-CHECKOUT operator (the ordinary
  // staging→green-gate→deploy path). Collapsing to bg-host-only (the broader
  // `lib/scout/` rule below) sent a live activation decision the wrong way
  // during the 0.0.11-alpha release watch. Must be listed BEFORE the broader
  // `lib/scout/` rule so this specific, dual-owner file wins.
  {
    match: /^packages\/operator-core\/lib\/scout\/success-metrics\.ts$/,
    own: [
      {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation:
          "Scout's ideation cycle reads this via the `scout` deterministic blueprint's `blender:cycle` step, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). For THAT consumer it loads on RESTART: dev:restart { target: \"bg-host\", confirm: true } — a deploy never carries it (EI-11120).",
      },
      {
        host: 'operator-release',
        releasePipelineApplies: true,
        restartTarget: 'staging',
        activation:
          'buildProgramSuccessReport, called by the `blender:success-metrics` MCP tool, is served by the RELEASE-CHECKOUT operator (:3070) — for THAT consumer the ordinary staging→green-gate→deploy pipeline is the activation path (or dev:restart { target: "staging", confirm: true } to exercise it now on :3170).',
      },
    ],
  },
  // WI-4996: these three `*-sidecar-spawn.ts` supervisor modules live under a
  // directory that (correctly, for most of its files) maps to the sidecar they
  // supervise — but the SUPERVISOR itself runs in the SUPERVISING process, not
  // the sidecar it spawns/adopts. All three are called ONLY from
  // apps/operator/bin/host-bootstrap.ts, gated on `backgroundWorkers &&
  // !utilityHost` (i.e. exclusively bg-host boot code) — confirmed by tracing
  // every import site, not by directory heuristic. Must be listed BEFORE the
  // broader `inference-gateway/` rule below so the specific match wins.
  {
    match: /^packages\/operator-core\/lib\/inference-gateway\/gateway-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the gateway sidecar (ensureGatewaySidecar/registerGatewaySidecarShutdownHooks are called ONLY from apps/operator/bin/host-bootstrap.ts, gated on backgroundWorkers && !utilityHost) — it runs INSIDE bg-host, NOT inside the :8788 gateway process itself (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. Restarting "gateway" restarts the wrong — and far more disruptive, fleet-wide LLM-egress — process; it will NOT load this edit.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/fleet\/spawner-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the fleet spawner sidecar (spawnSpawnerSidecar is called from apps/operator/bin/host-bootstrap.ts — gated on backgroundWorkers && !utilityHost — plus git-sync/orchestrator-runner, both bg-host-side) — it runs INSIDE bg-host, not a separate process (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/sync\/hyperbee\/substrate-sidecar-spawn\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the BG-HOST supervisor that spawns/adopts the hyperbee substrate sidecar (wired via substrate-boot-wrapper, called ONLY from apps/operator/bin/host-bootstrap.ts, gated on backgroundWorkers && !utilityHost) — it runs INSIDE bg-host, not a separate process (WI-4996). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/inference-gateway\//,
    own: {
      host: 'gateway',
      releasePipelineApplies: false,
      restartTarget: 'gateway',
      activation:
        'The inference gateway (:8788) runs `npx tsx packages/operator-core/lib/inference-gateway/bin.ts` STRAIGHT FROM THIS TREE — no build, no deploy. Your edit is already on its disk; it loads on RESTART: dev:restart { target: "gateway", confirm: true }. Do NOT wait on a deploy — it cannot activate this code.',
    },
  },
  {
    match: /(^|\/)embed-sidecar/,
    own: {
      host: 'embed-sidecar',
      releasePipelineApplies: false,
      restartTarget: 'embed-sidecar',
      activation:
        'The embedding sidecar (:3384) esbuild-bundles its source from THIS TREE on every start (ExecStartPre) — no deploy involved. It loads on RESTART: dev:restart { target: "embed-sidecar", confirm: true }.',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/dbos\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'DBOS workflows / routines EXECUTE in bg-host, which runs `npx tsx bin/hono-host.ts` from THIS TREE (PAPERCUSP_BACKGROUND_WORKERS=1) — not from the release checkout. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. The :3070 deploy does not carry it.',
    },
  },
  // EI-11120: `system:<action>` routine handlers (register-system-actions.ts's
  // side-effect registry + every `*-action.ts` it wires in — git-sync, scout-cycle,
  // blueprint-run, improvement-implement, ...) plus the dispatch machinery itself are
  // driven EXCLUSIVELY by `routinesTick`, which only arms when
  // `PAPERCUSP_BACKGROUND_WORKERS=1` (host-bootstrap.ts) — the operator API hosts
  // (:3070 release, :3170 staging) boot with BACKGROUND_WORKERS=0 (request-only) and
  // never execute this code at all. A fix here lands + gates + deploys to :3070 and is
  // STILL inert until bg-host itself is restarted (the exact silent-inertness this
  // classification exists to surface). Must be listed BEFORE the broad
  // `packages/operator-core/lib/` fallthrough below.
  {
    match: /^packages\/operator-core\/lib\/harness\/routines\/(register-system-actions|system-actions|routine-host)\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is the routine-dispatch engine (routinesTick + the system-action registry) — it only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only (BACKGROUND_WORKERS=0) and never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    // Covers both the singular (`foo-action.ts`) and plural (`foo-actions.ts`,
    // e.g. improvement-actions.ts, coord-invariant-actions.ts) naming used across
    // this directory's registered `system:<action>` handlers.
    match: /^packages\/operator-core\/lib\/harness\/routines\/.*-actions?\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'This is a `system:<action>` routine handler, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 boot request-only (BACKGROUND_WORKERS=0) and never invoke it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/blueprint\/blueprint-run-action\.ts$/,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'The `system:blueprint-run` routine handler — the seam every deterministic-blueprint learning loop (scout, negative-space, red-queen, ...) fires through. Dispatched by routinesTick, which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host). It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    match: /^packages\/operator-core\/lib\/scout\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        "Scout's ideation cycle runs exclusively through the routine dispatch (the `scout` deterministic blueprint's `blender:cycle` step, fired via `system:blueprint-run`), which only executes when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host) — :3070/:3170 never run it. A deployed fix to this code is INERT until bg-host is restarted: dev:restart { target: \"bg-host\", confirm: true } (EI-11120 — this exact silent-inertness cost WI-4475 a wasted deploy-and-wait cycle).",
    },
  },
  {
    match: /^packages\/operator-core\/lib\/harness\/git-sync\//,
    own: {
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
      activation:
        'The git-sync pipeline (run-git-sync + its eligibility/escalation/reconcile helpers) executes only from the `system:git-sync` routine handler, dispatched by routinesTick — which only runs when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host); :3070/:3170 never execute it. It loads on RESTART: dev:restart { target: "bg-host", confirm: true }. A deploy does not carry it (EI-11120).',
    },
  },
  {
    match: /^papercusp-desktop\/src-tauri\//,
    own: {
      host: 'tauri-desktop',
      releasePipelineApplies: false,
      restartTarget: null,
      activation:
        'Rust/Tauri shell code — it is COMPILED into the desktop binary, not served by any host. Neither a deploy nor a `dev:restart` activates it: rebuild the shell (`cd papercusp-desktop && npm run dev`).',
    },
  },
];

/**
 * Which process runs this path — and therefore whether the release pipeline is
 * the activation path for it at all. `null` when we cannot tell (a sha-only
 * probe), which conservatively keeps the default release-pipeline reading.
 */
export function classifyRuntimeOwner(relPath: string | null | undefined): RuntimeOwnership | null {
  if (!relPath) return null;
  const p = relPath.replace(/^\.?\//, '');
  const hit = RUNTIME_OWNERS.find((r) => r.match.test(p));
  if (hit) return hit.own;
  return {
    host: 'operator-release',
    releasePipelineApplies: true,
    restartTarget: 'staging',
    activation:
      'Served by the operator. The green pipeline carries it to the live :3070 operator (release checkout) — or restart the staging host to exercise it NOW on :3170: dev:restart { target: "staging", confirm: true }.',
  };
}

/**
 * Shared code (operator-core / libs) is ALSO loaded by the staging-tree hosts,
 * so a deploy is not necessarily what makes YOUR behavior change. Surfaced as a
 * note rather than a reclassification: we cannot know from the path alone which
 * host the caller cares about.
 */
function sharedHostCaveat(relPath: string | null): string | null {
  if (!relPath) return null;
  const p = relPath.replace(/^\.?\//, '');
  if (!/^(packages\/operator-core\/lib|libs)\//.test(p)) return null;
  return 'Shared code: this path is ALSO loaded by the staging-tree hosts (gateway :8788, bg-host routines, :3170) which run tsx from this tree — not from the release checkout. If the behavior you are testing runs in one of THOSE, a deploy will not change it; restart that host (dev:restart { target }).';
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
    deployedBehindGreenPin: number | null;
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
  /**
   * EI-10895: which process actually RUNS this path, and therefore whether the
   * staging→main→:3070 pipeline is its activation path at all. `null` for a
   * sha-only probe (no path to classify).
   */
  runtime: RuntimeOwnership | null;
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

  // EI-10895: for a path the release pipeline does NOT carry, the deploy ticks are
  // not just noise — a `deployed ✗` reads as "still stuck in the pipeline" and sends
  // the agent off to wait for a deploy that can never activate the code. Lead with
  // the ACTIVATION instead, and demote the git ticks to what they actually mean here
  // (durability + peer visibility, not liveness).
  if (p.runtime && !p.runtime.releasePipelineApplies) {
    return `${label} @${p.targetShortSha}${subj}: runs in ${p.runtime.host} — NOT carried by the staging→main→:3070 deploy. ${
      p.runtime.activation
    } (git position: committed ${tick(p.positions.committedLocal)} · staging ${tick(
      p.positions.onStaging,
    )}${dirty} — durability/peer-visibility only; the running host reads THIS TREE, so even an uncommitted edit is what it loads on restart.)`;
  }

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
  // state (ready = the green pin; greenPinAtStagingHead / deployedBehindGreenPin are already
  // computed there) — no new I/O except the one ancestor check for deployOrigin.
  const ready = snap.deploy?.greenPin ?? null;
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
    mainFastForwarded: snap.deploy?.greenPinAtStagingHead ?? null,
    deployedBehindGreenPin: snap.deploy?.deployedBehindGreenPin ?? null,
    deployOrigin,
  };

  // EI-10895: classify against the SUPERPROJECT-relative path (a submodule path is
  // resolved inside its own repo above, but the runtime map keys on the repo-relative
  // path the caller passed).
  const runtime = classifyRuntimeOwner(inp.path ?? null);
  const caveat = runtime?.releasePipelineApplies ? sharedHostCaveat(inp.path ?? null) : null;
  if (caveat) notes.push(caveat);

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
    runtime,
    notes,
  };
  return { ...base, summary: summarizePosition(base) };
}
