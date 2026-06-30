/**
 * The `system:git-sync` routine action (git-sync-auto-commit P-005/P-009/P-010/P-012).
 * Registered into the system-action registry; the routines engine runs it inline as
 * one durable DBOS step per due git-sync routine.
 *
 * Wraps the pure pipeline (`run-git-sync.ts`) with the live concerns:
 *   - P-009 LOCKS (git-sync-any-hive P-006: per-slug): hold `git-sync:<slug>`
 *     (exclusive, auto-registered on first acquire) + every name in the routine's
 *     `trigger_config.extra_lock_resources` (exclusive, must be human-registered)
 *     for the whole commit→submodule-push→pointer-bump→push sequence, so a peer
 *     agent's in-flight git work doesn't race. Held by a peer → skip this tick
 *     (back-pressure). An UNREGISTERED extra resource → skip with a loud log (a
 *     deliberate coordination surface — never auto-registered). SU-lock infra
 *     unavailable → proceed unlocked (the engine's per-routine dedup already
 *     prevents git-sync racing itself; rollout is gated).
 *   - RUNTIME GATE (git-sync-any-hive P-008, action half): before anything else,
 *     a routine row pointing at a hive home / remote-hive view / non-local
 *     deployment / vanished or non-git checkout NO-OPS with a logged reason and a
 *     `last_status: 'skipped'` metadata patch instead of error-escalating.
 *   - P-010 ESCALATION: on a merge conflict, write a `git-sync-conflict` row to
 *     `harness_escalations` (the tree is already clean — the pipeline aborts the merge).
 *   - P-012 RESOLVER: spawn a `merge-resolver` role via the invoke route, deduped on
 *     the open escalation (one resolver per harness). A clean sync clears the escalation.
 *   - Records `{ last_synced_at, last_status, head_sha }` onto the routine's metadata.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from '../../agent-tools/locks/contention-retry';
import { tryAcquireResource, tryReleaseResource } from '../../agent-tools/locks/su-lock-store';
import { agentsForScopedFiles, type AttributionRosterEntry } from './git-sync-attribution';
import { loadHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTargetForEvent } from '../../blueprint/launch-blueprint';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { registerSystemAction, type SystemActionCtx } from '../routines/system-actions';
import { gitSyncEligibility, type GitSyncEligibility } from './git-sync-eligibility';
import { decideGitSyncEscalation, oversizedKey, type EscalationReason } from './git-sync-escalation';
import { appendPipelineEvent } from './pipeline-events';
import { runGitSync, type GitSyncConfig, type GitSyncOutcome, type RepoConflict, type RepoError, type ScopedOversized, type ScopedContentError } from './run-git-sync';
import { parsePapercuspTrailers, recordCommitAttribution, type CommitAttributionRow } from '../../edit-attribution';

const GIT_SYNC_OWNER = 'system:git-sync';
const LOCK_TTL_SEC = 600;
/**
 * The `harness_escalations` row key for ALL git-sync escalations is
 * `(harness_slug, 'git-sync')` — a CONSTANT phase, deliberately NOT the lifecycle
 * phase ('staging'/'testing'/'production') and NOT the routine's branch
 * (git-sync-any-hive P-007, B-05 decision):
 *   - branch-derived phases would orphan an open escalation whenever the routine's
 *     branch changes (the clear-on-clean-pass UPDATE would target a different row),
 *     and would collide with the lifecycle-phase namespace;
 *   - the old constant 'staging' SHARED its row with other phase='staging' writers
 *     (auto-rebase's rebase_conflict, brainstorm) — they clobbered each other via
 *     ON CONFLICT DO UPDATE. A git-sync-owned phase ends that.
 * Consumer audit (2026-06-12): every reader is phase-loose for git-sync rows —
 * `git-pipeline-stats.ts` filters by kind='git-sync-conflict' only; the
 * `harness:escalation` tool / `getEscalation` (harness-readers.ts — the
 * merge-resolver's read path) selects by slug ordered by mtime_ms with no phase
 * filter; the improvements watchdog collectors filter by workspace only. The one
 * phase-keyed reader (`device-harnesses.ts`, joining on the harness's lifecycle
 * status phase) reads LIFECYCLE escalations — git-sync rows moving out of it is
 * intended. Open rows were migrated 'staging' → 'git-sync' in db migration 237.
 */
const ESCALATION_PHASE = 'git-sync';
const ESCALATION_KIND = 'git-sync-conflict';
/** EI-18: repeated push failures / oversized-file exclusions — needs a human/agent,
 *  but is NOT a merge conflict (no resolver dispatch). */
const ESCALATION_ERROR_KIND = 'git-sync-error';
/** The event key the `merge-resolution` launch blueprint declares (its trigger). */
const CONFLICT_EVENT = 'git-sync:conflict';

/**
 * EI-438 content guard (git-sync-content-guard-2026-06-13 P-004/P-005). Broken
 * files (an .mdx that won't compile, a curly quote used as code) are quarantined
 * from the auto-commit by the content guard (run-git-sync) so they never reach
 * `staging`; the action layer escalates them + dispatches a `content-fixer`.
 *
 * Content escalations get their OWN phase ('git-sync-content'), a SEPARATE row
 * from the conflict/error escalation (phase 'git-sync') — so a content quarantine
 * and a merge conflict coexist + clear independently, never clobbering each other
 * on the single (harness_slug, phase) row. The content-fixer reads its files from
 * the `--git-sync-content-error` extra (below), not this row, so the phase-loose
 * `getEscalation` (mtime-ordered) reader can never feed it the wrong escalation.
 */
const CONTENT_ESCALATION_PHASE = 'git-sync-content';
const CONTENT_ERROR_KIND = 'git-sync-content-error';
/** The event key the `content-fix` launch blueprint declares (its trigger). */
const CONTENT_ERROR_EVENT = 'git-sync:content-error';
/** After this many consecutive ticks with the file STILL broken, stop auto-dispatching
 *  the content-fixer and surface to a human (P-005: never an infinite silent fix loop).
 *  The file stays quarantined regardless, so `staging` is never at risk. */
