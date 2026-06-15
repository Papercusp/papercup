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
import { existsSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnce } from '../dbos/orchestrator-runner';
import { buildPipelineExtraEnv } from '../dbos/orchestrator-spawn-env';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { gatewaySpawnEnv } from '../inference-gateway/spawn-env';
import { selectSpawnAccount } from '../deployment/account-pool-store';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import { lockDomainForProjectDir } from '../agent-tools/locks/coordination-domain';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { assembleSpawnHydration } from './spawn-hydration';
import { listHiveRosterSnapshot, renderRosterSnapshot } from './hive-roster';
import { getSpawnHandoffContext } from '../handoff-context';
import { getWorkItemCheckpoint } from '../work-item-checkpoint';
import type { Db } from './pg-stores';
import {
  heartbeatSpawns,
  reclaimOrphanedSpawns,
  recordSpawnPid,
  SPAWN_HEARTBEAT_INTERVAL_MS,
} from './spawn-reclaim';
import { wakeParentOnChildDeath } from './parent-wake';
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
 * The wake key an over-ceiling spawn attempt sleeps on (D-004 — queue + await,
 * never silent-drop): `events:await { event: spawnSlotEventKey(ws) }`, end the
 * turn, retry the spawn on wake. Emitted whenever a slot frees — a spawn
 * completes (done/failed/cancelled) or the P-011 reclaim frees orphaned rows.
 * The wake is a BROADCAST to all waiters (they re-check the ceiling on retry;
 * the await pump's per-tick resume cap + per-subscriber coalescing keep a
 * mass-wake paced) — slot fairness is re-check-on-wake, not a granted ticket
 * like lock:grant.
 */
export function spawnSlotEventKey(workspaceId: string): string {
  return `spawn-slot:freed:${workspaceId}`;
}

/**
 * Memoized lazy import of the await engine — keeps this module's load graph
 * light (the engine pulls the coord/messages surface) and gives concurrent
 * announces ONE shared import promise (concurrent dynamic imports of the same
 * module can reject under the vitest module runner).
 */
let awaitEngine: Promise<typeof import('../events/await/engine')> | null = null;
const loadAwaitEngine = () => (awaitEngine ??= import('../events/await/engine'));

/**
 * Announce freed spawn capacity to over-ceiling waiters (best-effort, never
 * throws).
 */
async function announceSpawnSlotFreed(workspaceId: string, summary: string): Promise<void> {
  try {
    const { emitAwaitedEvent } = await loadAwaitEngine();
    await emitAwaitedEvent({
      key: spawnSlotEventKey(workspaceId),
      summary,
      source: 'operator-spawn',
      workspaceId,
    });
  } catch {
    /* best-effort — a missed announce just means waiters retry on their
       await timeout instead of the early wake */
  }
}

/**
 * Reclaim orphaned rows AND wake over-ceiling waiters in every workspace the
 * reclaim freed slots in (D-004). The reclaim itself stays the pure sql unit
 * (spawn-reclaim.ts); the announce rides this call-site wrapper.
 */
async function reclaimAndAnnounce(): Promise<void> {
  const r = await reclaimOrphanedSpawns(getOrgPg().sql).catch(
    () => ({ reclaimed: 0, spawnIds: [], workspaces: [] }),
  );
  // Rare (only when orphans were actually freed) — await so the announce lands
  // before the caller's cap check; announceSpawnSlotFreed never throws.
  await Promise.all(
    r.workspaces.map((ws) => announceSpawnSlotFreed(ws, `${r.reclaimed} orphaned spawn slot(s) reclaimed`)),
  );
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
  await reclaimAndAnnounce();
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
 * Per-spawn stream activity (liveness-hardening P-008): epoch-ms of the
 * latest stdout/stderr chunk each LOCAL spawn emitted (set by the runner's
 * onOutputActivity callback — in-process, no tee files) and the value last
 * persisted, so the heartbeat tick only stamps rows whose output actually
 * advanced. Entries die with the spawn (cleared beside localSpawnAborts).
 */
const localSpawnOutput = new Map<string, { at: number; persistedAt: number }>();

function noteSpawnOutput(spawnId: string): void {
  const e = localSpawnOutput.get(spawnId);
  if (e) e.at = Date.now();
  else localSpawnOutput.set(spawnId, { at: Date.now(), persistedAt: 0 });
}

/**
 * Wedge auto-reap threshold (P-010 / D-006, owner decision 2026-06-11): a bee
 * stream-silent this long is hung, not thinking — bees stream with
 * --include-partial-messages, so thinking deltas + tool_use events keep the
 * stream moving; the only legitimate long silence is awaiting a long local
 * tool call, which 30 minutes absorbs. Override: PAPERCUSP_WEDGE_REAP_MS.
 */
export const WEDGE_REAP_SILENT_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_WEDGE_REAP_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 30 * 60_000;
})();

