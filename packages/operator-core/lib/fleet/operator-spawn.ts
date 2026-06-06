/**
 * fleet/operator-spawn — the operator→agent spawn engine over the durable nursery
 * (Brief 4, agent-briefs-2026-06-05; findings folded into
 * autoloop-pot-operator-rebuild-2026-06-05).
 *
 * The one spawn path the operator (chat `<spawn>` tag, the `fleet:spawn` tool, and
 * any future admin trigger) goes through:
 *
 *   resolveProject(harness) → recordSpawn (harness_shared.spawned_agents)
 *     → spawnInvokeOnce in the background → finishSpawn on exit.
 *
 * Replaces the dead POST /api/plugins/orchestrator/spawn dispatch (the
 * @papercupai/orchestrator-spawn plugin is not installed, so its projected HTTP
 * path 404s and its tracking lived in a plugin-local in-memory Map that
 * fleet:tree could not see). Tracking here is the SAME durable nursery the
 * fleet:* tools read — what's spawned appears in fleet:tree immediately and the
 * row transitions running→done/failed when the child exits.
 *
 * Resolution failures are recorded as status='failed' nursery rows (with the
 * error in error_message) rather than dropped — the old path's silent
 * fire-and-forget 404 is exactly the failure mode this module removes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnce } from '../dbos/orchestrator-runner';
import { buildPipelineExtraEnv } from '../dbos/orchestrator-spawn-env';
import { recordSpawn, finishSpawn } from './spawn-tree';
import {
  heartbeatSpawns,
  reclaimOrphanedSpawns,
  SPAWN_HEARTBEAT_INTERVAL_MS,
} from './spawn-reclaim';
import { getCachedRateLimitConfig } from '../rate-limit-config';

/**
 * The deterministic SAFETY-FLOOR ceiling on concurrently-running spawns — the
 * single fleet-wide number, NOT a per-path allocator (P-007). Folds the old
 * hardcoded operator-spawn cap (`MAX_CONCURRENT_SPAWNS=10`) and the orchestrator
 * dispatch cap into ONE configurable value: `operator:rate_limit_config`'s
 * `maxSimultaneousAgents` (default 16, live-editable, clamped ≤ RATE_LIMIT_MAX_CEILING).
 * The governor's global gate + the orchestrator dispatch ceiling + the await pump
 * already read this same number, so every spawn path now draws from one ledger.
 * This is the absolute hard backstop; the WORTH-IT allocation is the brain's call
 * (P-005), informed by `getSpawnHeadroom`.
 */
export function spawnConcurrencyCeiling(): number {
  return getCachedRateLimitConfig().maxSimultaneousAgents;
}

/**
 * The live limit/headroom the brain consults before deciding whether a spawn is
 * worth it (P-007): the unified ceiling, how many slots are in use right now, and
 * the remaining headroom. Reclaims orphaned rows first so the count reflects live
 * spawns only. This is the read the brain-as-allocator (P-005) is fed.
 */
export async function getSpawnHeadroom(workspaceId: string): Promise<{
  ceiling: number;
  running: number;
  headroom: number;
}> {
  await reclaimOrphanedSpawns(getOrgPg().sql).catch(() => undefined);
  const ceiling = spawnConcurrencyCeiling();
  const running = await countRunning(workspaceId).catch(() => 0);
  return { ceiling, running, headroom: Math.max(0, ceiling - running) };
}

/**
 * In-process abort handles for spawns THIS host launched, keyed by spawnId
 * (EI-40). `fleet:cancel` flips the durable rows + releases locks/claims; this
 * is the other half — actually SIGTERM/SIGKILL the running child so a cancelled
 * spawn stops making edits instead of running to INVOKE_TIMEOUT. Only this
 * host's live spawns are here; spawns on another operator process aren't — those
 * are reclaimed by the P-011 heartbeat-staleness sweep (`reclaimOrphanedSpawns`):
 * a host that dies stops heartbeating, and its 'running' rows are freed once
 * stale so they stop poisoning the concurrency ceiling.
 */