const MAX_CONTENT_FIXER_ATTEMPTS = 5;

/** Coord identity for git-sync's own broadcasts (mirrors service-health's). */
const GIT_SYNC_IDENTITY: AgentIdentity = {
  ownerId: 'system:git-sync',
  ownerLabel: 'git-sync',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** The action-level knobs parsed from the routine's `trigger_config`: the pure
 *  pipeline config plus the lock surface (which never reaches `runGitSync`). */
interface ActionTrigger {
  config: GitSyncConfig;
  /**
   * Additional REGISTERED resource names to hold exclusively for the tick
   * (`trigger_config.extra_lock_resources`, git-sync-any-hive P-006). papercup's
   * row lists `['git-sync', 'libs-papercusp-submodule']` so the documented
   * back-off protocol ("acquire exclusive(git-sync) to make git-sync back off")
   * keeps working. Names here are a deliberate, human-registered coordination
   * surface — an UNKNOWN name skips the tick with a log, never auto-registers.
   */
  extraLockResources: string[];
}

function configFromTrigger(triggerConfig: Record<string, unknown>): ActionTrigger {
  const extras = Array.isArray(triggerConfig.extra_lock_resources)
    ? triggerConfig.extra_lock_resources.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  return {
    config: {
      push: triggerConfig.push !== false,
      pushSubmodules: triggerConfig.push_submodules !== false,
      branch: typeof triggerConfig.branch === 'string' ? triggerConfig.branch : undefined,
      remote: typeof triggerConfig.remote === 'string' ? triggerConfig.remote : undefined,
      maxBlobBytes: typeof triggerConfig.max_blob_bytes === 'number' ? triggerConfig.max_blob_bytes : undefined,
    },
    extraLockResources: extras,
  };
}

/** The per-harness lock resource this slug's tick holds (P-006). One global name
 *  used to serialize ALL harnesses' ticks against each other; now each harness
 *  serializes only against itself + whatever it lists in extra_lock_resources. */
const gitSyncResourceName = (slug: string): string => `git-sync:${slug}`;

/** Minimal tagged-template seam over the txn handle (postgres-js `Sql`), so this
 *  module needs no direct `postgres` type dependency. */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Idempotently register the per-slug `git-sync:<slug>` resource (inside the SAME
 * inWorkspaceTxn as the acquire that follows). Without this, an unregistered name
 * makes `tryAcquireResource` return `{ ok:false, reason:'unknown_resource' }`,
 * which used to read as "held" → a PERMANENT silent no-op on any harness whose
 * name nobody had hand-registered. Modeled on sql/008-register-git-sync-resource.sql
 * (no register helper is exported from @papercusp/locks). ON CONFLICT DO NOTHING:
 * a human-edited row is never clobbered. ONLY the per-slug name is auto-registered —
 * extra_lock_resources names must already exist in the registry.
 */
export async function registerGitSyncResource(tx: SqlTag, slug: string): Promise<void> {
  const resource = gitSyncResourceName(slug);
  const description =
    `The automated git-sync pipeline for harness "${slug}" (commit + submodule push + merge + push to origin). ` +
    'Concurrent git-sync runs, or a run racing a peer\'s manual git work on this checkout, race the index/refs.';
  const ruleText =
    `The system:git-sync routine action holds exclusive(${resource}) for the whole ` +
    'commit -> submodule-push -> pointer-bump -> push sequence. A peer doing manual whole-tree git work in this ' +
    `harness's checkout can acquire exclusive(${resource}) to make its git-sync back off that tick.`;
  await tx`
    INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns)
    VALUES (${resource}, ${description}, ${ruleText}, 'advisory', ARRAY[]::text[])
    ON CONFLICT (resource) DO NOTHING
  `;
}

type AcquireState = 'acquired' | 'held' | 'error';
interface AcquireOutcome {
  state: AcquireState;
  /** The resource that blocked the acquisition (state 'held'). */
  blockedOn?: string;
  /** The store's refusal reason (state 'held') — 'unknown_resource' means the
   *  name isn't registered, not that a peer holds it. */
  blockedReason?: string;
}

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

// EI-1720 + worker-fire-path zombie spawns: the lock-acquire contention retry
// (acquireWithContentionRetry / isWorkspaceContended) now lives in the shared
// locks module (also used by file-lock-guard). Re-exported so the existing
// git-sync-action suite keeps importing acquireWithContentionRetry from here.
export { acquireWithContentionRetry } from '../../agent-tools/locks/contention-retry';

/** Acquire `git-sync:<slug>` (auto-registered) + every extra resource exclusively,
 *  or signal held/error (releasing partials). */
async function acquireLocks(cd: string, slug: string, resources: string[], acquired: string[]): Promise<AcquireOutcome> {
  const perSlug = gitSyncResourceName(slug);
  for (const resource of resources) {
    let r: { ok: boolean; reason?: string };
    try {
      // EI-1720: retry-with-backoff on a TRANSIENT pg 57014/55P03 so a load-driven
      // workspace-lock contention spike delays — but does not multi-minute-stall —
      // the commit, instead of skipping the tick outright.
      r = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, GIT_SYNC_OWNER, async (tx) => {
          // Auto-register ONLY the per-slug name, in the same txn as its acquire.
          if (resource === perSlug) await registerGitSyncResource(tx as SqlTag, slug);
          return tryAcquireResource(tx, {
            coordinationDomain: cd,
            resource,
            mode: 'exclusive',
            owner: GIT_SYNC_OWNER,
            ownerLabel: `git-sync:${slug}`,
            reason: `auto-commit ${slug}`,
            ttlSec: LOCK_TTL_SEC,
          });
        }));
    } catch (e) {
      // Reaching here on contention means the load window outlasted the retries
      // (the next tick retries); otherwise it's SU-lock DB unreachable / not
      // bootstrapped — proceed unlocked (best-effort).
      const contended = isWorkspaceContended(e);
      console.warn(
        `[git-sync] lock ${contended ? 'contended after retries' : 'infra unavailable'} (${resource}): ${e instanceof Error ? e.message : e}`,
      );
      await releaseAll(cd, acquired);
      acquired.length = 0;
      return { state: 'error' };
    }
    if (!r.ok) {
      // A peer holds it (or an extra name is unregistered) — skip this tick, retry next.
      await releaseAll(cd, acquired);
      acquired.length = 0;
      return { state: 'held', blockedOn: resource, blockedReason: r.reason };
    }
    acquired.push(resource);
  }
  return { state: 'acquired' };
}

