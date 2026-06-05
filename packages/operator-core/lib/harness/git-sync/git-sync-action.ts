/**
 * The `system:git-sync` routine action (git-sync-auto-commit P-005/P-009/P-010/P-012).
 * Registered into the system-action registry; the routines engine runs it inline as
 * one durable DBOS step per due git-sync routine.
 *
 * Wraps the pure pipeline (`run-git-sync.ts`) with the live concerns:
 *   - P-009 LOCKS: hold `git-sync` (exclusive) + `libs-papercusp-submodule`
 *     (exclusive) for the whole commit→submodule-push→pointer-bump→push sequence,
 *     so a peer agent's in-flight git work doesn't race. Held by a peer → skip this
 *     tick (back-pressure). SU-lock infra unavailable → proceed unlocked (the engine's
 *     per-routine dedup already prevents git-sync racing itself; rollout is gated).
 *   - P-010 ESCALATION: on a merge conflict, write a `git-sync-conflict` row to
 *     `harness_escalations` (the tree is already clean — the pipeline aborts the merge).
 *   - P-012 RESOLVER: spawn a `merge-resolver` role via the invoke route, deduped on
 *     the open escalation (one resolver per harness). A clean sync clears the escalation.
 *   - Records `{ last_synced_at, last_status, head_sha }` onto the routine's metadata.
 */
import { getOrgPg } from '@papercusp/db-org';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { tryAcquireResource, tryReleaseResource } from '../../agent-tools/locks/su-lock-store';
import { loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTargetForEvent } from '../../blueprint/launch-blueprint';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { registerSystemAction, type SystemActionCtx } from '../routines/system-actions';
import { decideGitSyncEscalation, oversizedKey, type EscalationReason } from './git-sync-escalation';
import { runGitSync, type GitSyncConfig, type GitSyncOutcome, type RepoConflict, type RepoError, type ScopedOversized } from './run-git-sync';

const GIT_SYNC_OWNER = 'system:git-sync';
const LOCK_RESOURCES = ['git-sync', 'libs-papercusp-submodule'] as const;
const LOCK_TTL_SEC = 600;
const ESCALATION_PHASE = 'staging';
const ESCALATION_KIND = 'git-sync-conflict';
/** EI-18: repeated push failures / oversized-file exclusions — needs a human/agent,
 *  but is NOT a merge conflict (no resolver dispatch). */
const ESCALATION_ERROR_KIND = 'git-sync-error';
/** The event key the `merge-resolution` launch blueprint declares (its trigger). */
const CONFLICT_EVENT = 'git-sync:conflict';