/** Spawns currently being reaped — guards double-fire across ticks while the
 *  cancel + process death settle. */
const wedgeReapInFlight = new Set<string>();

/**
 * Pure candidate filter for the wedge reaper (exported for tests): tracked
 * local spawns with OBSERVED output whose stream has been silent past the
 * threshold, minus those already mid-reap. Never-output spawns are excluded —
 * absence of signal is not evidence of a wedge (mirrors isPossiblyWedged).
 */
export function selectWedgeReapCandidates(
  output: ReadonlyMap<string, { at: number }>,
  tracked: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
  now: number,
  silentMs: number = WEDGE_REAP_SILENT_MS,
): string[] {
  const out: string[] = [];
  for (const [id, e] of output) {
    if (tracked.has(id) && !inFlight.has(id) && e.at > 0 && now - e.at > silentMs) out.push(id);
  }
  return out;
}

/**
 * Reap local spawns that are wedged past the threshold (flag-gated, D-006):
 * the durable cancel (claims + locks released, coord notice — the SAME engine
 * as fleet:cancel) then the local process abort. Only spawns THIS host
 * supervises are candidates — the host that holds the handle owns the verdict.
 * Spawns with NO observed output are never reaped (absence ≠ wedge).
 */
async function reapWedgedLocalSpawns(now: number): Promise<void> {
  const candidates = selectWedgeReapCandidates(
    localSpawnOutput,
    new Set(localSpawnAborts.keys()),
    wedgeReapInFlight,
    now,
  );
  if (candidates.length === 0) return;
  if (!(await getFlag(FLAGS.WEDGE_AUTO_REAP, 'system'))) return;
  const { cancelSubtree } = await import('./nursery');
  const { sql } = getOrgPg();
  for (const spawnId of candidates) {
    wedgeReapInFlight.add(spawnId);
    try {
      const rows = await sql<{ workspace_id: string }[]>`
        SELECT workspace_id FROM harness_shared.spawned_agents
         WHERE spawn_id = ${spawnId} AND status IN ('running', 'restarting') LIMIT 1`;
      const workspaceId = rows[0]?.workspace_id;
      if (!workspaceId) continue; // already terminal — nothing to reap
      const silentMin = Math.round((now - (localSpawnOutput.get(spawnId)?.at ?? now)) / 60_000);
      console.warn(`[wedge-reap] ${spawnId}: stream silent ${silentMin}min with a live process — cancelling (D-006)`);
      await cancelSubtree(sql, {
        workspaceId,
        rootSpawnId: spawnId,
        reason: `wedge-reap: alive but stream-silent ${silentMin}min (> ${Math.round(WEDGE_REAP_SILENT_MS / 60_000)}min, D-006)`,
        actor: {
          ownerId: 'wedge-reaper',
          ownerLabel: 'system · wedge-reaper',
          source: 'signed-spawn',
          workspaceId,
          userId: null,
        },
      });
      abortLocalSpawn(spawnId);
    } catch (err) {
      console.warn(`[wedge-reap] ${spawnId} failed (will retry next tick):`, err);
      wedgeReapInFlight.delete(spawnId);
    }
  }
}