/** The /invoke timeout for a merge-resolver run: it drains+takes the git-sync
 *  lock (≤120s) then merges, all within this ceiling. Used BOTH as the invoke
 *  `timeoutMs` AND as the floor the in-flight TTL must clear — one source of
 *  truth so the two can never drift apart. */
const RESOLVER_INVOKE_TIMEOUT_MS = 900_000;
/** Margin past the invoke timeout before a 'dispatched' marker is presumed stale —
 *  covers settle-recording latency + clock skew. */
const RESOLVER_INFLIGHT_MARGIN_MS = 5 * 60_000;
/** How long a 'dispatched' resolver is presumed to still be running before we'd
 *  re-dispatch (P-010). DERIVED from the invoke timeout (+ margin) so it ALWAYS
 *  exceeds it — a still-running resolver is never double-dispatched on the next
 *  conflict tick (git-sync-dx-hardening P-009: the audit's "TTL ≤ timeout" would
 *  have INVERTED this invariant and double-dispatched; the real fix is making the
 *  two constants one derivation, not free-floating magic numbers). Instance-tagging
 *  already re-dispatches a restart-orphaned run immediately; this TTL is only the
 *  backstop for a same-process run whose settle-recording never fires. */
const RESOLVER_INFLIGHT_MS = RESOLVER_INVOKE_TIMEOUT_MS + RESOLVER_INFLIGHT_MARGIN_MS;

/**
 * This operator process incarnation (P-006). The merge-resolver dispatch is a
 * FIRE-AND-FORGET `loopbackFetch` whose settle-recording `.then`/`.catch` lives
 * only in THIS process's memory — so a 'dispatched' marker tagged with a DIFFERENT
 * instance was orphaned by a restart (the operator died mid-resolution; that promise
 * can never settle here) and is NOT really in-flight. Tagging the marker with the
 * instance lets `isResolverInFlight` re-dispatch such an orphan on the very next
 * conflict tick instead of stranding the conflict for the full RESOLVER_INFLIGHT_MS
 * TTL. pid + process-start stamp is unique per incarnation (a restart reusing the
 * same pid in the same millisecond is not physically possible).
 */
const PROCESS_INSTANCE_ID = `${process.pid}.${Date.now().toString(36)}`;

/** The shape of the `metadata->'last_resolver'` marker the dedup reads. */
export interface ResolverMarker {
  status?: string;
  at?: number;
  /** The operator instance that fired the dispatch (P-006). Absent on legacy
   *  markers written before instance-tagging — those fall back to the pure TTL. */
  instance?: string;
}

/**
 * Whether a merge-resolver is GENUINELY in-flight for this harness — pure so the
 * dedup WINDOW is directly unit-testable (P-007: the window is keyed on PG
 * timestamps, never on git round-trip timing, so seconds of real fetch/push
 * latency are negligible against the minutes-scale RESOLVER_INFLIGHT_MS / 900s
 * resolver ceiling). This replaced the old "is an escalation open?" dedup, which
 * permanently suppressed the resolver after a SILENT dispatch failure. The rules:
 *   - never-run / already-settled (status !== 'dispatched') → NOT in flight (retry);
 *   - P-006: a 'dispatched' marker from a DIFFERENT process instance was orphaned
 *     by a restart (its fire-and-forget settle can never land here) → NOT in flight
 *     (re-dispatch next tick, not after the 20-min TTL). A marker with NO instance
 *     (legacy / pre-instance-tagging) falls through to the TTL — no regression;
 *   - same-instance 'dispatched' → in flight only until the RESOLVER_INFLIGHT_MS
 *     TTL lapses (the backstop for a genuinely-slow resolver in a live process).
 */
export function isResolverInFlight(
  lr: ResolverMarker | null | undefined,
  now: number,
  instanceId: string,
): boolean {
  if (!lr || lr.status !== 'dispatched') return false; // never-run or already settled → retry
  // P-006: orphaned by an operator restart — a marker tagged with a prior incarnation
  // can never settle in this process, so it is not really in flight. (A marker with
  // no instance predates instance-tagging → fall through to the TTL, preserving the
  // old behavior rather than risk a double-dispatch on a live same-process resolver.)
  if (lr.instance !== undefined && lr.instance !== instanceId) return false;
  return typeof lr.at === 'number' && now - lr.at < RESOLVER_INFLIGHT_MS;
}

async function resolverInFlight(slug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ResolverMarker | null }[]>`
    SELECT metadata->'last_resolver' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
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

/** Clear git-sync escalations of the given kinds after a clean sync (other kinds intact).
 *  `phase` defaults to the conflict/error phase; content escalations pass their own. */
async function clearGitSyncEscalation(slug: string, kinds: string[], phase: string = ESCALATION_PHASE): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.harness_escalations
        SET escalation = NULL, mtime_ms = $2
      WHERE harness_slug = $1 AND phase = $3
        AND escalation IS NOT NULL
        AND (escalation::jsonb ->> 'kind') = ANY($4)`,
    [slug, Date.now(), phase, kinds],
  );
}

/**
 * EI-438 (P-004): write/refresh the `git-sync-content-error` escalation — the
 * human-visible record that broken files are quarantined (and, once it has failed
 * MAX_CONTENT_FIXER_ATTEMPTS ticks, that a human must step in). Its own phase row,
 * unconditional upsert (no other kind shares 'git-sync-content').
 */