/** Coord identity for git-sync's own broadcasts (mirrors service-health's). */
const GIT_SYNC_IDENTITY: AgentIdentity = {
  ownerId: 'system:git-sync',
  ownerLabel: 'git-sync',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

function configFromTrigger(triggerConfig: Record<string, unknown>): GitSyncConfig {
  return {
    push: triggerConfig.push !== false,
    pushSubmodules: triggerConfig.push_submodules !== false,
    branch: typeof triggerConfig.branch === 'string' ? triggerConfig.branch : undefined,
    remote: typeof triggerConfig.remote === 'string' ? triggerConfig.remote : undefined,
    maxBlobBytes: typeof triggerConfig.max_blob_bytes === 'number' ? triggerConfig.max_blob_bytes : undefined,
  };
}

type AcquireState = 'acquired' | 'held' | 'error';

async function releaseAll(cd: string, acquired: string[]): Promise<void> {
  for (const resource of acquired.reverse()) {
    try {
      await inWorkspaceTxn(cd, GIT_SYNC_OWNER, (tx) =>
        tryReleaseResource(tx, { coordinationDomain: cd, owner: GIT_SYNC_OWNER, resource }));
    } catch {
      /* best-effort: TTL reaps it anyway */
    }
  }
}

/** Acquire all LOCK_RESOURCES exclusively, or signal held/error (releasing partials). */
async function acquireLocks(cd: string, slug: string, acquired: string[]): Promise<AcquireState> {
  for (const resource of LOCK_RESOURCES) {
    let r: { ok: boolean; reason?: string };
    try {
      r = await inWorkspaceTxn(cd, GIT_SYNC_OWNER, (tx) =>
        tryAcquireResource(tx, {
          coordinationDomain: cd,
          resource,
          mode: 'exclusive',
          owner: GIT_SYNC_OWNER,
          ownerLabel: `git-sync:${slug}`,
          reason: `auto-commit ${slug}`,
          ttlSec: LOCK_TTL_SEC,
        }));
    } catch (e) {
      // SU-lock DB unreachable / not bootstrapped — proceed unlocked (best-effort).
      console.warn(`[git-sync] lock infra unavailable (${resource}): ${e instanceof Error ? e.message : e}`);
      await releaseAll(cd, acquired);
      acquired.length = 0;
      return 'error';
    }
    if (!r.ok) {
      // A peer holds it (or it's unregistered) — skip this tick, retry next.
      await releaseAll(cd, acquired);
      acquired.length = 0;
      return 'held';
    }
    acquired.push(resource);
  }
  return 'acquired';
}

/** How long a 'dispatched' resolver is presumed to still be running (route caps the
 *  agent at ~90s; give generous headroom before we'd re-dispatch). */
const RESOLVER_INFLIGHT_MS = 5 * 60_000;

/**
 * Whether a merge-resolver is GENUINELY in-flight for this harness — i.e. a dispatch
 * was recorded recently and hasn't settled. This replaces the old "is an escalation
 * open?" dedup, which permanently suppressed the resolver after a SILENT dispatch
 * failure (the escalation stayed open but nothing was ever working it). Now a failed/
 * settled/never-dispatched resolver re-dispatches on the next conflict tick.
 */
async function resolverInFlight(slug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: { status?: string; at?: number } | null }[]>`
    SELECT metadata->'last_resolver' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const lr = rows[0]?.lr;
  if (!lr || lr.status !== 'dispatched') return false; // never-run or already settled → retry
  return typeof lr.at === 'number' && Date.now() - lr.at < RESOLVER_INFLIGHT_MS;
}

async function writeGitSyncEscalation(slug: string, workspaceId: string, conflicts: RepoConflict[]): Promise<void> {
  const { sql } = getOrgPg();
  const scopes = conflicts.map((c) => c.scope);
  const body = JSON.stringify({
    kind: ESCALATION_KIND,
    harness_slug: slug,
    // Every (sub)repo that conflicted this pass — the escalation (UNIQUE per
    // harness+phase) carries them all so the resolver sees the full set.
    conflicts: conflicts.map((c) => ({ scope: c.scope, conflicted_files: c.conflictedFiles })),
    scope: scopes.join(', '),
    emitted_at: Date.now(),
    detail: `git-sync auto-merge conflicted in ${scopes.join(', ')}; trees aborted clean, merge-resolver dispatched.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/** Clear git-sync escalations of the given kinds after a clean sync (other kinds intact). */
async function clearGitSyncEscalation(slug: string, kinds: string[]): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.harness_escalations
        SET escalation = NULL, mtime_ms = $2
      WHERE harness_slug = $1 AND phase = $3
        AND escalation IS NOT NULL
        AND (escalation::jsonb ->> 'kind') = ANY($4)`,
    [slug, Date.now(), ESCALATION_PHASE, kinds],
  );
}

/**
 * EI-18: write/refresh the `git-sync-error` escalation (repeated push failures and/or
 * oversized-file exclusions). The (harness_slug, phase) row is SHARED with the
 * conflict escalation — the conditional DO UPDATE makes this a strict non-clobber:
 * an open `git-sync-conflict` (which a merge-resolver may be reading) always wins.
 */
async function writeGitSyncErrorEscalation(
  slug: string,
  workspaceId: string,
  info: { reasons: EscalationReason[]; consecutiveErrorTicks: number; errors: RepoError[]; oversized: ScopedOversized[] },
): Promise<void> {
  const { sql } = getOrgPg();
  const body = JSON.stringify({
    kind: ESCALATION_ERROR_KIND,
    harness_slug: slug,
    reasons: info.reasons,
    consecutive_error_ticks: info.consecutiveErrorTicks,
    errors: info.errors.map((e) => ({ scope: e.scope, message: e.message.slice(0, 500) })),
    oversized: info.oversized.map((f) => ({ scope: f.scope, path: f.path, size_bytes: f.sizeBytes })),
    emitted_at: Date.now(),
    detail:
      `git-sync needs attention: ${info.reasons.join(' + ')}` +
      (info.reasons.includes('push-failure') ? ` — push failed ${info.consecutiveErrorTicks} consecutive ticks (commits NOT reaching origin)` : '') +
      (info.oversized.length > 0 ? ` — ${info.oversized.length} oversized file(s) excluded from auto-commit (gitignore or remove them)` : ''),
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms
     WHERE harness_escalations.escalation IS NULL
        OR (harness_escalations.escalation::jsonb ->> 'kind') = $6`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId, ESCALATION_ERROR_KIND],
  );
}

