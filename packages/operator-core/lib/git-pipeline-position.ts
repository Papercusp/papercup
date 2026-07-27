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
import { probeServiceStart } from './agent-tools/dev/systemd-service-probe';
import { RESTART_TARGET_UNITS } from './agent-tools/dev/restart-target-units';
import {
  classifyPathsAgainstCandidate,
  gitReadForRepo,
  type MissingReason,
  type PathContainment,
} from './candidate-contains';

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

/**
 * EI-18694888339365359: the LOCAL `origin/staging` remote-tracking ref can lag
 * arbitrarily behind the true remote tip — this module deliberately never runs
 * `git fetch` (see the module doc), so it depends on git-sync's own periodic
 * fetch to keep that ref fresh, and a read between ticks sees a stale ref.
 * Confirmed live: `refContains` against the local ref said the target commit
 * was NOT on origin/staging while `git ls-remote origin refs/heads/staging`
 * showed the target WAS the exact remote tip — release:trace then emitted a
 * BLOCKING "not-on-origin-staging" constraint and told the agent to
 * `git-sync:await` a push that had already happened, parking it forever on an
 * already-satisfied condition.
 *
 * `git ls-remote` queries the remote's ref advertisement over the network
 * WITHOUT fetching any objects or touching a single local ref — it stays
 * exactly as read-only/non-perturbing as the rest of this module while giving
 * an authoritative, always-current answer for the one case it CAN answer
 * without local objects: "is the target commit exactly the remote tip right
 * now?" (It cannot establish ancestry for a target that is an OLDER,
 * non-tip commit on a remote that has since moved past the local ref's
 * knowledge — that needs the actual commit graph, i.e. a fetch, which this
 * module intentionally does not perform.)
 */
