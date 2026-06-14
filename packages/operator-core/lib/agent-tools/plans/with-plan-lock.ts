/**
 * withPlanLock — acquire-mutate-release shape for plans:* write verbs, now
 * PG-canonical (plans-pg-canonical-migration-2026-06-03, Stage 1 / D-005).
 *
 * The plan body lives in `harness_shared.harness_plans.content`. A write is a
 * read-modify-write: read the current blob, run the mutator, upsert the result
 * with `version = version + 1`. Concurrency (D-005):
 *
 *   - A **PG advisory xact lock** on (workspace, harness, slug) serializes
 *     concurrent writers for the SAME plan, so ID allocation (D-NNN / P-NNN /
 *     slug uniqueness) inside the mutator — and the `afterWrite` plan_revisions
 *     `seq` allocation — is race-free. The lock auto-releases when the wrapping
 *     transaction commits. Held across the whole RMW + afterWrite.
 *   - Optimistic **version CAS** is the editor-concurrency guard: a caller that
 *     based its edit on `expectedVersion` is rejected (stale) when the live row
 *     has moved on. A UI edit session holds no lock during the minutes of
 *     editing — version CAS, not the lock, catches the concurrent change.
 *
 * Replaces the old filesystem O_EXCL lock + the SU file-claim coordinator.
 */

import { withWorkspace } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { hashPlanContent } from './content-hash';
import {
  resolvePlanScope,
  syntheticPlanPath,
  deriveIndexFromContent,
  VALID_PLAN_SLUG,
} from './source';

/**
 * plan-federation-regrain P-010 — ONGOING per-part capture for a committed plan
 * write. Flag-gated (papercusp-plan-part-federation), best-effort, and run in its
 * OWN post-commit transaction so a capture failure can NEVER roll back or block the
 * plan write. Baselines from the PRE-edit body (deterministic fed_ts=0) so the diff
 * captures only the CHANGED part — not every part — on the first edit after the flip;
 * capturePlanParts then writes the changed parts (origin='local' → mig-271 federates
 * them). Inert when the flag is OFF (one cached getFlag read, then return).
 */
async function capturePlanPartsForWrite(
  workspaceId: string,
  harnessSlug: string,
  slug: string,
  priorBody: string | null,
  newBody: string,
): Promise<void> {
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    if (!getFlag(FLAGS.PLAN_PART_FEDERATION, 'system')) return; // DARK: no-op when off
    const { PgPlanPartsStore } = await import('../../plan-parts/store');
    const { capturePlanParts, ensurePlanPartsBaseline } = await import('../../plan-parts/federation');
    await withWorkspace(workspaceId, async (tx) => {
      const store = new PgPlanPartsStore(tx, workspaceId, harnessSlug);
      if (priorBody) await ensurePlanPartsBaseline(store, slug, priorBody);
      await capturePlanParts(store, slug, newBody, Date.now(), 'local');
    });
  } catch {
    /* best-effort: per-part federation must never break a committed plan write */
  }
}

/** Current state handed to the mutator alongside the body — for version CAS. */
export interface PlanWriteMeta {
  version: number;
  contentHash: string;
}

export interface WithPlanLockOpts {
  /** Plan slug (the PG key + the advisory lock key). */
  slug: string;
  /** One-line description of the mutation, surfaced to busy callers. */
  intent: string;
  /** Harness scope. Omit → papercup primary. */
  harnessSlug?: string;
  /** Workspace. Omit → resolved from the registry / DEFAULT. */
  workspaceId?: string;
  /** Advisory-lock acquisition budget before reporting busy. Default ~5s. */
  ttlSec?: number;
  /**
   * Optional hook run *after* the upsert transaction commits (EI-118).
   * The `plans:*` verbs append a `plan_revisions` row here. `scope` is
   * the (workspaceId, harnessSlug) this lock resolved for the write —
   * pass it through so the revision lands in the plan's own workspace
   * (audit P-008). Best-effort; a throw propagates (the row is already
   * written).
   */
  afterWrite?: (
    writtenBody: string,
    scope: { workspaceId: string; harnessSlug: string },
  ) => Promise<void>;
}