async function writeGitSyncContentEscalation(
  slug: string,
  workspaceId: string,
  contentErrors: ScopedContentError[],
  consecutiveTicks: number,
  needsHuman: boolean,
): Promise<void> {
  const { sql } = getOrgPg();
  const files = contentErrors.map((c) => ({ scope: c.scope, file: c.file, detector: c.detectorKey, error: c.error }));
  const list = contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`).join(', ');
  const body = JSON.stringify({
    kind: CONTENT_ERROR_KIND,
    harness_slug: slug,
    files,
    consecutive_content_error_ticks: consecutiveTicks,
    needs_human: needsHuman,
    emitted_at: Date.now(),
    detail: needsHuman
      ? `git-sync content guard: ${files.length} file(s) STILL failing their content check after ${consecutiveTicks} ticks — the content-fixer could not repair them; a human must fix: ${list}. (They are quarantined — excluded from every auto-commit — so staging stays clean while they wait.)`
      : `git-sync quarantined ${files.length} broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: ${list}.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, CONTENT_ESCALATION_PHASE, body, Date.now(), workspaceId],
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

/** Previous tick's EI-18 + content-guard counters from the routine metadata. */
async function readEscalationCounters(slug: string): Promise<{ errTicks: number; oversizedKeys: string[]; contentTicks: number }> {
  const { sql } = getOrgPg();
  const rows = await sql<{ et: number; lo: string[] | null; ct: number }[]>`
    SELECT coalesce((metadata->>'consecutive_error_ticks')::int, 0) AS et,
           array(SELECT jsonb_array_elements_text(coalesce(metadata->'last_oversized', '[]'::jsonb))) AS lo,
           coalesce((metadata->>'consecutive_content_error_ticks')::int, 0) AS ct
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return { errTicks: rows[0]?.et ?? 0, oversizedKeys: rows[0]?.lo ?? [], contentTicks: rows[0]?.ct ?? 0 };
}

/**
 * Spawn a merge-resolver role via the invoke route (P-012) — OBSERVABLY (GAP-2).
 *
 * The `/invoke` route is synchronous (it runs the agent to completion — up to the
 * timeoutMs below, now 900s), so we MUST NOT await it: this runs inside the git-sync
 * routine's DBOS step and blocking it for the resolver's full runtime would stall the
 * routines tick. (The resolver acquires the git-sync resource lock ITSELF when it merges;
 * git-sync's own locks are already released by the time control reaches here.) So this
 * stays fire-and-forget — but it is no longer SILENT:
 *   1. a durable `last_resolver: { status:'dispatched', … }` marker is written FIRST
 *      (awaited), so the attempt is recorded even if the process restarts mid-run;
 *   2. the eventual result (HTTP status, agent exitCode/timedOut, or a network error)
 *      is recorded when the dangling promise settles — instead of vanishing into a
 *      `void … .catch(console.warn)` that went to uncaptured stdout.
 * Query `metadata->'last_resolver'` on the routine to see whether the resolver ran.
 */
async function spawnMergeResolver(slug: string, workspaceId: string, conflicts: RepoConflict[], superprojectBranch: string): Promise<void> {
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
  // P-006: pre-compute authorship/intent for the conflicted files (deterministic, best-effort)
  // so the resolver integrates per each side's intent without spending tool calls to discover it.
  let authorship: Awaited<ReturnType<typeof computeConflictAuthorship>> = [];
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug);
    if (repoRoot) authorship = await computeConflictAuthorship(repoRoot, conflicts);
  } catch {
    /* best-effort: the resolver prompt has a git-log fallback */
  }
  const dispatchedAt = Date.now();

  // (1) durable "dispatched" marker, awaited — observable even if (2) is lost.
  // P-006: stamp THIS process instance so a restart-orphaned dispatch (whose
  // settle-recording promise died with the old process) re-dispatches on the next
  // conflict tick instead of waiting out the RESOLVER_INFLIGHT_MS TTL.
  await recordResolverDispatch(slug, { at: dispatchedAt, status: 'dispatched', scopes, instance: PROCESS_INSTANCE_ID });

  // Pipeline history (mig 177): log each resolver SETTLE (not the dispatch) so the
  // Git tab can show resolver success rate. Best-effort, like recordResolverDispatch.
  const logResolverSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({ workspaceId, installSlug: slug, kind: 'merge_resolver', status, detail: { scopes, ...extra } });

  // (2) async result recording. The /invoke route reads `extra` (forwarded to
  // invoke-once) — `kickoff` is for human readability only (the route ignores it);
  // the merge-resolver also reads the open escalation, which now lists every scope.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // P-007: the superproject branch comes from the routine's resolved config
      // (cfg.branch ?? 'main') — it is NOT papercup's 'staging' for other harnesses.
      kickoff: `Resolve the git-sync merge conflict(s) in ${scopes.join(', ')} (on the branch each conflicted repo has checked out — superproject = \`${superprojectBranch}\`, submodules = their own default). Conflicted: ${filesSummary}`,
      extra: ['--git-sync-conflict', JSON.stringify({ scopes, files: filesSummary, authorship })],
      // P-010: a real multi-file merge by a higher-effort model needs well beyond the
      // route's 90s default. The invoke-route ceiling is 1200s (the old "~300s ceiling"
      // comment was stale). It drains+takes the git-sync lock (≤120s) first, then merges;
      // RESOLVER_INFLIGHT_MS is DERIVED from this (+5min margin) so it always exceeds it
      // and we never re-dispatch a still-running resolver.
      timeoutMs: RESOLVER_INVOKE_TIMEOUT_MS,
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
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordResolverDispatch(slug, {
          at: dispatchedAt,
          status: settled,
          httpStatus: res.status, exitCode, timedOut, detail,
        });
        await logResolverSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordResolverDispatch(slug, { at: dispatchedAt, status: settled, httpStatus: res.status });
        await logResolverSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] merge-resolver dispatch failed (${slug}): ${msg}`);
      await recordResolverDispatch(slug, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
      await logResolverSettle('error', { error: msg.slice(0, 300) });
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

/**
 * EI-438 content-fixer dedup (P-004): the SAME in-flight model as the
 * merge-resolver (`isResolverInFlight` is generic over the marker), keyed on its
 * OWN `last_content_fixer` routine-metadata marker so the two dispatchers never
 * suppress each other. A clean re-check tick clears the escalation.
 */
async function contentFixerInFlight(slug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ResolverMarker | null }[]>`
    SELECT metadata->'last_content_fixer' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
}