/** Previous tick's EI-18 counters from the routine metadata. */
async function readEscalationCounters(slug: string): Promise<{ errTicks: number; oversizedKeys: string[] }> {
  const { sql } = getOrgPg();
  const rows = await sql<{ et: number; lo: string[] | null }[]>`
    SELECT coalesce((metadata->>'consecutive_error_ticks')::int, 0) AS et,
           array(SELECT jsonb_array_elements_text(coalesce(metadata->'last_oversized', '[]'::jsonb))) AS lo
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return { errTicks: rows[0]?.et ?? 0, oversizedKeys: rows[0]?.lo ?? [] };
}

/**
 * Spawn a merge-resolver role via the invoke route (P-012) — OBSERVABLY (GAP-2).
 *
 * The `/invoke` route is synchronous (runs the agent to completion, up to ~90s), so
 * we MUST NOT await it: git-sync holds the exclusive git-sync + submodule locks for
 * the whole handler. So this stays fire-and-forget — but it is no longer SILENT:
 *   1. a durable `last_resolver: { status:'dispatched', … }` marker is written FIRST
 *      (awaited), so the attempt is recorded even if the process restarts mid-run;
 *   2. the eventual result (HTTP status, agent exitCode/timedOut, or a network error)
 *      is recorded when the dangling promise settles — instead of vanishing into a
 *      `void … .catch(console.warn)` that went to uncaptured stdout.
 * Query `metadata->'last_resolver'` on the routine to see whether the resolver ran.
 */
async function spawnMergeResolver(slug: string, workspaceId: string, conflicts: RepoConflict[]): Promise<void> {
  // unify-agent-launches-as-blueprints D-002/D-004: the launch is now DECLARATIVE.
  // The `merge-resolution` launch blueprint declares `triggers.event:
  // git-sync:conflict` + its role (decider merge-resolver); we resolve the role +
  // invoke URL from it by the event key, instead of hardcoding `role=merge-resolver`.
  // The conflict DETECTION + the in-flight dedup (`last_resolver`) + the observe
  // loop below stay git-sync's concern — behavior-preserving.
  const target = await resolveLaunchTargetForEvent(CONFLICT_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONFLICT_EVENT}" — skipping merge-resolver dispatch`);
    return;
  }
  const { url } = target;
  const scopes = conflicts.map((c) => c.scope);
  const filesSummary = conflicts.map((c) => `${c.scope}: ${c.conflictedFiles.join(', ')}`).join('; ');
  const dispatchedAt = Date.now();

  // (1) durable "dispatched" marker, awaited — observable even if (2) is lost.
  await recordResolverDispatch(slug, { at: dispatchedAt, status: 'dispatched', scopes });

  // (2) async result recording. The /invoke route reads `extra` (forwarded to
  // invoke-once) — `kickoff` is for human readability only (the route ignores it);
  // the merge-resolver also reads the open escalation, which now lists every scope.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff: `Resolve the git-sync merge conflict(s) in ${scopes.join(', ')} (on main). Conflicted: ${filesSummary}`,
      extra: ['--git-sync-conflict', JSON.stringify({ scopes, files: filesSummary })],
      // A real multi-file merge by a higher-effort model needs more than the route's
      // 90s default; give it near the route's 300s ceiling (it waits on the git-sync
      // lock first, then does the merge).
      timeoutMs: 280_000,
    }),
  })
    .then(async (res) => {
      let exitCode: number | undefined;
      let timedOut: boolean | undefined;
      let detail = '';
      try {
        const j = (await res.json()) as { ok?: boolean; exitCode?: number; timedOut?: boolean; stderr?: string; decisionLine?: string };
        exitCode = j?.exitCode;
        timedOut = j?.timedOut;
        if (j?.ok === false) detail = (j.decisionLine || j.stderr || '').slice(0, 400);
        await recordResolverDispatch(slug, {
          at: dispatchedAt,
          status: res.ok && j?.ok !== false ? 'ok' : 'failed',
          httpStatus: res.status, exitCode, timedOut, detail,
        });
      } catch {
        await recordResolverDispatch(slug, { at: dispatchedAt, status: res.ok ? 'ok' : 'failed', httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] merge-resolver dispatch failed (${slug}): ${msg}`);
      await recordResolverDispatch(slug, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
    });
}

/** Record the merge-resolver dispatch lifecycle onto the routine metadata (GAP-2). */
async function recordResolverDispatch(slug: string, info: Record<string, unknown>): Promise<void> {
  try {
    await patchRoutineMetadata(slug, { last_resolver: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record resolver dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/** Merge a partial metadata patch onto the git-sync routine's JSONB. */
async function patchRoutineMetadata(slug: string, patch: Record<string, unknown>): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:git-sync'`,
    [slug, JSON.stringify(patch)],
  );
}

async function recordOutcome(slug: string, outcome: GitSyncOutcome, consecutiveErrorTicks: number): Promise<void> {
  const pushed = 'pushed' in outcome ? outcome.pushed : [];
  const merged = 'merged' in outcome ? outcome.merged : [];
  // errors[] exists on both 'conflict' and 'error' outcomes — record it ALWAYS so a
  // sibling (sub)repo error on a conflict tick isn't invisible (it was: a non-error
  // status used to drop the error list entirely, e.g. a libs/papercusp push failure
  // hidden behind a libs/generic/sync conflict).
  const errors = 'errors' in outcome ? outcome.errors : [];
  await patchRoutineMetadata(slug, {
    last_status: outcome.status,
    last_synced_at: Date.now(),
    last_pushed: pushed,
    last_merged: merged,
    last_conflicts: outcome.status === 'conflict' ? outcome.conflicts.map((c) => c.scope) : [],
    last_errors: errors.map((e) => `${e.scope}: ${e.message}`),
    // GAP-3: clear the stale single error on any non-error outcome (JSONB `||` keeps old keys).
    last_error: outcome.status === 'error' ? errors.map((e) => `${e.scope}: ${e.message}`).join('; ') : null,
    // EI-18 counters: ticks-of-uninterrupted-error + the oversized set (scope:path keys).
    consecutive_error_ticks: consecutiveErrorTicks,
    last_oversized: outcome.oversized.map(oversizedKey),
    ...(outcome.status === 'synced' ? { head_sha: outcome.headSha } : {}),
  });
}

/** The registered `system:git-sync` handler. */
async function handleGitSync(ctx: SystemActionCtx): Promise<void> {
  const { installSlug: slug, workspaceId } = ctx;
  const cfg = configFromTrigger(ctx.triggerConfig);
  const cd = workspaceId || '*';

  const acquired: string[] = [];
  const state = await acquireLocks(cd, slug, acquired);
  if (state === 'held') {
    console.log(`[git-sync] ${slug}: a peer holds git-sync/submodule locks — skipping this tick`);
    return;
  }
  // EI-18: previous tick's counters BEFORE this tick overwrites them.
  const prev = await readEscalationCounters(slug);

  // 'acquired' (locked) or 'error' (unlocked best-effort) → run.
  let outcome: GitSyncOutcome;
  try {
    outcome = await runGitSync(slug, { config: cfg });
  } finally {
    if (state === 'acquired') await releaseAll(cd, acquired);
  }

  const errTicks = outcome.status === 'error' ? prev.errTicks + 1 : 0;
  await recordOutcome(slug, outcome, errTicks);

  if (outcome.status === 'conflict') {
    // P-010/P-012: refresh the escalation (listing every conflicted scope) + dispatch
    // a resolver UNLESS one is genuinely in-flight. Sibling submodules still pushed (GAP-1).
    await writeGitSyncEscalation(slug, workspaceId, outcome.conflicts);
    if (!(await resolverInFlight(slug))) {
      const scopes = outcome.conflicts.map((c) => c.scope).join(', ');
      console.warn(`[git-sync] ${slug}: merge conflict(s) in ${scopes} — dispatching merge-resolver`);
      await spawnMergeResolver(slug, workspaceId, outcome.conflicts);
    }
  } else if (outcome.status === 'synced' || outcome.status === 'nothing') {
    // A clean pass means any prior conflict is resolved — clear the escalation.
    await clearGitSyncEscalation(slug, [ESCALATION_KIND]);
  }
  // status === 'error' (no conflict): leave any open conflict escalation untouched;
  // errors aren't merge conflicts and shouldn't trigger/clear the resolver.

  // EI-18: repeated push failures / oversized exclusions must be LOUD — a silent
  // metadata-only error once accumulated 20h of unpushable history. The escalation
  // row never clobbers an open conflict escalation (conditional upsert); the coord
  // broadcast fires on transitions only.
  const decision = decideGitSyncEscalation({
    status: outcome.status,
    consecutiveErrorTicks: errTicks,
    errors: 'errors' in outcome ? outcome.errors : [],
    oversized: outcome.oversized,
    prevOversizedKeys: prev.oversizedKeys,
  });
  if (decision.escalate) {
    await writeGitSyncErrorEscalation(slug, workspaceId, {
      reasons: decision.reasons,
      consecutiveErrorTicks: errTicks,
      errors: 'errors' in outcome ? outcome.errors : [],
      oversized: outcome.oversized,
    });
  } else if (decision.clear) {
    await clearGitSyncEscalation(slug, [ESCALATION_ERROR_KIND]);
  }
  if (decision.broadcast) {
    console.warn(`[git-sync] ${slug}: ${decision.broadcast}`);
    await sendMessage(GIT_SYNC_IDENTITY, { to: ['*'], summary: decision.broadcast, category: 'git-sync' }).catch(() => {});
  }
}

registerSystemAction('git-sync', handleGitSync);