/**
 * One blocked-path entry in a busy result. Shaped like the locks
 * store's AcquireBusy except `expires_ts` is NULLABLE: the plans
 * advisory lock is transaction-scoped — it releases at the holder's
 * commit, so there is no holder TTL to report. The old code filled
 * this with the CALLER's own acquire deadline, which read as "the
 * holder expires in ~5s" and was simply false (audit P-045).
 */
export interface PlanBusy {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: Date | null;
}

export interface BusyError {
  kind: 'busy';
  busy: PlanBusy[];
}

export interface AppliedResult<T> {
  kind: 'applied';
  value: T;
  /** Synthetic stable locator (the old `.md` path) — no file exists under PG storage. */
  filePath: string;
  /** The row's version after this write (unchanged when the mutator wrote nothing). */
  version: number;
}

export type WithPlanLockResult<T> = AppliedResult<T> | BusyError;

/** PG error raised when a query is canceled by lock_timeout. */
const LOCK_TIMEOUT_CODE = '55P03';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Acquire a PG advisory lock on the plan, read its current body, run the
 * mutator, upsert the result with a bumped version, release (on commit).
 *
 * Mutator contract:
 *   - `current` is the live content blob, or null when the plan doesn't exist.
 *   - `meta` carries the live `version` + `contentHash` (null when absent).
 *   - Returns the new body, or `null` to leave the plan untouched.
 *
 * The first parameter (`_ctx`) is retained for call-site compatibility — the
 * old SU lock used it for the owner identity; the PG advisory lock needs none.
 * Revision attribution is wired by the caller through `afterWrite`.
 */