const localSpawnAborts = new Map<string, AbortController>();

/**
 * Heartbeat loop (P-011): while this host has live spawns, bump their
 * `heartbeat_at` every SPAWN_HEARTBEAT_INTERVAL_MS so the reclaim sweep can tell
 * a live spawn from one whose host died. Lazily started on the first spawn and
 * self-stopping when the last local spawn finishes. `unref`'d so it never holds
 * the process open.
 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function ensureSpawnHeartbeatLoop(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const ids = [...localSpawnAborts.keys()];
    if (ids.length === 0) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    void heartbeatSpawns(getOrgPg().sql, ids).catch(() => {
      /* best-effort — a missed beat at worst risks an early reclaim, which is
         itself recoverable (an autonomous spawn re-runs; an interactive one is
         the human's to relaunch). */
    });
  }, SPAWN_HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

/**
 * Abort a locally-tracked running spawn (SIGTERM → SIGKILL). Returns true when a
 * live local handle was found and signalled. Called by the fleet:cancel tool for
 * each cancelled spawn id after the durable subtree flip.
 */
export function abortLocalSpawn(spawnId: string): boolean {
  const ctrl = localSpawnAborts.get(spawnId);
  if (!ctrl) return false;
  try { ctrl.abort(); } catch { /* already aborted */ }
  return true;
}

export interface OperatorSpawnInput {
  workspaceId: string;
  /** Registry slug of the harness to spawn into. Optional ONLY when the
   *  workspace has exactly one registered harness (it becomes the default). */
  harness?: string | null;
  /** Child agent role (AGENT_ROLES or a plugin-namespaced role). */
  role: string;
  featureId?: string | null;
  chunkId?: string | null;
  /** Queen-authored brief: the situational overlay the bee is MISSING. P-060. */
  brief?: string | null;
  /** Extra KEY=value positional args for the child invoke. */
  extras?: string[];
  /** Lineage: the spawning turn/agent. Recorded as parent_spawn_id. */
  parentSpawnId?: string | null;
  /** Role of the spawner (default 'operator'). */
  parentRole?: string;
  planSlug?: string | null;
  itemId?: string | null;
}

export interface OperatorSpawnResult {
  ok: boolean;
  /** Set on ok AND on recorded failures (the failed nursery row's id). */
  spawnId: string | null;
  harness: string | null;
  projectDir: string | null;
  error: string | null;
}

/** Walk up to the nearest `.git` ancestor (mirrors locks/coordination-domain.ts). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** The child's file-lock coordination domain: realpath repo root of its project. */
function lockDomainFor(projectDir: string): string {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  try { return realpathSync(findRepoRoot(projectDir)); } catch { return findRepoRoot(projectDir); }
}