async function isExactRemoteTip(git: GitRunner, repo: string, remoteRef: string, sha: string): Promise<boolean> {
  const out = await git(repo, ['ls-remote', 'origin', remoteRef]);
  if (!out) return false;
  const tip = out.split(/\s+/)[0]?.toLowerCase();
  return !!tip && tip === sha.toLowerCase();
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

const DEFAULT_OWNER: RuntimeOwnership = {
  host: 'operator-release',
  releasePipelineApplies: true,
  restartTarget: 'staging',
  activation:
    'Served by the operator. The green pipeline carries it to the live :3070 operator (release checkout) — or restart the staging host to exercise it NOW on :3170: dev:restart { target: "staging", confirm: true }.',
};

/**
 * ALL processes that run this path — a path can have more than one consumer
 * on DIFFERENT activation routes (WI-5440: e.g. a file read by both a
 * bg-host-only routine AND an operator-served MCP tool). Returns the full
 * list, always in the order declared on `RUNTIME_OWNERS` (single-owner paths
 * — the overwhelming majority — get a 1-element array). `null` when we cannot
 * tell (a sha-only probe), which conservatively keeps the default
 * release-pipeline reading.
 */
export function classifyRuntimeOwners(relPath: string | null | undefined): RuntimeOwnership[] | null {
  if (!relPath) return null;
  const p = relPath.replace(/^\.?\//, '');
  const hit = RUNTIME_OWNERS.find((r) => r.match.test(p));
  if (hit) return Array.isArray(hit.own) ? hit.own : [hit.own];
  return [DEFAULT_OWNER];
}

/**
 * Which process runs this path — and therefore whether the release pipeline is
 * the activation path for it at all. `null` when we cannot tell (a sha-only
 * probe), which conservatively keeps the default release-pipeline reading.
 *
 * EI-16183/WI-5440: this collapses to the FIRST-declared owner and so hides
 * any second consumer a path may have — kept only for callers that
 * genuinely want a single best-guess answer (and for back-compat). Prefer
 * `classifyRuntimeOwners` (plural) for anything that acts on the result,
 * so a dual-owner path is never silently routed as single-owner.
 */
export function classifyRuntimeOwner(relPath: string | null | undefined): RuntimeOwnership | null {
  const owners = classifyRuntimeOwners(relPath);
  return owners ? owners[0] : null;
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
  /**
   * EI-18715870370005934: set when the caller passed a SUPERPROJECT sha together
   * with a submodule path. The superproject stores only a gitlink for a
   * submodule, so that sha resolves to no content and no commit inside the
   * submodule; we resolve the gitlink and report positions for the PINNED
   * submodule commit instead. Non-null means "the sha you asked about is not the
   * sha these positions describe" — the mapping is recorded here so the
   * substitution is never silent.
   */
  submodulePin: { superprojectSha: string; submoduleSha: string } | null;
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
  /**
   * Kept for back-compat. PREFER `gitSync` — this single word cannot answer the
   * question callers actually have: `'synced'` is reachable with nothing pushed.
   */
  gitSyncLastStatus: string | null;
  /**
   * P-002 (EI-18753105351266788): the commit leg and the push leg are SEPARATE,
   * and `lastStatus` collapses them. run-git-sync already computes per-repo
   * pushed/merged/conflict/error detail and the snapshot already carries it — it
   * was simply dropped here, leaving agents to infer "reached origin" from a word
   * that does not mean that. EI-18750935999066024 is the cost: origin/staging
   * frozen 2h52m with 19 stranded commits, read as "not yet".
   */
  gitSync: GitSyncLegs;
  /**
   * EI-10895: which process actually RUNS this path, and therefore whether the
   * staging→main→:3070 pipeline is its activation path at all. `null` for a
   * sha-only probe (no path to classify). This is `runtimes[0]` — kept for
   * back-compat; a dual-consumer path (WI-5440) is fully described only in
   * `runtimes`, never in this single field.
   */
  runtime: RuntimeOwnership | null;
  /**
   * WI-5440: ALL processes that run this path (usually 1). When this has more
   * than one entry, the path has genuinely distinct consumers on different
   * activation routes — a single `runtime`/`activation` answer would be
   * WRONG for at least one of them. `null` for a sha-only probe.
   */
  runtimes: RuntimeOwnership[] | null;
  /**
   * P-003: whether the process that RUNS this path has actually loaded the code —
   * process truth, deliberately not derived from git. `deployed` answers a
   * different question and must never be read as "live".
   */
  serving: ServingTruth;
  /**
   * P-004: does the commit the GATE is judging actually contain this path's current
   * content? Every other field here answers "where is my change in the pipeline";
   * this one answers the question that comes first and was unanswerable —
   * "is the thing being judged even my code?".
   */
  changeInCandidate: ChangeInCandidate;
  /**
   * git-pipeline-agent-state-2026-07-26 P-001: per-stage POSITION x HEALTH,
   * ordered source->live.
   *
   * `positions` above answers only "is my change past this stage?". A boolean
   * cannot distinguish "not yet, wait" from "this leg is dead, waiting is
   * futile" — and that single missing dimension is behind most filed pipeline
   * confusion (a 2h52m push freeze read as "not yet"; `deployed ✓` read as
   * "live" while the process served older code, filed 4x independently).
   */
  stages: StageState[];
  /**
   * P-005: the stage actually holding this change up — the first `pending` stage in
   * source→live order — or `null` when nothing is pending (it is live).
   */
  blockedOn: StageName | null;
  /**
   * P-005: the ONE thing to do about it, or `null` when waiting is the honest answer.
   *
   * Read WITH `blockedOn`: null/null means live; a stage with a null action means the leg
   * is healthy and will advance on its own. See deriveBlocker for why those three states
   * must stay distinct.
   */
  nextAction: string | null;
  /** One human-readable line. */
  summary: string;
  notes: string[];
}

/**
 * P-002: git-sync's two legs, reported separately. `status` is the raw routine word
 * kept for continuity; every other field is what actually answers "did my work
 * reach origin, and is that leg even alive?".
 */
export interface GitSyncLegs {
  status: string | null;
  /** When the last tick completed, and how long ago — the liveness of the leg itself. */
  lastSyncedAtMs: number | null;
  syncAgeMs: number | null;
  /** >0 means the routine is FAULTING, not merely idle. */
  consecutiveErrorTicks: number;
  /** Repos the last tick actually PUSHED. Empty with status 'synced' is the trap. */
  pushedRepos: string[];
  mergedRepos: string[];
  conflicts: string[];
  errors: string[];
}

/**
 * git-sync ticks roughly every 10 min, so a tick age past ~2.5 intervals means the
 * routine is not merely between ticks — it has stopped advancing. Used only to
 * classify HEALTH; never to claim a position.
 */
export const GIT_SYNC_STALE_AFTER_MS = 25 * 60_000;

/**
 * P-003: process truth for the SERVING stage.
 *
 * `deployed` is a GIT fact — "the release checkout's HEAD is at my sha". It says
 * nothing about whether the long-lived process that answers requests has ever
 * LOADED that code. Four agents filed that gap independently
 * (EI-18740960754854672, EI-18741985436324043, EI-18741004371760803,
 * EI-18746827803289687), which makes it a missing state surface rather than four
 * careless readings.
 *
 * The comparison is TEMPORAL, never a git read: there is no reliable
 * sha-of-the-running-process (the checkout can advance under a process that
 * already imported the old modules), so the honest question is "did this process
 * start AFTER the code it runs last changed?".
 */
export interface ServingTruth {
  /** The long-lived process this verdict describes (the path's primary runtime owner). */
  host: RuntimeHost | null;
  /** Its systemd --user unit. `null` for a host that has none (tauri-desktop is compiled). */
  unit: string | null;
  pid: number | null;
  startedAtMs: number | null;
  /**
   * When the code THIS host loads last changed:
   *  - `deploy`     — a release-checkout host receives code AT DEPLOY TIME, so the
   *                   deploy is the moment its code changed.
   *  - `file-mtime` — a working-tree tsx host imports the file itself, so the file's
   *                   own mtime is what a restart would pick up (committed or not).
   */
  codeAsOfMs: number | null;
  codeAsOfSource: 'deploy' | 'file-mtime' | null;
  /**
   * Did the process start AFTER that moment? `true` = it has actually loaded the
   * code. `false` = it PREDATES the code and is executing an older snapshot.
   * `null` = unknown — never guessed in either direction.
   */
  startedSinceCodeChange: boolean | null;
  /** Minutes the process is behind the code, when it predates it. */
  behindMin: number | null;
  /** The concrete command that makes the code live, when it is not. */
  restartLever: string | null;
  /** Why the answer is `null`, when it is. */
  unknownReason: string | null;
}

/**
 * Which long-lived process actually serves each runtime host. NOT the same as
 * `RuntimeOwnership.restartTarget`: an `operator-release` path's restartTarget is
 * `staging` (the :3170 host you bounce to EXERCISE an edit), while the process
 * SERVING it in production is the :3070 release operator. Conflating the two
 * would probe the wrong process and report a confident wrong answer.
 */
const SERVING_UNIT_BY_HOST: Record<RuntimeHost, string | null> = {
  'operator-release': RESTART_TARGET_UNITS.dev,
  gateway: RESTART_TARGET_UNITS.gateway,
  'bg-host': RESTART_TARGET_UNITS['bg-host'],
  'embed-sidecar': RESTART_TARGET_UNITS['embed-sidecar'],
  // Compiled into the desktop binary — no unit serves it, so no process probe can answer.
  'tauri-desktop': null,
};

/** The lever that makes code live for each host, given its restart target. */
function servingRestartLever(rt: RuntimeOwnership): string {
  if (rt.host === 'tauri-desktop') {
    return 'Rebuild the desktop shell: cd papercusp-desktop && npm run dev';
  }
  if (rt.host === 'operator-release') {
    // The :3070 host loads the RELEASE checkout, so the lever is a real deploy
    // (which restarts it) — a bare restart would only re-load the same old checkout.
    return 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute';
  }
  return rt.restartTarget
    ? `dev:restart { target: "${rt.restartTarget}", confirm: true }`
    : 'restart the host process';
}

/**
 * PURE verdict for the serving stage — no probing, so it is directly testable.
 * Unknown inputs produce `startedSinceCodeChange: null` with a REASON, never a
 * fabricated true/false: a wrong "yes, it's live" here is exactly the failure
 * this surface exists to remove.
 */
export function evaluateServing(args: {
  runtime: RuntimeOwnership | null;
  process: { pid: number | null; startedAtMs: number | null } | null;
  codeAsOfMs: number | null;
  codeAsOfSource: 'deploy' | 'file-mtime' | null;
}): ServingTruth {
  const { runtime, process: proc, codeAsOfMs, codeAsOfSource } = args;
  const host = runtime?.host ?? null;
  const unit = host ? SERVING_UNIT_BY_HOST[host] : null;
  const restartLever = runtime ? servingRestartLever(runtime) : null;
  const base: ServingTruth = {
    host,
    unit,
    pid: proc?.pid ?? null,
    startedAtMs: proc?.startedAtMs ?? null,
    codeAsOfMs,
    codeAsOfSource,
    startedSinceCodeChange: null,
    behindMin: null,
    restartLever,
    unknownReason: null,
  };

  if (!runtime) {
    return { ...base, unknownReason: 'No path was given (sha-only probe), so no serving process can be identified.' };
  }
  if (!unit) {
    return {
      ...base,
      unknownReason:
        host === 'tauri-desktop'
          ? 'This code is COMPILED into the desktop binary — no server process serves it, so "is it running?" is answered by rebuilding the shell, not by a process probe.'
          : 'No systemd unit is known for this host.',
    };
  }
  // Number.isFinite, not `=== null`: these two timestamps come from a subprocess
  // parse and from free-form deploy state respectively, so `undefined` and `NaN`
  // are both reachable — and BOTH slip past a null check. An arithmetic comparison
  // against one then yields `false` (reading as the confident "it is stale!") and a
  // `NaN` minute count in the message. A diagnostic surface must degrade to an
  // honest UNKNOWN, never to a confident wrong verdict rendered with "NaNm".
  const startedAtMs = Number.isFinite(base.startedAtMs as number) ? (base.startedAtMs as number) : null;
  const codeMs = Number.isFinite(codeAsOfMs as number) ? (codeAsOfMs as number) : null;
  if (startedAtMs === null) {
    return {
      ...base,
      unknownReason: `Could not read ${unit}'s start time (not running, no systemd, or a non-Linux host) — serving state is UNKNOWN, which is not the same as "live".`,
    };
  }
  if (codeMs === null) {
    return {
      ...base,
      unknownReason: `Read ${unit} (pid ${base.pid}) but not when its code last changed, so the two cannot be compared — serving state is UNKNOWN, not "live".`,
    };
  }

  const startedSinceCodeChange = startedAtMs > codeMs;
  return {
    ...base,
    startedSinceCodeChange,
    behindMin: startedSinceCodeChange ? null : Math.max(1, Math.round((codeMs - startedAtMs) / 60_000)),
  };
}

/**
 * P-004 (EI-18752644493166307): whether the commit the GATE judges contains this
 * path's current content.
 *
 * The gate checks out a COMMITTED candidate into an isolated tree — it cannot see
 * the working tree, and the quiet-cut routinely steps the candidate BACK from the
 * tip. So "is my change committed / pushed" (which `positions` answers) does not
 * imply "the run about to red is testing my code".
 *
 * When it isn't, the verdict is actively misleading rather than merely useless: the
 * suite reds on the PRE-FIX failure with the PRE-FIX count, which reads as *your fix
 * did not work* instead of *your fix was not present*, and sends the caller off to
 * re-debug correct code. That misread — not the wasted run — is what this measures
 * away.
 *
 * TWO candidates, because they answer different questions:
 *  - `judgingSha`       the run that is ALREADY IN FLIGHT. Its verdict is the one
 *                       about to land, so this is what to read a red against.
 *  - `nextCandidateSha` what a `release:checkpoint-run` fired RIGHT NOW would judge
 *                       (post quiet-cut). This is what to check BEFORE firing.
 * Both are `null` when no run is active / nothing could be resolved, and every
 * `contains` verdict is three-valued — an unresolvable read is `null` (unknown),
 * never `false` (and never a silent `true`).
 */
export interface ChangeInCandidate {
  /** The commit an in-flight gate run is judging, if one is active. */
  judgingSha: string | null;
  /** Does that candidate carry this path's WORKING-TREE content? null = not comparable. */
  judgingContainsPath: boolean | null;
  /** The commit a checkpoint fired right now would judge (post quiet-cut). */
  nextCandidateSha: string | null;
  nextContainsPath: boolean | null;
  /** When a verdict is false: which lever fixes it (uncommitted / newer-commit / absent). */
  missingReason: MissingReason | null;
  /** One line: what these verdicts mean, and the concrete next move. */
  detail: string | null;
}

/** Nothing measurable — a sha-only probe, a submodule path, or an unresolved candidate. */
const NO_CHANGE_IN_CANDIDATE: ChangeInCandidate = {
  judgingSha: null,
  judgingContainsPath: null,
  nextCandidateSha: null,
  nextContainsPath: null,
  missingReason: null,
  detail: null,
};

/** The two candidate shas the gate machinery can name, resolved together. */
export interface GateCandidates {
  /** Candidate of the run in flight right now, or null when none is. */
  judgingSha: string | null;
  /** Candidate a fresh launch would pick (quiet-cut applied). */
  nextCandidateSha: string | null;
}

/**
 * Pure: turn the two candidates + their per-path containment into the caller-facing
 * verdict. Separated from the git/systemd reads so the phrasing — which is the whole
 * deliverable here — is unit-testable without a repo.
 */
export function evaluateChangeInCandidate(args: {
  relPath: string | null;
  candidates: GateCandidates;
  judging: PathContainment | null;
  next: PathContainment | null;
}): ChangeInCandidate {
  const { relPath, candidates, judging, next } = args;
  if (!relPath) return NO_CHANGE_IN_CANDIDATE;
  const base: ChangeInCandidate = {
    judgingSha: candidates.judgingSha,
    judgingContainsPath: judging ? judging.inCandidate : null,
    nextCandidateSha: candidates.nextCandidateSha,
    nextContainsPath: next ? next.inCandidate : null,
    missingReason: judging?.reason ?? next?.reason ?? null,
    detail: null,
  };

  const lever = (reason: MissingReason | null): string => {
    switch (reason) {
      case 'uncommitted':
        return 'The edit is still only in the working tree, which the gate cannot see. Commit it first: git-sync:run.';
      case 'absent':
        return 'That file does not exist at all in the judged commit (it is new). Commit it first: git-sync:run.';
      case 'newer-commit':
        return 'It IS committed, but in a commit newer than the candidate (the quiet-cut steps the candidate back ~4 min). Re-fire once the commit ages past the quiet window, or let the next run pick it up.';
      default:
        return '';
    }
  };

  // The in-flight run's verdict is the one about to land, so it outranks the
  // hypothetical next candidate whenever both are known.
  if (base.judgingContainsPath === false) {
    return {
      ...base,
      detail:
        `The gate run IN FLIGHT is judging ${base.judgingSha?.slice(0, 12)}, which does NOT contain this file's current content. ` +
        `A RED from that run is NOT evidence your change failed — it is testing code without it. ${lever(base.missingReason)}`,
    };
  }
  if (base.judgingContainsPath === true) {
    return {
      ...base,
      detail: `The gate run in flight (${base.judgingSha?.slice(0, 12)}) DOES carry this file's current content, so its verdict is a real verdict on your change.`,
    };
  }
  if (base.nextContainsPath === false) {
    return {
      ...base,
      detail:
        `A checkpoint fired right now would judge ${base.nextCandidateSha?.slice(0, 12)}, which does NOT contain this file's current content — ` +
        `firing now buys a verdict on code without your change. ${lever(base.missingReason)}`,
    };
  }
  if (base.nextContainsPath === true) {
    return {
      ...base,
      detail: `A checkpoint fired now would judge ${base.nextCandidateSha?.slice(0, 12)}, which DOES carry this file's current content.`,
    };
  }
  return base;
}

/** A stage a change must clear to be live, ordered source->live. */
export type StageName = 'committed' | 'pushed' | 'gate' | 'main' | 'deployed' | 'serving';

/** Where MY change sits relative to a stage. `na` = this stage is not on my change's activation route at all. */
export type StagePosition = 'past' | 'pending' | 'na';

/**
 * Whether the stage ITSELF is moving — the dimension a position boolean cannot express.
 * `advancing` normal · `stalled` not progressing, waiting will probably not help ·
 * `disabled` deliberately off · `broken` faulted · `unknown` not measured here.
 */
export type StageHealth = 'advancing' | 'stalled' | 'disabled' | 'broken' | 'unknown';

export interface StageState {
  name: StageName;
  position: StagePosition;
  health: StageHealth;
  /** Why it reads this way, and the concrete lever when it is not advancing. */
  detail: string | null;
  /**
   * P-005: the ONE concrete thing that moves this stage, extracted from `detail` prose
   * into a field — or `null` when waiting genuinely IS the correct move.
   *
   * The distinction is the point. Every stage can produce prose; only some have an
   * action. Burying "there is nothing to do but wait" inside a paragraph that also
   * explains the mechanism reads as "here is a problem", and an agent that must
   * decide-from-prose which of six stages owns the next move is doing the work this
   * surface exists to do for it. `null` here is a POSITIVE answer, not a missing one.
   */
  lever: string | null;
}

/**
 * Derive the stage table from state the caller ALREADY computed — this function
 * makes no git calls and adds no measurement, so it is pure and unit-testable.
 * P-002/P-003/P-004 replace the `unknown` healths with real signals.
 */
export function computeStages(
  p: Pick<
    PipelinePosition,
    | 'dirtyUncommitted'
    | 'positions'
    | 'gate'
    | 'verdictProvenance'
    | 'runtime'
    | 'gitSyncLastStatus'
    | 'gitSync'
    | 'serving'
    | 'changeInCandidate'
  >,
): StageState[] {
  // A path whose runtime does NOT go through the release pipeline (bg-host, gateway,
  // embed-sidecar) is never carried by staging->main->:3070 at all: reporting those
  // stages as "pending" would tell the caller to wait for something that will never
  // happen to their file. EI-11120 cost a real deploy-and-wait cycle to this exact
  // misreading, so those stages are `na` with the activation lever attached.
  const rt = p.runtime;
  const releaseApplies = rt ? rt.releasePipelineApplies : true;
  const naDetail = rt
    ? `Not on this path's activation route — it runs in ${rt.host}, which does not read the release checkout. It goes live on RESTART: dev:restart { target: "${rt.restartTarget}", confirm: true }.`
    : null;
  const off = (name: StageName): StageState => ({
    name,
    position: 'na',
    health: 'disabled',
    detail: naDetail,
    // An `na` stage is not on this change's route at all, so it never owns the next move —
    // the RESTART that does is the serving stage's lever, not this one's.
    lever: null,
  });

  const stages: StageState[] = [];

  // committed — about MY CHANGE, not merely the path. `positions.committedLocal`
  // means "this path exists at some commit", which reads as "my change is
  // committed" and is the single most-misread signal in this surface.
  stages.push({
    name: 'committed',
    position: p.positions.committedLocal && !p.dirtyUncommitted ? 'past' : 'pending',
    health: p.dirtyUncommitted ? 'stalled' : 'advancing',
    detail: p.dirtyUncommitted
      ? 'Uncommitted edits in the working tree. The release gate checks out a COMMITTED candidate and cannot see the tree, so this change is invisible to it until git-sync commits. Force it now: git-sync:run.'
      : null,
    lever: p.dirtyUncommitted ? 'git-sync:run (commit the working tree — the gate cannot see it)' : null,
  });

  // pushed — P-002. The push leg fails INDEPENDENTLY of the commit leg, and its
  // failure is silent: commits keep accumulating locally while origin freezes. The
  // health here is what tells a caller whether waiting can possibly help.
  const gs = p.gitSync;
  const stale = gs.syncAgeMs !== null && gs.syncAgeMs > GIT_SYNC_STALE_AFTER_MS;
  const pushedHealth: StageHealth =
    gs.consecutiveErrorTicks > 0 || gs.errors.length > 0
      ? 'broken'
      : gs.conflicts.length > 0
        ? 'broken'
        : stale
          ? 'stalled'
          : 'advancing';
  const pushedDetail = ((): string | null => {
    if (gs.consecutiveErrorTicks > 0 || gs.errors.length > 0) {
      return `git-sync is FAULTING (${gs.consecutiveErrorTicks} consecutive error tick(s))${
        gs.errors.length ? `: ${gs.errors.slice(0, 2).join('; ')}` : ''
      }. Commits may keep landing locally while origin stays frozen — waiting will not clear this.`;
    }
    if (gs.conflicts.length > 0) {
      return `git-sync hit merge CONFLICTS (${gs.conflicts.slice(0, 3).join(', ')}) — a merge-resolver must clear them before anything reaches origin.`;
    }
    if (stale) {
      return `git-sync's last tick was ${Math.round((gs.syncAgeMs ?? 0) / 60_000)} min ago (ticks are ~10 min) — the leg is not advancing, so this is not simply "not yet".`;
    }
    if (!p.positions.onStaging) {
      return `Committed locally but NOT yet on origin/staging. Status "${gs.status ?? 'unknown'}" does NOT mean pushed — the last tick pushed ${
        gs.pushedRepos.length ? gs.pushedRepos.join(', ') : 'NOTHING'
      }. Force one: git-sync:run.`;
    }
    return null;
  })();
  // The push leg is the clearest case for a null lever: when it is simply BETWEEN ticks,
  // waiting is not a fallback, it is the right answer — git-sync will push within ~10 min.
  // A lever here would invite a needless forced run. But a FAULTED leg will never
  // self-clear, so waiting there is the wrong answer and must not read the same.
  const pushedLever = !p.positions.onStaging
    ? gs.conflicts.length > 0
      ? 'a merge-resolver must clear the git-sync conflicts — this leg cannot self-heal'
      : pushedHealth === 'broken' || pushedHealth === 'stalled'
        ? 'git-sync:run (the push leg is not advancing on its own)'
        : null
    : null;
  stages.push({
    name: 'pushed',
    position: p.positions.onStaging ? 'past' : 'pending',
    health: pushedHealth,
    detail: pushedDetail,
    lever: pushedLever,
  });

  if (!releaseApplies) {
    stages.push(off('gate'), off('main'), off('deployed'));
  } else {
    const g = p.gate;
    const gateHealth: StageHealth = g.fireStale
      ? 'broken'
      : g.stalled || g.consecutiveReds > 0
        ? 'stalled'
        : 'advancing';
    // P-004: a red gate and a candidate that lacks your change are the SAME reading
    // for a caller unless something separates them — and the wrong separation is the
    // expensive one (re-debugging a correct fix). So when the candidate provably does
    // not carry this file, that fact LEADS the gate detail, ahead of the red count.
    const cic = p.changeInCandidate;
    const notInCandidate = cic.judgingContainsPath === false || cic.nextContainsPath === false;
    stages.push({
      name: 'gate',
      position: p.positions.inMain ? 'past' : 'pending',
      health: gateHealth,
      detail: notInCandidate
        ? `${cic.detail}${
            gateHealth === 'stalled'
              ? ` (The gate is also RED — ${g.consecutiveReds} consecutive — but do NOT read that red as your change failing until a run that CONTAINS it completes.)`
              : ''
          }`
        : g.fireStale
          ? `The green-checkpoint is NOT FIRING${g.fireStaleReason ? ` (${g.fireStaleReason})` : ''} — no verdict is coming until that is fixed. Waiting will not help; fire one with release:checkpoint-run.`
          : gateHealth === 'stalled'
            ? `Gate is RED (${g.consecutiveReds} consecutive) — main is held for everyone until it greens. The reds are yours to fix, not a queue to wait in.`
            : null,
      // Containment outranks the gate's own health: firing a verdict on a candidate that
      // cannot see your change buys nothing, so fixing THAT comes before greening reds.
      lever: !p.positions.inMain
        ? notInCandidate
          ? cic.missingReason === 'uncommitted' || cic.missingReason === 'absent'
            ? 'git-sync:run (the judged candidate does not contain your change yet)'
            : 'wait out the quiet-cut window (~4 min), then release:checkpoint-run — the judged candidate predates your commit'
          : g.fireStale
            ? 'release:checkpoint-run (the green-checkpoint is not firing — no verdict is coming on its own)'
            : gateHealth === 'stalled'
              ? 'fix the reds, then release:checkpoint-run — a red gate holds main for everyone and is yours to green, not a queue to wait in'
              : null
        : null,
    });

    stages.push({
      name: 'main',
      position: p.positions.inMain ? 'past' : 'pending',
      health: p.verdictProvenance.mainFastForwarded === false ? 'stalled' : 'advancing',
      detail:
        p.verdictProvenance.mainFastForwarded === false
          ? 'main is not fast-forwarded to the newest green pin — un-gated commits sit ahead of it.'
          : null,
      // main advances only as a CONSEQUENCE of a green verdict — there is no lever that
      // acts on it directly, so anything offered here would send the caller at the wrong
      // stage. The gate above owns this move.
      lever: null,
    });

    // 'ahead-of-gate' means the live code was force-deployed PAST the gate, so
    // "deployed" does not imply "tested" — the existing deployOrigin comment says
    // to flag exactly this, so surface it as a health, not a footnote.
    const ahead = p.verdictProvenance.deployOrigin === 'ahead-of-gate';
    stages.push({
      name: 'deployed',
      position: p.positions.deployed ? 'past' : 'pending',
      health: ahead ? 'broken' : 'advancing',
      detail: ahead
        ? 'The deployed sha carries commits the green pin does NOT — it was force-deployed past the gate. "deployed" does not mean "tested" here.'
        : null,
      // Only offer the force-deploy once the change is actually IN main — suggesting it
      // earlier would ship a sha that does not carry the change, which looks like progress
      // and is not. release-trigger ships a green pin within ~15 min on its own, so this is
      // the "you may not need to do anything" case; the lever exists for when you do.
      lever:
        !p.positions.deployed && p.positions.inMain
          ? 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute (or wait ≤15 min for release-trigger)'
          : null,
    });
  }

  // serving — P-003. Process truth, deliberately NOT derived from git. This is the
  // stage that separates "the bytes are on disk at the right sha" from "the process
  // answering requests has executed them", and it is the ONLY stage that can say
  // `past`. A change is live when BOTH are true: the code reached this host's source
  // (the deploy, for a release-checkout host — already `na` for a working-tree host,
  // which reads the tree directly) AND the process started after the code changed.
  const sv = p.serving;
  const codeReachedHost = releaseApplies ? p.positions.deployed : true;
  const servingHealth: StageHealth =
    sv.startedSinceCodeChange === false ? 'stalled' : sv.startedSinceCodeChange === true ? 'advancing' : 'unknown';
  const servingDetail = ((): string | null => {
    if (sv.startedSinceCodeChange === false) {
      const src =
        sv.codeAsOfSource === 'deploy'
          ? 'the last deploy'
          : sv.codeAsOfSource === 'file-mtime'
            ? 'this file changing on disk'
            : 'the code changing';
      return (
        `The process serving this code (${sv.unit}, pid ${sv.pid}) started ~${sv.behindMin}m BEFORE ${src} — ` +
        `it is executing an OLDER snapshot, so "deployed" here does NOT mean "running". ` +
        `Waiting cannot fix this; it takes a restart: ${sv.restartLever}.`
      );
    }
    if (sv.startedSinceCodeChange === null) {
      return sv.unknownReason;
    }
    if (!codeReachedHost) {
      // The process is current, but MY change hasn't reached its source yet — the
      // deployed stage owns that, so don't editorialise here.
      return null;
    }
    return `${sv.unit} (pid ${sv.pid}) started after the code it runs last changed, so it has actually loaded it.`;
  })();
  stages.push({
    name: 'serving',
    position: codeReachedHost && sv.startedSinceCodeChange === true ? 'past' : 'pending',
    health: servingHealth,
    detail: servingDetail,
    // A restart is the lever ONLY once the code has actually reached this host — offering
    // it while the deploy is still pending would restart the process onto the SAME old
    // code and read as "I did the thing and nothing changed" (EI-11120's shape).
    lever: codeReachedHost && sv.startedSinceCodeChange === false ? sv.restartLever : null,
  });

  return stages;
}

/**
 * P-005: the single next lever, and which stage owns it.
 *
 * `stages[]` gives six position×health readings; this answers the question a caller
 * actually arrives with — "is my change live, and if not what is the ONE thing blocking
 * it". That task cost 11 tool calls and 4 hand-diffs on 2026-07-26 and still went wrong
 * twice, because deciding WHICH of six stages owns the next move was left to the reader.
 *
 * The first `pending` stage in source→live order is the blocker: stages are ordered, and
 * a later stage cannot advance until an earlier one has. `na` stages are skipped — they
 * are not on this change's route, so they can never block it.
 *
 * THE THREE STATES ARE DISTINCT, and collapsing any two is the bug this must not have:
 *   blockedOn null, nextAction null  → nothing is pending; the change is live.
 *   blockedOn set,  nextAction null  → blocked, and WAITING IS CORRECT (a healthy leg
 *                                      between ticks). Inventing a lever here is worse
 *                                      than none: it manufactures busywork and, for the
 *                                      push/deploy legs, an unnecessary forced run.
 *   blockedOn set,  nextAction set   → blocked, and here is the one thing to do.
 */
export function deriveBlocker(stages: StageState[]): {
  blockedOn: StageName | null;
  nextAction: string | null;
} {
  const blocking = stages.find((s) => s.position === 'pending');
  if (!blocking) return { blockedOn: null, nextAction: null };
  return { blockedOn: blocking.name, nextAction: blocking.lever };
}

export interface PipelinePositionDeps {
  git?: GitRunner;
  loadDeploy?: () => Promise<DevDeployState>;
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  /**
   * P-003: when a systemd unit's main process started. Injected by TESTS only —
   * the default really probes (D-001). A null-by-default dep here would leave the
   * 4x-filed "deployed != running" gap unfixed while looking implemented, which is
   * the ship-it-dark failure this plan exists to avoid.
   */
  probeUnitStart?: (unit: string) => Promise<{ pid: number | null; startedAtMs: number | null } | null>;
  /** P-003: mtime (ms) of a repo-relative file — what a working-tree tsx host would load. */
  fileMtimeMs?: (absPath: string) => Promise<number | null>;
  /**
   * P-004: the two gate candidates (in-flight run + what a fresh launch would judge).
   * Injected by TESTS only — the default really reads systemd + git, for the same
   * reason `probeUnitStart` does: a null-by-default dep would ship the containment
   * check dark while looking implemented.
   */
  resolveGateCandidates?: (root: string) => Promise<GateCandidates>;
}

/**
 * Default gate-candidate resolution: the SAME functions `release:checkpoint-run`
 * itself uses, so this surface and that tool can never disagree about which commit
 * is being judged — a disagreement between them would recreate the exact
 * false-confidence this check exists to remove.
 *
 * Imported lazily: `release-checkpoint-launch` pulls in spawnSync/systemctl plumbing
 * that a sha-only or submodule probe never needs, and this module is on the hot path
 * of `dev:pipeline_position`.
 */
const realResolveGateCandidates = async (root: string): Promise<GateCandidates> => {
  try {
    const { checkActiveCheckpointRun, currentCheckpointCandidate } = await import('./release-checkpoint-launch');
    const { spawnSync } = await import('node:child_process');
    const execFn = (cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const active = checkActiveCheckpointRun(root, execFn);
    // checkActiveCheckpointRun ALREADY resolves the quiet-cut candidate internally (it
    // spreads `...current` into its result) whenever a run is active — only pay for the
    // second resolution when it did not, or this hot path (CLAUDE.md points agents here
    // for "is my edit live") runs the same 4-5 git reads twice per call.
    const nextCandidateSha =
      active.current_candidate !== undefined
        ? active.current_candidate
        : currentCheckpointCandidate(root, execFn).current_candidate;
    return {
      // Only a genuinely ACTIVE run has a judging sha. `current_candidate` describes a
      // HYPOTHETICAL fresh launch and must never be reported as "what is being judged"
      // (EI-18695275971973546 cost a wrong fleet-wide broadcast to that exact conflation).
      judgingSha: active.active ? (active.candidate ?? null) : null,
      nextCandidateSha,
    };
  } catch {
    return { judgingSha: null, nextCandidateSha: null };
  }
};

/** Default unit-start probe: the shared systemd probe, mapped into ms. */
const realProbeUnitStart = async (unit: string): Promise<{ pid: number | null; startedAtMs: number | null } | null> => {
  const info = await probeServiceStart(unit);
  if (!info.ok || info.secondsSinceStart === undefined) return null;
  return { pid: info.mainPid ?? null, startedAtMs: Date.now() - info.secondsSinceStart * 1000 };
};

/** Default file-mtime reader. Fail-soft: an unreadable path is UNKNOWN, never 0. */
const realFileMtimeMs = async (absPath: string): Promise<number | null> => {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * EI-18715870370005934: resolve the GITLINK a superproject commit pins for a
 * submodule — `git ls-tree <superSha> <submodulePath>` => `160000 commit <sha>`.
 *
 * This is the half of the check that nobody hand-composes correctly. A
 * superproject commit does NOT contain submodule file content, only a gitlink,
 * so every naive cross-boundary probe (`git show <superSha>:<submodulePath>`,
 * `git status --porcelain <submodulePath>`, `git log -- <submodulePath>`)
 * returns EMPTY — which reads as "absent" / "clean" rather than "wrong question".
 * The failure mode is an ABSENCE THAT READS AS EVIDENCE, and both wrong answers
 * are the safe-sounding ones, so they compose into a confident false negative
 * ("my instrumentation isn't in this build — abort the run").
 */
async function resolveSubmodulePin(
  git: GitRunner,
  root: string,
  superSha: string,
  submodulePath: string,
): Promise<string | null> {
  const out = await git(root, ['ls-tree', superSha, submodulePath]);
  if (!out) return null;
  const m = /^160000\s+commit\s+([0-9a-f]{7,40})\b/.exec(out.trim());
  return m ? m[1] : null;
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
/**
 * P-003: what the summary is allowed to say after `deployed ✓`.
 *
 * This used to be an unconditional ` (live)` derived from `positions.deployed` —
 * a GIT fact stating a PROCESS conclusion. That one word is the thing four agents
 * independently filed: it reads as "your change is running" when the serving
 * process may have booted long before the deploy and still be executing older
 * code. Never claim "live" without process evidence.
 */
function servingNote(p: Pick<PipelinePosition, 'positions' | 'serving'>): string {
  const sv = p.serving;
  if (sv.startedSinceCodeChange === false) {
    return ` ⚠ but NOT LIVE — ${sv.unit} has been up ~${sv.behindMin}m longer than the code it serves (still running the older snapshot; ${sv.restartLever})`;
  }
  if (!p.positions.deployed) return '';
  if (sv.startedSinceCodeChange === true) return ' (live — the serving process started after this code landed)';
  return ' (deployed, but whether the serving process has loaded it is UNKNOWN — not confirmed live)';
}

/**
 * P-005: the lead clause — the answer to "is my change live, and if not what is the one
 * thing blocking it", placed FIRST because that is the question the caller arrived with.
 *
 * Everything after it is supporting evidence. The old summary opened with a row of ticks,
 * which is a state DUMP: correct, complete, and leaving the reader to work out which of
 * six positions owns their next move. That derivation is exactly what went wrong twice on
 * 2026-07-26.
 */
function leadClause(p: Omit<PipelinePosition, 'summary'>): string {
  if (!p.blockedOn) return '';
  const label = p.blockedOn.toUpperCase();
  return p.nextAction ? `BLOCKED AT ${label} → ${p.nextAction}. ` : `WAITING AT ${label} (nothing to do — this leg is advancing on its own). `;
}

export function summarizePosition(p: Omit<PipelinePosition, 'summary'>): string {
  const tick = (b: boolean) => (b ? '✓' : '✗');
  const label = p.input.path ?? p.input.sha ?? '(none)';
  if (!p.targetSha) {
    return `${label}: no commit found${p.dirtyUncommitted ? ' (uncommitted edits present, not yet committed)' : ''}.`;
  }
  const subj = p.targetSubject ? ` "${p.targetSubject.slice(0, 60)}"` : '';
  const dirty = p.dirtyUncommitted ? ' ⚠ +uncommitted edits' : '';

  // WI-5440: a path with MULTIPLE consumers on different activation routes —
  // naming only one (the old single-`runtime` behavior) can confidently route
  // an activation decision the WRONG way for whichever consumer isn't named.
  // Lead with the split itself; per-consumer detail lives in `runtimes`.
  if (p.runtimes && p.runtimes.length > 1) {
    const hosts = p.runtimes.map((r) => r.host).join(' + ');
    return `${label} @${p.targetShortSha}${subj}: MULTIPLE CONSUMERS on different activation routes (${hosts}) — see \`runtimes\` for each one's own host + activation; do not assume a single deploy or restart activates ALL of them.${dirty}`;
  }

  // EI-10895: for a path the release pipeline does NOT carry, the deploy ticks are
  // not just noise — a `deployed ✗` reads as "still stuck in the pipeline" and sends
  // the agent off to wait for a deploy that can never activate the code. Lead with
  // the ACTIVATION instead, and demote the git ticks to what they actually mean here
  // (durability + peer visibility, not liveness).
  if (p.runtime && !p.runtime.releasePipelineApplies) {
    // P-003: for a working-tree host the ONLY question that matters is whether it
    // has restarted since this file changed — the git ticks cannot answer it, and
    // this is the exact shape of the bg-host-runs-stale-routine-code class.
    const sv = p.serving;
    const live =
      sv.startedSinceCodeChange === false
        ? ` ⚠ RUNNING STALE: ${sv.unit} started ~${sv.behindMin}m before this file last changed on disk, so the host is still executing the OLD version — ${sv.restartLever}.`
        : sv.startedSinceCodeChange === true
          ? ` ✓ ${sv.unit} started after this file last changed, so the running host has loaded it.`
          : '';
    // EI-18752644493166307: the parenthetical below used to end at "even an uncommitted
    // edit is what it loads on restart" — true for the RESTART consumer, and read by an
    // agent as blanket permission to fire the gate dirty. The green-checkpoint is a
    // SECOND consumer of the same file and judges a COMMITTED candidate, so for IT an
    // uncommitted edit is invisible. One reassurance, two consumers, opposite answers:
    // qualify it rather than letting the true half cover the false one.
    const gateBlind = p.dirtyUncommitted
      ? ' ⚠ but the GREEN GATE is a different consumer of this same file and judges a COMMITTED candidate — your uncommitted edit is INVISIBLE to it, so a gate run fired now tests the code WITHOUT it (commit first: git-sync:run).'
      : '';
    return `${label} @${p.targetShortSha}${subj}: runs in ${p.runtime.host} — NOT carried by the staging→main→:3070 deploy.${live} ${
      p.runtime.activation
    } (git position: committed ${tick(p.positions.committedLocal)} · staging ${tick(
      p.positions.onStaging,
    )}${dirty} — durability/peer-visibility only; the running host reads THIS TREE, so even an uncommitted edit is what it loads on restart.)${gateBlind}`;
  }

  if (p.submodule) {
    // EI-18715870370005934: when the reported sha is NOT the sha the caller asked
    // about (they passed a superproject commit; we resolved its gitlink), say so
    // in the one line most readers stop at — a silent substitution here is the
    // same confidently-wrong reading this fix exists to prevent.
    const pin = p.submodulePin
      ? ` — superproject ${p.submodulePin.superprojectSha.slice(0, 9)} PINS submodule commit ${p.submodulePin.submoduleSha.slice(0, 9)}; positions are for the PINNED commit, not the superproject one (the superproject holds only a gitlink, so \`git show\`/\`git status\` on this path from the root return empty and read as "absent"/"clean")`
      : '';
    return `${label} @${p.targetShortSha}${subj} [submodule ${p.submodule}]: committed ${tick(
      p.positions.committedLocal,
    )} · pushed-to-origin ${tick(p.positions.onStaging)}${dirty} — superproject→main→deploy chain not tracked for submodule paths.${pin}`;
  }
  // EI-18719549079738452: a torn git-sync candidate (impl + its matching fixture
  // landing as two separate commits) can red a scheduled run whose failure does
  // not reproduce at tip — the retriage machinery (green-checkpoint.ts's
  // classifyRedAgainstTip) recognizes this and works to auto-refire, but while
  // that plays out `gate.consecutiveReds` reads 0 / `gate.stalled` reads false
  // (the LAST *recorded* verdict was clean, or none has landed yet this cycle) —
  // so the three branches above all fall through to '', and the summary reads
  // as fully healthy while `main` sits behind the latest green pin. That silent
  // combination is what turned a bounded, self-healing retriage window into an
  // invisible ~2h stall on 2026-07-26 (the incident this note is named for) —
  // nothing in the one-line summary told a reader "green" and "not advancing"
  // were BOTH true at once. Name the combination instead of staying silent on it.
  const gateNote = !p.positions.inMain && p.gate.fireStale
    ? ` (green gate WEDGED — not firing: ${p.gate.fireStaleReason ?? 'stale'})`
    : !p.positions.inMain && p.gate.stalled
      ? ` (green gate STALLED: ${p.gate.consecutiveReds} reds)`
      : !p.positions.inMain && p.gate.consecutiveReds > 0
        ? ` (gate red: ${p.gate.consecutiveReds})`
        : !p.positions.inMain && p.gate.consecutiveReds === 0 && p.verdictProvenance.mainFastForwarded === false
          ? ` (gate reports 0 reds, but main has NOT fast-forwarded to the last green pin ${
              p.verdictProvenance.lastGreenShortSha ?? '?'
            } — may be an in-flight retriage/refire or another hold consecutiveReds doesn't capture; not necessarily broken, but don't read this as fully healthy)`
          : '';
  // P-004: when the judged candidate provably lacks this file's content, that outranks
  // every tick above it — the ticks describe where the change IS, this describes whether
  // the verdict about to land is even about it. Appended last so it is the final thing
  // read, which is where a caller stops.
  const candidateNote =
    p.changeInCandidate.judgingContainsPath === false || p.changeInCandidate.nextContainsPath === false
      ? ` ⚠ ${p.changeInCandidate.detail}`
      : '';
  return `${leadClause(p)}${label} @${p.targetShortSha}${subj}: committed ${tick(p.positions.committedLocal)} · staging ${tick(
    p.positions.onStaging,
  )} · main ${tick(p.positions.inMain)}${gateNote} · deployed ${tick(p.positions.deployed)}${servingNote(
    p,
  )}${dirty}.${candidateNote}`;
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
  let submodulePin: PipelinePosition['submodulePin'] = null;
  if (inp.sha) {
    targetSha = (await git(gitDir, ['rev-parse', '--verify', `${inp.sha}^{commit}`])) ?? null;
    // EI-18715870370005934: a submodule path given with a SUPERPROJECT sha (the
    // overwhelmingly common case — "is my change in the build at <gate sha>?",
    // where the only sha an agent has is the superproject's). That sha does not
    // exist in the submodule's object store, so the rev-parse above fails and we
    // used to report `targetSha: null` + "did not resolve" — a bare ABSENCE, from
    // the very tool CLAUDE.md points agents at for "is my edit live". Resolve the
    // gitlink instead and report the pinned submodule commit, which is what the
    // caller actually meant.
    if (!targetSha && submodule) {
      const pinned = await resolveSubmodulePin(git, root, inp.sha, submodule);
      if (pinned) {
        targetSha = pinned;
        submodulePin = { superprojectSha: inp.sha, submoduleSha: pinned };
        notes.push(
          `'${inp.sha}' is a SUPERPROJECT commit and does not exist inside submodule '${submodule}' — ` +
            `resolved its gitlink instead: that superproject commit PINS submodule commit ${pinned.slice(0, 12)}, ` +
            `and all positions below are reported for that pinned commit. ` +
            `Hand-rolled equivalents (\`git show ${inp.sha.slice(0, 12)}:${submodule}/<file>\`, ` +
            `\`git status --porcelain ${submodule}/<file>\`) return EMPTY here and read as "absent"/"clean" — ` +
            `they are the wrong question, not a negative answer. To inspect content: ` +
            `\`git -C ${submodule} show ${pinned.slice(0, 12)}:<path-inside-submodule>\`.`,
        );
      }
    }
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
      // EI-18694888339365359: the local ref said "not present" — before believing
      // that (and letting a caller block/park on it), check the actual remote tip
      // via ls-remote (no fetch, no local mutation). If the target IS the current
      // remote tip, the local ref was simply stale; correct the verdict rather
      // than emitting a false block that sends an agent to await a push event
      // that already fired.
      if (!positions.onStaging && (await isExactRemoteTip(git, root, 'refs/heads/staging', targetSha))) {
        positions.onStaging = true;
        notes.push(
          'The local origin/staging ref was stale (git-sync had not yet fetched this push); ' +
            'confirmed via `git ls-remote` (no local mutation) that the target commit IS the ' +
            'current remote tip, so onStaging was corrected to true.',
        );
      }
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
  const runtimes = classifyRuntimeOwners(inp.path ?? null);
  const runtime = runtimes ? runtimes[0] : null;
  if (runtimes && runtimes.length > 1) {
    notes.push(
      `This path has ${runtimes.length} distinct consumers on DIFFERENT activation routes (${runtimes
        .map((r) => r.host)
        .join(' + ')}) — see \`runtimes\` for each one's own host/activation; do not act on \`runtime\`/\`activation\` alone.`,
    );
  }
  const caveat = runtime?.releasePipelineApplies ? sharedHostCaveat(inp.path ?? null) : null;
  if (caveat) notes.push(caveat);

  // P-003: process truth for the serving stage. WHICH moment we compare the process
  // start against depends on how its host receives code, and getting that wrong
  // inverts the answer:
  //   - a RELEASE-CHECKOUT host (:3070) gets code at DEPLOY time;
  //   - a WORKING-TREE tsx host (bg-host / gateway / embed-sidecar) imports the file
  //     itself, so the file's own mtime is what a restart would pick up — committed
  //     or not, which is why an uncommitted edit is already "the code" for those.
  const servingUnit = runtime ? SERVING_UNIT_BY_HOST[runtime.host] : null;
  let servingProcess: { pid: number | null; startedAtMs: number | null } | null = null;
  if (servingUnit) {
    servingProcess = await (deps.probeUnitStart ?? realProbeUnitStart)(servingUnit);
  }
  let codeAsOfMs: number | null = null;
  let codeAsOfSource: 'deploy' | 'file-mtime' | null = null;
  if (runtime && servingUnit) {
    if (runtime.releasePipelineApplies) {
      codeAsOfMs = deploy.deployedAtMs ?? null;
      codeAsOfSource = 'deploy';
    } else if (inp.path) {
      codeAsOfMs = await (deps.fileMtimeMs ?? realFileMtimeMs)(path.join(root, inp.path.replace(/^\.?\//, '')));
      codeAsOfSource = 'file-mtime';
    }
  }
  const serving = evaluateServing({ runtime, process: servingProcess, codeAsOfMs, codeAsOfSource });
  if (serving.startedSinceCodeChange === false) {
    notes.push(
      `SERVING STALE CODE: ${serving.unit} (pid ${serving.pid}) started ~${serving.behindMin}m before the code it runs last changed. A git-derived "deployed" does not mean this process is running your change — ${serving.restartLever}`,
    );
  }

  // P-004: is the commit the gate judges even this file's code? Scoped to a
  // SUPERPROJECT path: the gate judges the superproject, which stores only a gitlink
  // for a submodule, so a blob comparison across that boundary compares nothing (the
  // same absence-reads-as-evidence trap resolveSubmodulePin exists for). Saying
  // "unknown" there is the honest answer; a false `true` would be the dangerous one.
  let changeInCandidate: ChangeInCandidate = NO_CHANGE_IN_CANDIDATE;
  if (relPath && !submodule) {
    const candidates = await (deps.resolveGateCandidates ?? realResolveGateCandidates)(root);
    const shas = [candidates.judgingSha, candidates.nextCandidateSha].filter((s): s is string => !!s);
    const gitRead = gitReadForRepo(git, root);
    const byShaEntries = await Promise.all(
      [...new Set(shas)].map(
        async (sha) => [sha, (await classifyPathsAgainstCandidate(gitRead, sha, [relPath]))[0]] as const,
      ),
    );
    const bySha = new Map(byShaEntries);
    changeInCandidate = evaluateChangeInCandidate({
      relPath,
      candidates,
      judging: candidates.judgingSha ? (bySha.get(candidates.judgingSha) ?? null) : null,
      next: candidates.nextCandidateSha ? (bySha.get(candidates.nextCandidateSha) ?? null) : null,
    });
    if (changeInCandidate.judgingContainsPath === false || changeInCandidate.nextContainsPath === false) {
      notes.push(`CANDIDATE DOES NOT CONTAIN THIS FILE: ${changeInCandidate.detail}`);
    }
  } else if (relPath && submodule) {
    changeInCandidate = {
      ...NO_CHANGE_IN_CANDIDATE,
      detail:
        'Containment is not measured for a submodule path: the gate judges the SUPERPROJECT, which stores only a gitlink for this submodule. ' +
        'Whether your change is in the judged build depends on the PIN the superproject candidate carries — check that the superproject has committed the bumped gitlink.',
    };
  }

  // Everything computeStages needs, before the stage table — and before deriveBlocker,
  // which reads that table to pick blockedOn/nextAction.
  const preStages: Omit<PipelinePosition, 'summary' | 'stages' | 'blockedOn' | 'nextAction'> = {
    input: { path: inp.path ?? null, sha: inp.sha ?? null },
    repoRoot: root,
    submodule,
    submodulePin,
    targetSha,
    targetShortSha,
    targetSubject,
    dirtyUncommitted,
    positions,
    verdictProvenance,
    deployedSha,
    gate,
    gitSyncLastStatus: snap.gitSync.lastStatus,
    // Defensive by intent, not to appease a fixture: `snap.gitSync` is parsed out of
    // free-form routine METADATA, so any of these can legitimately be absent on an
    // older/partial row. A diagnostic surface that throws when a field is missing is
    // strictly worse than one that reports a benign default — an agent trying to find
    // out why its change is stuck must never be answered with a TypeError.
    gitSync: {
      status: snap.gitSync?.lastStatus ?? null,
      lastSyncedAtMs: snap.gitSync?.lastSyncedAtMs ?? null,
      syncAgeMs:
        snap.gitSync?.lastSyncedAtMs === null || snap.gitSync?.lastSyncedAtMs === undefined
          ? null
          : Date.now() - snap.gitSync.lastSyncedAtMs,
      consecutiveErrorTicks: snap.gitSync?.consecutiveErrorTicks ?? 0,
      pushedRepos: snap.gitSync?.lastPushed ?? [],
      mergedRepos: snap.gitSync?.lastMerged ?? [],
      conflicts: snap.gitSync?.lastConflicts ?? [],
      errors: snap.gitSync?.lastErrors ?? [],
    },
    runtime,
    runtimes,
    serving,
    changeInCandidate,
    notes,
  };
  const stages = computeStages(preStages);
  const base: Omit<PipelinePosition, 'summary'> = { ...preStages, stages, ...deriveBlocker(stages) };
  return { ...base, summary: summarizePosition(base) };
}
