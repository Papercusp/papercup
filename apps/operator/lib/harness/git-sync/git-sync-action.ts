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
import { inWorkspaceTxn } from '@/lib/agent-tools/locks/in-workspace-txn';
import { tryAcquireResource, tryReleaseResource } from '@/lib/agent-tools/locks/su-lock-store';
import { loopbackFetch } from '@/lib/loopback-fetch';
import { registerSystemAction, type SystemActionCtx } from '@/lib/harness/routines/system-actions';
import { runGitSync, type GitSyncConfig, type GitSyncOutcome } from './run-git-sync';

const GIT_SYNC_OWNER = 'system:git-sync';
const LOCK_RESOURCES = ['git-sync', 'libs-papercusp-submodule'] as const;
const LOCK_TTL_SEC = 600;
const ESCALATION_PHASE = 'staging';
const ESCALATION_KIND = 'git-sync-conflict';
const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

function configFromTrigger(triggerConfig: Record<string, unknown>): GitSyncConfig {
  return {
    push: triggerConfig.push !== false,
    pushSubmodules: triggerConfig.push_submodules !== false,
    branch: typeof triggerConfig.branch === 'string' ? triggerConfig.branch : undefined,
    remote: typeof triggerConfig.remote === 'string' ? triggerConfig.remote : undefined,
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

/** Whether an unresolved git-sync-conflict escalation is currently open for the harness. */
async function gitSyncEscalationOpen(slug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ escalation: string | null }[]>`
    SELECT escalation FROM harness_shared.harness_escalations
     WHERE harness_slug = ${slug} AND phase = ${ESCALATION_PHASE}
     LIMIT 1
  `;
  const body = rows[0]?.escalation;
  if (!body) return false;
  try {
    return (JSON.parse(body) as { kind?: string }).kind === ESCALATION_KIND;
  } catch {
    return false;
  }
}

async function writeGitSyncEscalation(slug: string, workspaceId: string, conflicted: string[]): Promise<void> {
  const { sql } = getOrgPg();
  const body = JSON.stringify({
    kind: ESCALATION_KIND,
    harness_slug: slug,
    conflicted_files: conflicted,
    emitted_at: Date.now(),
    detail: 'git-sync auto-merge with origin/main conflicted; tree aborted clean, merge-resolver dispatched.',
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/** Clear a git-sync-conflict escalation after a clean sync (leave other kinds intact). */
async function clearGitSyncEscalation(slug: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.harness_escalations
        SET escalation = NULL, mtime_ms = $2
      WHERE harness_slug = $1 AND phase = $3
        AND escalation IS NOT NULL
        AND (escalation::jsonb ->> 'kind') = $4`,
    [slug, Date.now(), ESCALATION_PHASE, ESCALATION_KIND],
  );
}

/** Fire-and-forget spawn of a merge-resolver role via the invoke route (P-012). */
async function spawnMergeResolver(slug: string, workspaceId: string, conflicted: string[]): Promise<void> {
  const ws = encodeURIComponent(workspaceId);
  const url = `${operatorBase()}/api/harness/${encodeURIComponent(slug)}/invoke?role=merge-resolver&ws=${ws}`;
  // Don't await the agent run to completion — it resolves the conflict asynchronously;
  // the next git-sync tick sees a clean tree and clears the escalation.
  void loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kickoff: `Resolve the git-sync merge conflict on main. Conflicted: ${conflicted.join(', ')}` }),
  }).catch((e) => console.warn(`[git-sync] merge-resolver spawn failed (${slug}): ${e instanceof Error ? e.message : e}`));
}

async function recordOutcome(slug: string, outcome: GitSyncOutcome): Promise<void> {
  const { sql } = getOrgPg();
  const meta = {
    last_status: outcome.status,
    last_synced_at: Date.now(),
    ...(outcome.status === 'synced' ? { head_sha: outcome.headSha, pushed: outcome.pushed } : {}),
    ...(outcome.status === 'error' ? { last_error: outcome.message } : {}),
  };
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:git-sync'`,
    [slug, JSON.stringify(meta)],
  );
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
  // 'acquired' (locked) or 'error' (unlocked best-effort) → run.
  let outcome: GitSyncOutcome;
  try {
    outcome = await runGitSync(slug, { config: cfg });
  } finally {
    if (state === 'acquired') await releaseAll(cd, acquired);
  }

  await recordOutcome(slug, outcome);

  if (outcome.status === 'conflict') {
    // P-010/P-012: file the escalation + spawn a resolver, deduped on the open escalation.
    const alreadyOpen = await gitSyncEscalationOpen(slug);
    await writeGitSyncEscalation(slug, workspaceId, outcome.conflictedFiles);
    if (!alreadyOpen) {
      console.warn(`[git-sync] ${slug}: merge conflict (${outcome.conflictedFiles.join(', ')}) — spawning merge-resolver`);
      await spawnMergeResolver(slug, workspaceId, outcome.conflictedFiles);
    }
  } else if (outcome.status === 'synced' || outcome.status === 'nothing') {
    // A clean pass means any prior conflict is resolved — clear the escalation.
    await clearGitSyncEscalation(slug);
  }
}

registerSystemAction('git-sync', handleGitSync);