function newSpawnId(): string {
  return `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function countRunning(workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Record a spawn attempt that failed BEFORE a child process existed (unknown
 * harness, role validation, cap). Durable visibility for what used to be a
 * silent console.warn — the row shows in fleet:tree / the Brew tab with the
 * reason in error_message.
 */
async function recordFailedAttempt(
  input: OperatorSpawnInput,
  error: string,
): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const spawnId = newSpawnId();
    await recordSpawn(sql, {
      spawnId,
      workspaceId: input.workspaceId,
      harnessSlug: input.harness ?? null,
      parentSpawnId: input.parentSpawnId ?? null,
      parentRole: input.parentRole ?? 'operator',
      childRole: input.role || '(missing)',
      runId: `opspawn-${Date.now()}`,
      featureId: input.featureId ?? null,
      chunkId: input.chunkId ?? null,
      planSlug: input.planSlug ?? null,
      itemId: input.itemId ?? null,
      sessionOwner: spawnId,
      status: 'running', // recordSpawn has no terminal-insert; flip immediately below
    });
    await finishSpawn(sql, {
      spawnId,
      workspaceId: input.workspaceId,
      status: 'failed',
      errorMessage: error,
    });
    return spawnId;
  } catch (err) {
    console.error(`[operator-spawn] failed to record failed attempt: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Spawn one agent of `role` into the named harness's project dir, tracked in the
 * durable nursery. Returns immediately after the child process is launched
 * (fire-and-forget); the background completion flips the row to done/failed.
 */
export async function spawnAgentInHarness(
  input: OperatorSpawnInput,
): Promise<OperatorSpawnResult> {
  const role = (input.role ?? '').trim();
  const fail = async (error: string): Promise<OperatorSpawnResult> => {
    console.error(`[operator-spawn] ${error}`);
    const spawnId = await recordFailedAttempt(input, error);
    return { ok: false, spawnId, harness: input.harness ?? null, projectDir: null, error };
  };

  // Role sanity: a known built-in or a plugin-namespaced role. A typo'd role
  // would otherwise burn a full agent boot before failing inside invoke-once.
  if (!role) return fail('spawn rejected: missing role');
  const knownRole = (AGENT_ROLES as readonly string[]).includes(role) || role.includes(':');
  if (!knownRole) {
    return fail(`spawn rejected: unknown role "${role}" — known roles: ${AGENT_ROLES.join(', ')}`);
  }
  if (role === 'worker' && !input.chunkId) {
    return fail('spawn rejected: role="worker" requires a chunk id (spawn a scoper first to chunk the feature)');
  }

  // Harness resolution. Explicit slug wins; with no slug, a single-harness
  // workspace has an unambiguous default. Anything else fails loud.
  let slug = (input.harness ?? '').trim();
  if (!slug) {
    try {
      const reg = await loadHarnessRegistry(input.workspaceId);
      if (reg.projects.length === 1) slug = reg.projects[0].slug;
      else {
        return fail(
          `spawn rejected: no harness named and ${reg.projects.length} are registered — pass harness=<slug> (registered: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'})`,
        );
      }
    } catch (err) {
      return fail(`spawn rejected: harness registry unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const project = await resolveProject(slug, input.workspaceId)
    ?? await resolveProject(slug); // cross-workspace safety net (matches harness routes)
  if (!project) {
    let registered = '';
    try {
      const reg = await loadHarnessRegistry(input.workspaceId);
      registered = reg.projects.map((p) => p.slug).join(', ') || '(none)';
    } catch { /* best-effort */ }
    return fail(`spawn rejected: harness "${slug}" is not a registered project (registered: ${registered})`);
  }
  if (!existsSync(project.path)) {
    return fail(`spawn rejected: harness "${slug}" project dir missing on disk: ${project.path}`);
  }

  // Reclaim orphaned rows (a host that died mid-spawn left 'running' rows that
  // never flip) BEFORE counting, so the ceiling reflects live spawns only and a
  // dead host's rows can never wedge it (P-011). Best-effort; the periodic sweep
  // is the backstop.
  await reclaimOrphanedSpawns(getOrgPg().sql).catch(() => undefined);

  // Global concurrency ceiling — the single deterministic safety floor (P-007),
  // read live from rate_limit_config (maxSimultaneousAgents); durable count holds
  // across restarts. This is the hard backstop, NOT the worth-it allocator (the
  // brain decides worth-it, informed by getSpawnHeadroom).
  const cap = spawnConcurrencyCeiling();
  const running = await countRunning(input.workspaceId).catch(() => 0);
  if (running >= cap) {
    return fail(`spawn rejected: ${running} spawns already running (fleet ceiling ${cap} — maxSimultaneousAgents) — wait or fleet:cancel one`);
  }

  const spawnId = newSpawnId();
  const runId = `opspawn-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const { sql } = getOrgPg();
  await recordSpawn(sql, {
    spawnId,
    workspaceId: input.workspaceId,
    harnessSlug: slug,
    parentSpawnId: input.parentSpawnId ?? null,
    parentRole: input.parentRole ?? 'operator',
    childRole: role,
    runId,
    featureId: input.featureId ?? null,
    chunkId: input.chunkId ?? null,
    planSlug: input.planSlug ?? null,
    itemId: input.itemId ?? null,
    // The child's coord/lock owner is its spawnId — the link fleet:cancel uses
    // to release its locks/claims transitively.
    sessionOwner: spawnId,
    coordinationDomain: lockDomainFor(project.path),
    status: 'running',
  });

  const extras = [...(input.extras ?? [])];
  if (input.featureId) extras.push(`FEATURE_ID=${input.featureId}`);
  if (input.chunkId) extras.push(`CHUNK_ID=${input.chunkId}`);
  const extraEnv = buildPipelineExtraEnv({
    harnessSlug: slug,
    idempotencyKey: runId,
    workspaceId: input.workspaceId,
  });
  // THE UMBILICAL (voice gap fix): thread the operator's durable `s-…` spawnId into
  // the child's env so invoke()/spawn-mcp bakes it as the signed MCP URL's STABLE
  // `client=` param. Without this the child minted a fresh random `spawnId` per boot
  // AND carried no `client`, so the operator's resolveAgentIdentity() found no
  // attributable coord identity and THREW on every coord:send / plans:set-status /
  // improvements:capture — the child's file edits landed but it was MUTE on coord.
  // The `s-…` id is the SAME owner recorded as `sessionOwner` on the spawned_agents
  // row, so a bee's coord messages, its file-lock owner, and fleet:cancel's release
  // target all line up. parentSpawnId carries lineage onto the child's MCP URL too.
  extraEnv.PAPERCUSP_SPAWN_ID = spawnId;
  if (input.parentSpawnId) extraEnv.PAPERCUSP_PARENT_SPAWN_ID = input.parentSpawnId;
  // P-050/P-060: thread the Queen brief through the invocation so the invoke-once
  // prompt path (invoke.ts → buildPrompt's `## Queen brief` section) injects it into
  // the bee's prompt. The brief rides in extraEnv as QUEEN_BRIEF; the child reads
  // process.env.QUEEN_BRIEF. (NOTE: the fleet:spawn child does NOT use
  // assembleRolePrompt — it goes through invoke-once → buildPrompt; an earlier
  // comment naming assembleRolePrompt was the mis-wiring the plan flagged.)
  if (input.brief) {
    extraEnv.QUEEN_BRIEF = input.brief;
  }

  // Register an abort handle so fleet:cancel can stop the child (EI-40).
  const abort = new AbortController();
  localSpawnAborts.set(spawnId, abort);
  ensureSpawnHeartbeatLoop();

  // Fire-and-forget: the spawn returns now; completion lands on the nursery row.
  void spawnInvokeOnce(project.path, role, extras, extraEnv, { signal: abort.signal })
    .then((r) =>
      finishSpawn(sql, {
        spawnId,
        workspaceId: input.workspaceId,
        // An aborted child (fleet:cancel) exits non-zero; record it as cancelled,
        // not failed, when the abort was the cause.
        status: abort.signal.aborted ? 'cancelled' : (r.exitCode === 0 ? 'done' : 'failed'),
        exitCode: r.exitCode,
        errorMessage: r.exitCode === 0 ? null : (r.stderr || '').slice(-2000) || null,
        outputTail: (r.output || '').slice(-2000) || null,
      }),
    )
    .catch((err) =>
      finishSpawn(sql, {
        spawnId,
        workspaceId: input.workspaceId,
        status: abort.signal.aborted ? 'cancelled' : 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }).catch(() => { /* PG down — nothing left to record to */ }),
    )
    .finally(() => { localSpawnAborts.delete(spawnId); });

  return { ok: true, spawnId, harness: slug, projectDir: project.path, error: null };
}