/** Record the content-fixer dispatch lifecycle onto the routine metadata. */
async function recordContentFixerDispatch(slug: string, info: Record<string, unknown>): Promise<void> {
  try {
    await patchRoutineMetadata(slug, { last_content_fixer: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record content-fixer dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Spawn a content-fixer via the invoke route (P-004) — fire-and-forget + observed,
 * the SAME shape as spawnMergeResolver. The fixer needs no git-sync lock: every
 * commit is gated by the content detector, so git-sync can never commit a
 * half-fixed file; the fixer just edits the named files and the next tick re-checks
 * + commits when they pass. It reads its file list from the `--git-sync-content-error`
 * extra (the open escalation is for human visibility, not the fixer's read path).
 */
async function spawnContentFixer(slug: string, workspaceId: string, contentErrors: ScopedContentError[]): Promise<void> {
  const target = await resolveLaunchTargetForEvent(CONTENT_ERROR_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONTENT_ERROR_EVENT}" — skipping content-fixer dispatch`);
    return;
  }
  const { url } = target;
  const files = contentErrors.map((c) => ({ scope: c.scope, file: c.file, detector: c.detectorKey, error: c.error }));
  const filePaths = files.map((f) => `${f.scope}/${f.file}`);
  const filesSummary = contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]: ${c.error}`).join('; ');
  const dispatchedAt = Date.now();

  // (1) durable "dispatched" marker, awaited (instance-tagged so a restart-orphaned
  //     dispatch re-fires next tick rather than waiting out the TTL).
  await recordContentFixerDispatch(slug, { at: dispatchedAt, status: 'dispatched', files: filePaths, instance: PROCESS_INSTANCE_ID });

  const logSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({ workspaceId, installSlug: slug, kind: 'content_fixer', status, detail: { files: filePaths, ...extra } });

  // (2) async result recording. Fire-and-forget — never awaited inside the routine step.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff:
        `Fix the git-sync content-guard quarantine in ${slug}: ${files.length} file(s) fail their content detector and were EXCLUDED from the auto-commit so staging stays clean. ` +
        `Fix ONLY the syntax so each passes its detector, change nothing else, leave the tree clean, and do NOT push (the next git-sync tick re-checks + commits). Files: ${filesSummary}`,
      extra: ['--git-sync-content-error', JSON.stringify({ files })],
      // A small, mechanical syntax fix scoped to the named files — well under the
      // invoke route's 1200s ceiling. RESOLVER_INFLIGHT_MS (20 min) exceeds this so a
      // still-running fixer is never double-dispatched.
      timeoutMs: 600_000,
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
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, { at: dispatchedAt, status: settled, httpStatus: res.status, exitCode, timedOut, detail });
        await logSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, { at: dispatchedAt, status: settled, httpStatus: res.status });
        await logSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] content-fixer dispatch failed (${slug}): ${msg}`);
      await recordContentFixerDispatch(slug, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
      await logSettle('error', { error: msg.slice(0, 300) });
    });
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

async function recordOutcome(
  slug: string,
  outcome: GitSyncOutcome,
  consecutiveErrorTicks: number,
  consecutiveContentErrorTicks: number,
): Promise<void> {
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
    // EI-438 content-guard counters: consecutive ticks with a quarantined file + the set.
    consecutive_content_error_ticks: consecutiveContentErrorTicks,
    last_content_errors: outcome.contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`),
    ...(outcome.status === 'synced' ? { head_sha: outcome.headSha } : {}),
  });
}

// ── Runtime eligibility gate (git-sync-any-hive P-008, action half) ─────────────

/**
 * Belt-and-braces gate before the pipeline runs: a routine row pointing at a hive
 * HOME (non-repo state dir), a joiner-side remote-hive VIEW, a non-local
 * deployment, or a vanished / non-git checkout must NO-OP (logged + recorded as
 * skipped) instead of error-escalating every 10 minutes. The verdict (including
 * the on-disk vanished-checkout / missing-.git checks) is B-01's
 * `gitSyncEligibility` — the SAME module the seed sites consult, so seed time
 * and run time can never disagree on the vocabulary. Best-effort: an unreadable
 * registry FAILS OPEN (the pipeline's own path resolution will surface the error).
 */
async function gitSyncRuntimeGate(slug: string): Promise<GitSyncEligibility> {
  let entry: ProjectEntry | undefined;
  try {
    entry = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug);
  } catch (e) {
    console.warn(`[git-sync] ${slug}: registry unreadable for the eligibility gate — proceeding: ${e instanceof Error ? e.message : e}`);
    return { eligible: true };
  }
  // A vanished registry entry reads the same as a vanished checkout: no path.
  if (!entry) return { eligible: false, reason: 'no_path' };
  return gitSyncEligibility(entry);
}

/** P-004/P-006: build the live attribution roster (active agents + their declared files) from
 *  coord presence. Best-effort — a presence-read failure degrades to [] (no attribution). The lazy
 *  import breaks a load-time cycle (git-sync-action is loaded by the system-action registry). */
async function loadAttributionRoster(workspaceId: string | null): Promise<AttributionRosterEntry[]> {
  try {
    const { listPresence } = await import('../../agent-tools/coordination/presence');
    const recs = await listPresence({ workspaceId });
    return recs
      .map((r) => ({
        agent: r.ownerId,
        agentLabel: r.ownerLabel ?? undefined,
        intent: r.intent ?? undefined,
        files: Array.isArray(r.currentFiles) ? r.currentFiles : [],
      }))
      .filter((e) => e.files.length > 0);
  } catch {
    return [];
  }
}

/** P-003 (deterministic-commit-workitem-attribution-2026-06-22): the attribution roster,
 *  preferring the DURABLE edit ledger (keyed by repo root) over live presence — so a commit is
 *  attributed even after the editing agent's session ended (D-002), and carries the work-item(s)
 *  it was claimed under. Ledger entries come FIRST so attributionMapForRepo's first-wins gives
 *  them priority; presence fills any files the ledger window missed (and supplies agentLabels).
 *  Best-effort throughout: a ledger-read failure degrades to presence, exactly as before. */
async function loadAttributionRosterMerged(
  slug: string,
  workspaceId: string | null,
): Promise<AttributionRosterEntry[]> {
  let ledger: AttributionRosterEntry[] = [];
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug);
    if (repoRoot) {
      const { readEditAttributionRoster } = await import('../../edit-attribution');
      ledger = (await readEditAttributionRoster(repoRoot)).map((e) => ({
        agent: e.agent,
        intent: e.intent,
        files: e.files,
        workItems: e.workItems,
        planSlug: e.planSlug,
        sessionId: e.sessionId,
      }));
    }
  } catch {
    /* best-effort: fall through to presence */
  }
  const presence = await loadAttributionRoster(workspaceId);
  return [...ledger, ...presence];
}

/** P-006 (assign-don't-broadcast / F5): recipients for a content-guard escalation — the agents who
 *  declared the quarantined files (ASSIGNED, not a fleet broadcast). Returns ['*'] when derived
 *  attribution is OFF or nothing matched, so it degrades to today's broadcast. Gated on the same
 *  GIT_SYNC_DERIVED_ATTRIBUTION flag as P-004 (both DERIVE who from presence). */
async function assigneesForContentErrors(
  slug: string,
  workspaceId: string | null,
  contentErrors: ScopedContentError[],
): Promise<string[]> {
  try {
    if (!(await getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug))) return ['*'];
    const roster = await loadAttributionRoster(workspaceId);
    // Resolve the superproject root so absolute current_files normalize to repo-relative (lazy
    // import to keep the registry load-graph acyclic, like loadAttributionRoster's presence read).
    const { projectDirForSlug } = await import('../../operator-notes');
    const superRoot = (await projectDirForSlug(slug)) ?? undefined;
    const agents = agentsForScopedFiles(
      roster,
      contentErrors.map((c) => ({ scope: c.scope, file: c.file })),
      superRoot,
    );
    return agents.length ? agents : ['*'];
  } catch {
    return ['*'];
  }
}

/**
 * P-004 (deterministic-commit-workitem-attribution-2026-06-22): after a synced tick, read the
 * `Papercusp-Work-Item/Agent/Session/Plan` trailers off the per-agent commits git-sync just made
 * (run-git-sync wrote them) + their changed files, and persist them as git_sync_commit_attribution
 * rows — the fast reverse-index the doc-drift (P-005) + merge-resolver (P-006) consumers join.
 * DETERMINISTIC + best-effort (D-006): pure git reads + a bulk insert, NO LLM. Dedup by commit_sha
 * (idempotent across ticks); bounded to the last 50 commits; superproject only for now (a
 * superproject commit that touched a submodule shows the gitlink path — submodule-inner attribution
 * is a follow-on). Never throws.
 */
async function recordSyncedCommitAttribution(slug: string, workspaceId: string): Promise<void> {
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug);
    if (!repoRoot) return;
    const { runGit } = await import('../docs/git-runner');

    const logRes = await runGit(['log', '-n', '50', '--format=%H'], repoRoot);
    if (logRes.code !== 0) return;
    const shas = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (shas.length === 0) return;

    // Which of these are already recorded? (idempotent re-run across ticks.)
    const { sql } = getOrgPg();
    const existing = await sql<{ commit_sha: string }[]>`
      SELECT DISTINCT commit_sha FROM harness_shared.git_sync_commit_attribution
       WHERE commit_sha = ANY(${shas})`;
    const seen = new Set(existing.map((r) => r.commit_sha));

    const rows: CommitAttributionRow[] = [];
    for (const sha of shas) {
      if (seen.has(sha)) continue;
      const body = (await runGit(['show', '-s', '--format=%B', sha], repoRoot)).stdout;
      const t = parsePapercuspTrailers(body);
      // Only OUR attributed git-sync commits carry these — skip everything else.
      if (!t.agent && t.workItems.length === 0) continue;
      const filesRes = await runGit(['show', '--name-only', '--format=', sha], repoRoot);
      const files = filesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const file of files) {
        const base = {
          workspaceId,
          harnessSlug: slug,
          repo: 'superproject',
          commitSha: sha,
          file,
          agentId: t.agent,
          sessionId: t.sessionId,
          planSlug: t.planSlug,
        };
        if (t.workItems.length === 0) {
          rows.push(base);
        } else {
          // one row per (file × work-item) — honest multiplicity (D-003).
          for (const wi of t.workItems) rows.push({ ...base, workItemId: wi });
        }
      }
    }
    await recordCommitAttribution(rows);
  } catch {
    // best-effort: commit attribution must never affect git-sync.
  }
}

/**
 * P-006 (deterministic-commit-workitem-attribution-2026-06-22): pre-compute authorship/intent
 * context for the conflicted files so the merge-resolver receives it WITHOUT spending tool calls
 * to discover it (D-006). Reads the recent commits that touched each conflicted file + their
 * `Papercusp-Work-Item/Agent` trailers (git-sync's per-agent commits write them; the commit
 * subject IS the authoring agent's intent). Deterministic git reads, best-effort: returns [] on
 * any failure — the merge-resolver.md prompt has a git-log fallback. Bounded to 20 files/scope.
 */
async function computeConflictAuthorship(
  repoRoot: string,
  conflicts: RepoConflict[],
): Promise<
  Array<{ scope: string; file: string; recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }> }>
> {
  try {
    const { runGit } = await import('../docs/git-runner');
    const out: Array<{
      scope: string;
      file: string;
      recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }>;
    }> = [];
    for (const c of conflicts) {
      // a submodule conflict's files are relative to the submodule repo; cd there (D-015).
      const repoDir = c.scope === 'superproject' ? repoRoot : `${repoRoot}/${c.scope}`;
      for (const file of c.conflictedFiles.slice(0, 20)) {
        // %x1f field-sep, %x1e record-sep so a multi-line %B body parses unambiguously.
        const res = await runGit(['log', '-n', '5', '--format=%H%x1f%B%x1e', '--', file], repoDir);
        if (res.code !== 0) continue;
        const recent = res.stdout
          .split('\x1e')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((block) => {
            const sep = block.indexOf('\x1f');
            const sha = (sep >= 0 ? block.slice(0, sep) : block).trim();
            const body = sep >= 0 ? block.slice(sep + 1) : '';
            const t = parsePapercuspTrailers(body);
            return { sha: sha.slice(0, 12), subject: body.split('\n')[0]?.trim() ?? '', workItems: t.workItems, agent: t.agent };
          })
          .filter((r) => r.sha.length > 0);
        if (recent.length > 0) out.push({ scope: c.scope, file, recent });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The registered `system:git-sync` handler. */
async function handleGitSync(ctx: SystemActionCtx): Promise<void> {
  const { installSlug: slug, workspaceId } = ctx;
  const { config: cfg, extraLockResources } = configFromTrigger(ctx.triggerConfig);
  const cd = workspaceId || '*';

  // P-008 runtime gate: ineligible rows no-op (logged + recorded), never escalate.
  const gate = await gitSyncRuntimeGate(slug);
  if (!gate.eligible) {
    console.log(`[git-sync] ${slug}: ineligible (${gate.reason}) — skipping this tick`);
    await patchRoutineMetadata(slug, {
      last_status: 'skipped',
      last_skip_reason: gate.reason,
      last_skipped_at: Date.now(),
    });
    return;
  }

  // P-006: per-slug resource first (auto-registered), then the routine's extras
  // (papercup: legacy 'git-sync' + 'libs-papercusp-submodule' — the back-off protocol).
  const resources = [...new Set([gitSyncResourceName(slug), ...extraLockResources])];
  const acquired: string[] = [];
  const lock = await acquireLocks(cd, slug, resources, acquired);
  if (lock.state === 'held') {
    if (lock.blockedReason === 'unknown_resource') {
      console.warn(
        `[git-sync] ${slug}: lock resource "${lock.blockedOn}" is not registered in agent_resource_registry — ` +
        'skipping this tick. Register it or remove it from trigger_config.extra_lock_resources.');
    } else {
      console.log(`[git-sync] ${slug}: a peer holds ${lock.blockedOn} — skipping this tick`);
    }
    return;
  }
  // EI-18: previous tick's counters BEFORE this tick overwrites them.
  const prev = await readEscalationCounters(slug);

  // Capture HEAD before the sync so the doc-freshness sweep (P-003) can diff the
  // exact paths this tick moved. Best-effort — never gate the sync on it.
  let prevHeadSha: string | null = null;
  try {
    prevHeadSha = await (await import('../docs/sweep-after-sync')).captureHeadSha(slug);
  } catch {
    /* best-effort */
  }

  // EI-438 content-guard KILL-SWITCH (default ON): when OFF, pass an EMPTY detector
  // set so runGitSync commits exactly as before this plan (no quarantine/escalation/
  // fixer) — the instant off-switch on the shared commit path, no deploy needed. A
  // flag-infra error falls back to the default (ON), keeping the safety on.
  const contentGuardOn = await getFlag(FLAGS.GIT_SYNC_CONTENT_GUARD, slug);
  // P-004 (git-sync-dx-hardening): derived commit attribution (default OFF). When ON, supply the
  // LIVE roster of active agents + their declared files (coord presence current_files) so runGitSync
  // peels per-agent commits. DERIVED, never authored — agents stay git-free. Flag-gated read; a
  // presence-read failure degrades to no attribution (today's single commit).
  const attributionOn = await getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug);

  // 'acquired' (locked) or 'error' (unlocked best-effort) → run.
  let outcome: GitSyncOutcome;
  try {
    outcome = await runGitSync(slug, {
      config: cfg,
      contentDetectors: contentGuardOn ? undefined : [],
      loadRoster: attributionOn ? () => loadAttributionRosterMerged(slug, workspaceId) : undefined,
    });
  } finally {
    if (lock.state === 'acquired') await releaseAll(cd, acquired);
  }

  // P-003: count any tick whose errors[] is non-empty — a sibling push failure that
  // co-occurs with a conflict produces status 'conflict' (worst-outcome), which used
  // to RESET this counter to 0 every tick and defer the EI-18 push-failure escalation
  // indefinitely. The error LIST drives the counter now, not the worst status.
  const tickErrors = 'errors' in outcome ? outcome.errors : [];
  const errTicks = tickErrors.length > 0 ? prev.errTicks + 1 : 0;
  // EI-438: consecutive ticks with a file still quarantined (drives P-005 escalate-to-human).
  const contentTicks = outcome.contentErrors.length > 0 ? prev.contentTicks + 1 : 0;
  await recordOutcome(slug, outcome, errTicks, contentTicks);

  // Pipeline history (mig 177): log every tick so the /admin Git tab can show
  // sync/conflict/error rates over time (routines.metadata only keeps the LAST).
  await appendPipelineEvent({
    workspaceId,
    installSlug: slug,
    kind: 'git_sync',
    status: outcome.status,
    detail: {
      pushed: 'pushed' in outcome ? outcome.pushed : [],
      merged: 'merged' in outcome ? outcome.merged : [],
      conflicts:
        outcome.status === 'conflict'
          ? outcome.conflicts.map((c) => ({ scope: c.scope, files: c.conflictedFiles }))
          : [],
      errors: ('errors' in outcome ? outcome.errors : []).map((e) => ({ scope: e.scope, message: e.message.slice(0, 300) })),
      oversized: outcome.oversized.length,
      contentErrors: outcome.contentErrors.length,
      consecutiveErrorTicks: errTicks,
      ...(outcome.status === 'synced' ? { headSha: outcome.headSha } : {}),
    },
  });

  if (outcome.status === 'conflict') {
    // P-010/P-012: refresh the escalation (listing every conflicted scope) + dispatch
    // a resolver UNLESS one is genuinely in-flight. Sibling submodules still pushed (GAP-1).
    await writeGitSyncEscalation(slug, workspaceId, outcome.conflicts);
    if (!(await resolverInFlight(slug))) {
      const scopes = outcome.conflicts.map((c) => c.scope).join(', ');
      console.warn(`[git-sync] ${slug}: merge conflict(s) in ${scopes} — dispatching merge-resolver`);
      await spawnMergeResolver(slug, workspaceId, outcome.conflicts, cfg.branch ?? 'main');
    }
  } else if (outcome.status === 'synced' || outcome.status === 'nothing') {
    // A clean pass means any prior conflict is resolved — clear the escalation.
    await clearGitSyncEscalation(slug, [ESCALATION_KIND]);
    // P-004 (deterministic-commit-workitem-attribution): persist the commit->work-item link
    // from the attributed commits git-sync just made (their trailers). Same flag-gate as the
    // attribution roster; best-effort + deterministic (no LLM). Only on 'synced' — a 'nothing'
    // tick made no new commits.
    if (attributionOn && outcome.status === 'synced') {
      await recordSyncedCommitAttribution(slug, workspaceId);
    }
  }

  // EI-438 content guard (P-004/P-005): broken files were QUARANTINED this tick
  // (excluded from the auto-commit so staging stays clean). Escalate + dispatch a
  // content-fixer (deduped), counting consecutive failing ticks so a file the fixer
  // can't repair surfaces to a human instead of looping forever. A clean tick clears
  // the escalation + resets the counter. INDEPENDENT of outcome.status — content
  // errors ride alongside on any status (like oversized), so this runs unconditionally.
  const contentErrors = outcome.contentErrors;
  if (contentErrors.length > 0) {
    const needsHuman = contentTicks >= MAX_CONTENT_FIXER_ATTEMPTS;
    await writeGitSyncContentEscalation(slug, workspaceId, contentErrors, contentTicks, needsHuman);
    if (needsHuman) {
      // P-005: the fixer has had MAX_CONTENT_FIXER_ATTEMPTS ticks and the file is STILL
      // broken — STOP auto-dispatching (no infinite silent loop) and surface to a human
      // ONCE, on the transition. The file stays quarantined (never reaches staging), so
      // nothing is at risk while it waits for a human.
      if (prev.contentTicks < MAX_CONTENT_FIXER_ATTEMPTS) {
        const summary =
          `git-sync: ${contentErrors.length} broken file(s) STILL failing their content check after ${contentTicks} ticks — ` +
          `the content-fixer couldn't repair them; a human is needed. Quarantined (staging stays clean): ` +
          contentErrors.map((c) => `${c.scope}/${c.file}`).join(', ');
        console.warn(`[git-sync] ${slug}: ${summary}`);
        // P-006: ASSIGN to the agents who edited the quarantined files (derived from presence),
        // not a fleet broadcast. Falls back to ['*'] when attribution is off / unattributable.
        const to = await assigneesForContentErrors(slug, workspaceId, contentErrors);
        await sendMessage(GIT_SYNC_IDENTITY, { to, summary, category: 'git-sync' }).catch(() => {});
      }
    } else if (!(await contentFixerInFlight(slug))) {
      console.warn(`[git-sync] ${slug}: ${contentErrors.length} content error(s) quarantined — dispatching content-fixer`);
      await spawnContentFixer(slug, workspaceId, contentErrors);
    }
  } else if (prev.contentTicks > 0) {
    // Clean re-check after a quarantine — the previously-broken files now pass: clear the
    // content-error escalation (mirror the merge-resolver's clean-pass clear). Gated on the
    // prior counter so a no-content tick doesn't issue a pointless UPDATE every 10 min.
    await clearGitSyncEscalation(slug, [CONTENT_ERROR_KIND], CONTENT_ESCALATION_PHASE);
  }

  // P-003/D-004: after a real sync, sweep this harness's docs for drift — flip
  // status, enqueue documenter regenerations, flag manual re-verifies. Best-effort
  // + lazily imported so it never wedges or slows git-sync.
  if (outcome.status === 'synced') {
    try {
      const { runDocFreshnessSweepAfterSync } = await import('../docs/sweep-after-sync');
      await runDocFreshnessSweepAfterSync({
        harnessSlug: slug,
        workspaceId,
        prevSha: prevHeadSha ?? undefined,
        headSha: outcome.headSha,
      });
    } catch {
      /* best-effort — doc drift never gates git-sync */
    }
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

/**
 * Fire the git-sync action ONCE, on demand — the SAME work a cron tick does (lock,
 * content-guard, attribution, commit + push). Shared by the git-sync:run verb and by
 * release:deploy (fire-before-deploy so a (force-)deploy ships CURRENT staging, not a
 * stale tree when git-sync is lagging/wedged — WI-1320). Reads the routine's own
 * trigger_config so it behaves exactly like a tick; default config when the row is absent.
 */
export async function fireGitSyncNow(installSlug: string, workspaceId: string): Promise<void> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT trigger_config FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'git-sync'
     LIMIT 1`) as Array<{ trigger_config: Record<string, unknown> | null }>;
  const triggerConfig = rows[0]?.trigger_config ?? {};
  await handleGitSync({ installSlug, workspaceId, triggerConfig, payloadTemplate: null });
}

registerSystemAction('git-sync', handleGitSync);