export async function withPlanLock<T>(
  _ctx: unknown,
  opts: WithPlanLockOpts,
  mutator: (
    current: string | null,
    meta: PlanWriteMeta | null,
  ) => Promise<{ newBody: string | null; value: T }>,
): Promise<WithPlanLockResult<T>> {
  if (typeof opts.slug !== 'string' || !VALID_PLAN_SLUG.test(opts.slug)) {
    throw new Error(`withPlanLock: invalid plan slug ${JSON.stringify(opts.slug)}`);
  }
  const { workspaceId, harnessSlug } = await resolvePlanScope({
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  const slug = opts.slug;
  const filePath = syntheticPlanPath(harnessSlug, slug);
  const lockKey = `${workspaceId}:${harnessSlug}:${slug}`;
  const budgetMs = (opts.ttlSec ?? 5) * 1000;

  return withWorkspace(workspaceId, async (tx) => {
    // Serialize same-plan writers via a transaction-scoped advisory lock,
    // acquired non-blocking with a bounded retry so genuine contention reports
    // busy instead of hanging. The two-int4 form keys on a fixed namespace +
    // the plan key hash.
    let acquired = false;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const r = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey})) AS ok
      `;
      if (r[0]?.ok) {
        acquired = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(50);
    }
    if (!acquired) {
      return {
        kind: 'busy',
        busy: [
          {
            path: filePath,
            owner: 'unknown',
            owner_label: null,
            intent: 'another plans write is in progress',
            // The advisory lock releases at the holder's COMMIT — there
            // is no knowable holder expiry (audit P-045). Callers retry;
            // they must not schedule around a fabricated timestamp.
            expires_ts: null,
          },
        ],
      } satisfies BusyError;
    }

    const rows = await tx<
      { content: string; version: string | number; content_hash: string }[]
    >`
      SELECT content, version, content_hash
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ${slug}
    `;
    const cur = rows[0] ?? null;
    const curVersion = cur ? Number(cur.version) : 0;
    const meta: PlanWriteMeta | null = cur
      ? { version: curVersion, contentHash: cur.content_hash }
      : null;

    const { newBody, value } = await mutator(cur?.content ?? null, meta);

    let newVersion = curVersion;
    if (newBody !== null) {
      newVersion = curVersion + 1;
      const idx = deriveIndexFromContent(newBody);
      const hash = hashPlanContent(newBody);
      // jsonb columns bound as `${JSON.stringify(x)}::jsonb` — the operator's
      // postgres-js client throws on sql.json / bare-object jsonb params
      // (agent-insights/postgres-js-jsonb-binding).
      const itemsJson = JSON.stringify(idx.items);
      const decisionsJson = JSON.stringify(idx.decisions);
      await tx`
        INSERT INTO harness_shared.harness_plans (
          workspace_id, harness_slug, plan_slug, content, content_hash, version,
          title, status, created, updated, owner, initiative, supersedes, superseded_by,
          is_legacy, items, decisions, now_state, now_next, origin
        ) VALUES (
          ${workspaceId}, ${harnessSlug}, ${slug}, ${newBody}, ${hash}, ${newVersion},
          ${idx.title}, ${idx.status}, ${idx.created}, ${idx.updated}, ${idx.owner}, ${idx.initiative},
          ${idx.supersedes}, ${idx.supersededBy}, ${idx.isLegacy},
          ${itemsJson}::text::jsonb, ${decisionsJson}::text::jsonb, ${idx.nowState}, ${idx.nowNext}, 'local'
        )
        ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
          content       = EXCLUDED.content,
          content_hash  = EXCLUDED.content_hash,
          version       = ${newVersion},
          title         = EXCLUDED.title,
          status        = EXCLUDED.status,
          created       = EXCLUDED.created,
          updated       = EXCLUDED.updated,
          owner         = EXCLUDED.owner,
          initiative    = EXCLUDED.initiative,
          supersedes    = EXCLUDED.supersedes,
          superseded_by = EXCLUDED.superseded_by,
          is_legacy     = EXCLUDED.is_legacy,
          items         = EXCLUDED.items,
          decisions     = EXCLUDED.decisions,
          now_state     = EXCLUDED.now_state,
          now_next      = EXCLUDED.now_next,
          -- EI-117: a genuine local write must RESET origin — without this a row
          -- last touched by a hyperbee projection (origin='remote') keeps that
          -- origin, the CDC capture trigger skips the local write, and the edit
          -- never reaches the outbox/log (so a later replay reverts it).
          origin        = 'local'
      `;
    }

    return {
      kind: 'applied',
      value,
      filePath,
      version: newVersion,
      writtenBody: newBody,
      // P-010: the PRE-edit content, threaded to the post-commit per-part capture
      // so it can baseline (deterministic fed_ts=0) before diffing the new content.
      priorBody: cur?.content ?? null,
    } satisfies AppliedResult<T> & { writtenBody: string | null; priorBody: string | null };
  }).then(async (result) => {
    // EI-118 (audit P-007): afterWrite (revision recording) runs AFTER the
    // withWorkspace transaction commits — never inside it. Inside, a stalled
    // afterWrite left the tx idle-in-transaction holding RowExclusiveLock on
    // harness_plans, wedging every plans write fleet-wide. The trade is
    // deliberate: a failed afterWrite now loses one revision row instead of
    // rolling back the committed plan write (and instead of wedging the fleet).
    if (result.kind === 'applied') {
      const { writtenBody, priorBody, ...applied } = result as AppliedResult<T> & {
        writtenBody: string | null;
        priorBody: string | null;
      };
      if (writtenBody !== null && opts.afterWrite) {
        await opts.afterWrite(writtenBody, { workspaceId, harnessSlug });
      }
      // P-010 ongoing per-part federation — flag-gated + best-effort (never throws),
      // so it can't disturb the committed write or the afterWrite revision.
      if (writtenBody !== null) {
        await capturePlanPartsForWrite(workspaceId, harnessSlug, slug, priorBody, writtenBody);
      }
      return applied;
    }
    return result;
  }).catch((err: unknown) => {
    // A lock_timeout (if a future caller sets one) surfaces as busy rather
    // than a hard error; everything else propagates.
    if ((err as { code?: string })?.code === LOCK_TIMEOUT_CODE) {
      return {
        kind: 'busy',
        busy: [
          {
            path: filePath,
            owner: 'unknown',
            owner_label: null,
            intent: 'another plans write is in progress',
            // No knowable holder expiry — see the acquire-path comment
            // (audit P-045).
            expires_ts: null,
          },
        ],
      } satisfies BusyError;
    }
    throw err;
  });
}

/**
 * Mutate the frontmatter's `updated:` field in place to today's ISO-8601 date.
 * If frontmatter is missing/invalid, returns the body unchanged (legacy plans
 * aren't assisted-write targets).
 */
export function bumpUpdatedDate(body: string, today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  if (!body.startsWith('---')) return body;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return body;
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const updatedRe = /^(updated:\s*).*$/m;
  if (updatedRe.test(fm)) {
    return fm.replace(updatedRe, `$1${iso}`) + rest;
  }
  return fm + `\nupdated: ${iso}` + rest;
}