/**
 * Heartbeat loop (P-011): while this host has live spawns, bump their
 * `heartbeat_at` every SPAWN_HEARTBEAT_INTERVAL_MS so the reclaim sweep can tell
 * a live spawn from one whose host died. Lazily started on the first spawn and
 * self-stopping when the last local spawn finishes. `unref`'d so it never holds
 * the process open. The same tick stamps `last_output_at` for spawns whose
 * stream moved since the last persist (P-008 — zero extra write cadence).
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
    const outputAt = new Map<string, number>();
    for (const id of ids) {
      const e = localSpawnOutput.get(id);
      if (e && e.at > e.persistedAt) {
        outputAt.set(id, e.at);
        e.persistedAt = e.at;
      }
    }
    void heartbeatSpawns(getOrgPg().sql, ids, outputAt).catch(() => {
      /* best-effort — a missed beat at worst risks an early reclaim, which is
         itself recoverable (an autonomous spawn re-runs; an interactive one is
         the human's to relaunch). */
    });
    // P-010/D-006: same tick, after the beat — reap local spawns wedged past
    // the threshold (flag-gated inside; double-fire guarded).
    void reapWedgedLocalSpawns(Date.now()).catch(() => {
      /* best-effort — a failed reap retries next tick */
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
  /**
   * Per-spawn model escalation (queen-model-tier-selection-2026-06-11).
   * `tier` names an entry in the user-defined tier menu (AgentConfig.tiers,
   * default quick/standard/deep/max) — resolved + clamped to [role floor,
   * role ceiling] by resolveTierSpec. `modelSpec` is a direct
   * `<modelId>[:<effort>]` spec (operator/human escape hatch — NOT exposed to
   * the queen, whose lever is tier names only). When both are set, the
   * explicit spec wins. Unset → the role's standing resolution
   * (AGENT_MODELS → ROLE_MODEL_DEFAULTS → CLI default) applies unchanged.
   */
  tier?: string | null;
  modelSpec?: string | null;
  /** Extra KEY=value positional args for the child invoke. */
  extras?: string[];
  /** Optional per-spawn invoke timeout override (ms), threaded to
   *  spawnInvokeOnce (audit P-015 / EI-172). Unset → the runner's
   *  PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS default. */
  timeoutMs?: number | null;
  /** Lineage: the spawning turn/agent. Recorded as parent_spawn_id. */
  parentSpawnId?: string | null;
  /** Role of the spawner (default 'operator'). */
  parentRole?: string;
  planSlug?: string | null;
  itemId?: string | null;
  /**
   * Caller-supplied dedupe key (audit P-017, EI-73). A retry of the SAME
   * logical spawn (e.g. after a route timeout) passes the same key and gets
   * the original spawnId back (`deduped: true`) instead of a second agent.
   * Scoped per workspace; unique-indexed (migration 219).
   */
  idempotencyKey?: string | null;
}

export interface OperatorSpawnResult {
  ok: boolean;
  /** Set on ok AND on recorded failures (the failed nursery row's id). */
  spawnId: string | null;
  harness: string | null;
  projectDir: string | null;
  error: string | null;
  /** Set on an over-ceiling rejection: the wake key to sleep on (D-004 —
   *  `events:await { event: awaitEvent }`, end the turn, retry on wake). */
  awaitEvent?: string | null;
  /** True when idempotencyKey matched an existing spawn — `spawnId` is that
   *  original spawn; no new agent was launched (P-017/EI-73). */
  deduped?: boolean;
}

function newSpawnId(): string {
  return `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function countRunning(workspaceId: string, db?: Db): Promise<number> {
  const sql = db ?? getOrgPg().sql;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

export type SpawnAdmission =
  | { kind: 'admitted' }
  | { kind: 'duplicate'; spawnId: string }
  | { kind: 'over_cap'; running: number; cap: number };

/**
 * Atomic spawn admission (audit P-017 + P-039, EI-73): reclaim → idempotency
 * dedupe → cap count → record, in ONE transaction serialized per workspace by
 * an advisory xact lock. Closes two races the old
 * reclaim-then-count-then-insert sequence had under read-committed:
 *   • two concurrent spawns both read running<cap and both recorded
 *     (ceiling overshoot, P-039);
 *   • a route-timeout retry of the SAME logical spawn launched a second agent
 *     (EI-73) — a caller-supplied idempotencyKey now returns the original row
 *     instead. The partial unique index from migration 219 backstops the
 *     dedupe even outside this lock.
 *
 * `record` runs inside the transaction only when admission succeeds; it must
 * use the handed tx. Exported for the real-PG concurrency tests.
 */
export async function admitSpawn(
  sql: Sql,
  opts: {
    workspaceId: string;
    /** The spawn id `record` inserts — the idempotency key is stamped on it. */
    spawnId: string;
    idempotencyKey: string | null;
    cap: number;
    record: (tx: Db) => Promise<void>;
  },
): Promise<{ admission: SpawnAdmission; reclaimed: { count: number; workspaces: string[] } }> {
  let reclaimed = { count: 0, workspaces: [] as string[] };
  const admission = (await sql.begin(async (tx): Promise<SpawnAdmission> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`opspawn:${opts.workspaceId}`}))`;

    // Reclaim orphaned rows (a host that died mid-spawn left 'running' rows
    // that never flip) BEFORE counting, so the ceiling reflects live spawns
    // only and a dead host's rows can never wedge it (P-011). Announce is the
    // caller's job, AFTER commit.
    const r = await reclaimOrphanedSpawns(tx);
    reclaimed = { count: r.reclaimed, workspaces: r.workspaces };

    if (opts.idempotencyKey) {
      const dup = await tx<{ spawn_id: string }[]>`
        SELECT spawn_id FROM harness_shared.spawned_agents
         WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${opts.idempotencyKey}
         LIMIT 1`;
      if (dup.length > 0) return { kind: 'duplicate', spawnId: dup[0].spawn_id };
    }

    const running = await countRunning(opts.workspaceId, tx);
    if (running >= opts.cap) return { kind: 'over_cap', running, cap: opts.cap };

    await opts.record(tx);
    if (opts.idempotencyKey) {
      // Separate UPDATE so the recordSpawn input type stays untouched; same
      // transaction, so the key is never observable without the row.
      await tx`UPDATE harness_shared.spawned_agents
                  SET idempotency_key = ${opts.idempotencyKey}
                WHERE spawn_id = ${opts.spawnId}`;
    }
    return { kind: 'admitted' };
  })) as SpawnAdmission;
  return { admission, reclaimed };
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

  // Per-spawn model resolution (queen-model-tier-selection-2026-06-11): an
  // explicit spec wins; otherwise a tier name resolves against the user's
  // menu, clamped to [role floor, role ceiling]. Resolved BEFORE admission so
  // the spec/tier land on the nursery row (the queen's pick vs. the task's
  // outcome is the trust telemetry). An unknown tier fails loud — a typo'd
  // tier silently running at the default would be the EI-7 class of bug.
  let spawnModelSpec: string | null = (input.modelSpec ?? '').trim() || null;
  let spawnModelTier: string | null = null;
  let spawnModelBackend: string | null = null;
  if (!spawnModelSpec && input.tier && input.tier.trim()) {
    const [{ resolveTierSpec }, { readAgentConfig }] = await Promise.all([
      import('./model-tiers'),
      import('../agent-config'),
    ]);
    const cfg = await readAgentConfig().catch(() => null);
    const resolved = resolveTierSpec({
      tier: input.tier,
      role,
      tiers: cfg?.tiers,
      tierCeilings: cfg?.tierCeilings,
    });
    if (!resolved.ok) return fail(`spawn rejected: ${resolved.error}`);
    spawnModelSpec = resolved.spec;
    spawnModelTier = resolved.tier;
    spawnModelBackend = resolved.backend ?? null;
    if (resolved.note) console.log(`[operator-spawn] ${resolved.note}`);
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
  let project = await resolveProject(slug, input.workspaceId)
    ?? await resolveProject(slug); // cross-workspace safety net (matches harness routes)
  if (!project) {
    // EI-429: the Queen sometimes passes its SU MCP server slug ("<project>-su",
    // or the legacy "papercusp-su") as a spawn target instead of the project.
    // Remap a KNOWN -su MCP slug to its project — strip the "-su" suffix, aliasing
    // the legacy "papercusp-su" to the dogfood project "papercup". Deterministic
    // remap of the known MCP slugs ONLY, never a silent normalize of arbitrary slugs.
    const suBase = slug === 'papercusp-su' ? 'papercup' : /^(.+)-su$/.exec(slug)?.[1];
    if (suBase && suBase !== slug) {
      const remapped = (await resolveProject(suBase, input.workspaceId)) ?? (await resolveProject(suBase));
      if (remapped) {
        project = remapped;
        slug = remapped.slug;
      }
    }
  }
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

  const spawnId = newSpawnId();
  const runId = `opspawn-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const { sql } = getOrgPg();
  const idemKey = (input.idempotencyKey ?? '').trim() || null;

  // Atomic admission (audit P-017 + P-039, EI-73) — see admitSpawn.
  // Over-ceiling stays a QUEUE+AWAIT, not a silent drop (D-004): the result
  // carries the wake key the caller sleeps on.
  let admission: SpawnAdmission;
  let reclaimed: { count: number; workspaces: string[] };
  try {
    ({ admission, reclaimed } = await admitSpawn(sql, {
      workspaceId: input.workspaceId,
      spawnId,
      idempotencyKey: idemKey,
      cap: spawnConcurrencyCeiling(),
      record: (tx) =>
        recordSpawn(tx, {
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
          modelSpec: spawnModelSpec,
          modelTier: spawnModelTier,
          // Persist the brief (mig 230): the dock's brief-pane shows "what
          // started this agent" long after the QUEEN_BRIEF env is gone.
          brief: input.brief ?? null,
          // The child's coord/lock owner is its spawnId — the link
          // fleet:cancel uses to release its locks/claims transitively.
          sessionOwner: spawnId,
          coordinationDomain: lockDomainForProjectDir(project.path),
          status: 'running',
        }),
    }));
  } catch (err) {
    return fail(
      `spawn admission failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Announce reclaimed slots AFTER commit (the announce wakes waiters who
  // immediately re-count — they must see our committed admission).
  await Promise.all(
    reclaimed.workspaces.map((ws) =>
      announceSpawnSlotFreed(ws, `${reclaimed.count} orphaned spawn slot(s) reclaimed`),
    ),
  );

  if (admission.kind === 'duplicate') {
    console.log(
      `[operator-spawn] idempotent replay: key "${idemKey}" already spawned ${admission.spawnId} — not spawning again (EI-73)`,
    );
    return {
      ok: true,
      spawnId: admission.spawnId,
      harness: slug,
      projectDir: project.path,
      error: null,
      deduped: true,
    };
  }
  if (admission.kind === 'over_cap') {
    const awaitEvent = spawnSlotEventKey(input.workspaceId);
    const res = await fail(
      `spawn rejected: ${admission.running} spawns already running (fleet ceiling ${admission.cap} — maxSimultaneousAgents). ` +
      `Do not drop or busy-wait: events:await { event: "${awaitEvent}" }, end your turn, and retry this spawn on wake (a slot-free wakes you) — or fleet:cancel one.`,
    );
    return { ...res, awaitEvent };
  }

  // P-016/D-007: claude bees get a forced native session id, recorded here so the
  // unified hive-tabs bee pane can attach `claude --resume <session_id>` (P-004).
  // resolveSpawnBackendModel predicts the backend buildInvokeOnce will run (reads
  // AGENT_CMD/AGENT_MODELS for the role); omp resumes by thread id + codex by
  // rollout, so they mint none. The UPDATE is best-effort — a not-yet-migrated DB
  // (session_id from mig 203) must never break a spawn.
  const { backend } = resolveSpawnBackendModel(role, spawnModelSpec ?? undefined, spawnModelBackend ?? undefined);
  const forceSessionId = backend === 'claude-code' ? randomUUID() : undefined;
  if (forceSessionId) {
    try {
      await sql`UPDATE harness_shared.spawned_agents SET session_id = ${forceSessionId} WHERE spawn_id = ${spawnId}`;
    } catch (e) {
      console.warn(
        `[operator-spawn] record session_id failed (mig 203 pending?): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // queen-autonomy P-112: route the per-spawn model-tier choice through the
  // disposition log (agent-lifecycle, reversible — the next spawn can differ).
  // Fire-and-forget + flag-gated; a ledger miss must never break a spawn.
  void (async () => {
    try {
      const { recordProactiveDisposition } = await import('../decision-ledger/disposition');
      const links: Record<string, unknown> = { spawnId, runId };
      if (input.featureId) links.featureId = input.featureId;
      if (input.chunkId) links.chunkId = input.chunkId;
      if (input.parentSpawnId) links.parentSpawnId = input.parentSpawnId;
      await recordProactiveDisposition({
        workspaceId: input.workspaceId,
        harnessSlug: slug,
        decisionInput: { action: 'fleet:spawn', riskTier: 'low', authority: 'system', reversibility: 'reversible' },
        why: `model tier ${spawnModelTier ?? 'default'} for ${role}`,
        links,
        metadata: { modelTier: spawnModelTier ?? null, modelSpec: spawnModelSpec ?? null, role },
        actorRole: input.parentRole ?? 'operator',
        actorSpawnId: input.parentSpawnId ?? null,
      });
    } catch {
      /* never break a spawn on a ledger miss */
    }
  })();

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

  // directed-wake-honesty-and-spawn-handoff P-021/P-012: assemble the ONE bounded
  // spawn/wake-hydration block (predecessor handoff + hive-roster snapshot +
  // work-item carry-note) and thread it via extraEnv.SPAWN_HANDOFF. invoke.ts reads
  // it and buildPrompt renders it VERBATIM in the volatile tail (`## Handoff`). This
  // is the AUTONOMOUS spawn path's call of the shared seam (the interactive launch
  // calls assembleSpawnHydration from bootstrap-role). Gated on
  // SPAWN_HANDOFF_HYDRATION (default on). FAIL-SOFT TWICE: each source degrades to
  // empty inside assembleSpawnHydration, and this outer guard means a hydration
  // failure (flag read, DB hiccup) NEVER blocks the spawn.
  try {
    if (await getFlag(FLAGS.SPAWN_HANDOFF_HYDRATION, 'system')) {
      const hydration = await assembleSpawnHydration({
        harness: slug,
        featureId: input.featureId ?? undefined,
        planSlug: input.planSlug ?? undefined,
        // The bee resumes the work-item it was dispatched on; its carry-note is
        // keyed by that id (work-item-checkpoint store).
        workItemId: input.featureId ?? input.itemId ?? undefined,
        workspaceId: input.workspaceId,
        ownerId: spawnId,
        deps: {
          getHandoff: ({ harness, featureId, planSlug, workspaceId }) =>
            featureId
              ? getSpawnHandoffContext({ harness, featureId, planSlug, workspaceId })
              : Promise.resolve(null),
          getRoster: async ({ harness, workspaceId }) =>
            renderRosterSnapshot(await listHiveRosterSnapshot({ hiveSlug: harness, workspaceId })),
          getCheckpoint: ({ harness, workItemId, workspaceId }) =>
            getWorkItemCheckpoint({ harness, workItemId, workspaceId }),
        },
        log: (m) => console.log(`[operator-spawn] ${spawnId} ${m}`),
      });
      if (hydration.text) extraEnv.SPAWN_HANDOFF = hydration.text;
    }
  } catch (err) {
    // fail-soft: hydration is additive context, never a spawn blocker.
    console.warn(
      `[operator-spawn] ${spawnId}: spawn-handoff hydration failed (degraded, spawn continues): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Per-spawn model escalation: buildInvokeOnce reads this to apply `--model`/
  // `--effort` to THIS child's command (outranking AGENT_MODELS + the committed
  // default), and the child's own invoke.ts resolveModel consults it first —
  // covering the aiBackend agentCmd-swap path the command-level append can't reach.
  if (spawnModelSpec) {
    extraEnv.PAPERCUSP_SPAWN_MODEL = spawnModelSpec;
  }
  // Per-tier backend: buildInvokeOnce swaps the base command to this backend's
  // default and pins the child's AGENT_BACKEND to match.
  if (spawnModelBackend) {
    extraEnv.PAPERCUSP_SPAWN_BACKEND = spawnModelBackend;
  }

  // P-012 (hive-inference-gateway): when the INFERENCE_GATEWAY flag is ON (default OFF),
  // point this bee at the localhost pacing gateway (ANTHROPIC_BASE_URL=127.0.0.1:<port>) so
  // it egresses through ONE bound account paced against the unified 5h/7d budget (D-009)
  // instead of bursting blind. The bee keeps its ~/.claude credential symlink (the gateway
  // strips + reinjects auth), so flag-OFF instantly reverts to direct egress. Fails CLOSED:
  // if the gateway service is down the bee's request is refused rather than bursting direct.
  // P-004 (multi-credential routing): when INFERENCE_GATEWAY_MULTI_ACCOUNT is ALSO on, pin this bee
  // to a cache-affinity pool account (sticky → harness-pin → headroom) via ANTHROPIC_CUSTOM_HEADERS,
  // so its per-credential conversation cache survives. Fail-soft: any error → no header → the gateway
  // routes to its active() account (today's single-credential behavior).
  const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  let routeAccountId: string | undefined;
  if (gwOn && (await getFlag(FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT, 'system'))) {
    routeAccountId = await selectSpawnAccount(input.workspaceId, slug).catch(() => undefined);
  }
  Object.assign(extraEnv, gatewaySpawnEnv(gwOn, { accountId: routeAccountId }));

  // Register an abort handle so fleet:cancel can stop the child (EI-40).
  const abort = new AbortController();
  localSpawnAborts.set(spawnId, abort);
  ensureSpawnHeartbeatLoop();

  // Fire-and-forget: the spawn returns now; completion lands on the nursery row.
  let finalStatus: 'done' | 'failed' | 'cancelled' | null = null;
  void spawnInvokeOnce(project.path, role, extras, extraEnv, {
    signal: abort.signal,
    forceSessionId,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    // EI-85: record the child OS pid + this host so the reclaim sweep can
    // /proc-liveness-check the process instead of mislabeling a stale-heartbeat
    // row (host briefly paused) as a dead child. Best-effort — a missed write
    // just degrades to the heartbeat-stale reclaim.
    onChildPid: (pid) => {
      void recordSpawnPid(getOrgPg().sql, spawnId, pid).catch(() => {});
    },
    // P-008: per-chunk stream signal, persisted by the heartbeat tick.
    onOutputActivity: () => noteSpawnOutput(spawnId),
  })
    .then((r) => {
      finalStatus = abort.signal.aborted ? 'cancelled' : (r.exitCode === 0 ? 'done' : 'failed');
      return finishSpawn(sql, {
        spawnId,
        workspaceId: input.workspaceId,
        status: finalStatus,
        exitCode: r.exitCode,
        errorMessage: (r.stderr || '').slice(-2000) || null,
        outputTail: (r.output || '').slice(-2000) || null,
      });
    })
    .catch((err) => {
      finalStatus = abort.signal.aborted ? 'cancelled' : 'failed';
      return finishSpawn(sql, {
        spawnId,
        workspaceId: input.workspaceId,
        status: finalStatus,
        errorMessage: err instanceof Error ? err.message : String(err),
      }).catch(() => { /* PG down — nothing left to record to */ });
    })
    .finally(() => {
      localSpawnAborts.delete(spawnId);
      localSpawnOutput.delete(spawnId);
      // The terminal flip above freed a ceiling slot — wake any over-ceiling
      // waiter sleeping on the slot key (D-004). Best-effort, off the hot path.
      void announceSpawnSlotFreed(input.workspaceId, `spawn ${spawnId} finished — ceiling slot freed`);
      // EI-108: Wake parent on child death (if the spawn has a parent)
      if (finalStatus) {
        void wakeParentOnChildDeath(sql, spawnId, input.workspaceId, finalStatus).catch(() => {
          /* best-effort — logged inside wakeParentOnChildDeath */
        });
      }
    });

  return { ok: true, spawnId, harness: slug, projectDir: project.path, error: null };
}
