/**
 * ready-plan-autostart.ts — the Queen↔Scout feedback-loop MISSING CONSUMER of
 * `ready` (WI-1574, 2026-07-02).
 *
 * THE DEAD END (root cause this closes): the review loop's terminal state is
 * `ready` ("Queen promotes to greenlight") — but NOTHING ever consumed `ready`.
 * Evidence at time of writing: scout_routed_ideas rail='plan' had 6 routes, all
 * outcome='pending' since 2026-06-11; harness_plans had scout plans at
 * ready/active/shipped; yet ZERO work_items in history carried
 * `source_plan_slug like 'scout-%'`. The Queen ratified drafts and the chain
 * stopped there: no `plans:start`, so `promotePlanItems` never ran, so the
 * Queen's survey never saw a single item from a scout-born plan — the full
 * circuit (observation → scout → plan → queen places → bee completes) has
 * NEVER closed through the plan rail.
 *
 * Two teeth were missing:
 *   1. No consumer of `ready` — closed HERE: a deterministic, zero-token sweep
 *      on the 30s routinesTick (the draft-review-watchdog shape) auto-STARTS a
 *      ratified (status='ready', never-started) scout plan: op_status='started'
 *      + `promotePlanItems` → work_items (stamped with source_plan_slug) → the
 *      Queen's normal survey/demand path takes over. Ratifying IS the approval
 *      signal (mirrors plans:start's own "starting is the approval" doctrine),
 *      so auto-starting a ratified plan fakes nothing.
 *   2. Drafts carried no items (the template deferred them to "once greenlit",
 *      which nobody did) — closed in scout-plan-draft.ts: the template now
 *      seeds P-001 from the proposal so a ratified plan is startable. A ready
 *      plan that STILL has no open items is not startable — the sweep fires a
 *      debounced Queen wake to decompose it (source='scout-ready-decompose')
 *      instead of silently skipping (no new dead end).
 *
 * WORKSPACE NUANCE (latent trap found during WI-1574): scout plan rows live
 * under the hive's OWN workspace (e.g. 'papercusp-workspace'), while the
 * `plans:start` tool's UPDATE is pinned to DEFAULT_WORKSPACE_ID — so even a
 * dutiful Queen calling plans:start would MISS the scout plan's op-status row.
 * This sweep scopes every read/write to the started hive's own workspaceId
 * (same as readScoutDraftCandidates).
 *
 * Watchdog conventions (mirrors draft-review-watchdog.ts): pure deciders split
 * from the PG sweep, env kill switch, per-hive debounce over
 * `hive_watchdog_fires` for the WAKE path, fail-soft throughout. The START
 * path needs no debounce: a started plan stops matching the selector
 * (op_status filter), so it is naturally once-only.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listStartedPots } from '../pot/started';
import { resolveMugOwner } from '../pot/placement-watchdog';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { promotePlanItems } from '../plan-workitem-promotion-run';

// ── tunables ──────────────────────────────────────────────────────────────────

/** Kill switch: PAPERCUSP_SCOUT_READY_AUTOSTART=0 disables the whole sweep. */
export function scoutReadyAutostartEnabled(): boolean {
  return process.env.PAPERCUSP_SCOUT_READY_AUTOSTART !== '0';
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One ratified-but-never-started scout plan (status='ready', op_status ≠ 'started'). */
export interface ScoutReadyCandidate {
  planSlug: string;
  title: string | null;
  /** Does the plan body contain at least one open item (`- **P-NNN** \`todo|wip\``) to promote? */
  hasOpenItems: boolean;
}

/** PURE: split ready candidates into startable (has items → auto-start) and
 *  itemless (→ debounced Queen decompose-wake). */
export function partitionReadyCandidates(candidates: readonly ScoutReadyCandidate[]): {
  startable: ScoutReadyCandidate[];
  itemless: ScoutReadyCandidate[];
} {
  const startable: ScoutReadyCandidate[] = [];
  const itemless: ScoutReadyCandidate[] = [];
  for (const c of candidates) (c.hasOpenItems ? startable : itemless).push(c);
  return { startable, itemless };
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

interface ReadyRow {
  plan_slug: string;
  title: string | null;
  has_open_items: boolean;
}

/** Read this hive's ratified-but-never-started scout plans. Same scoping rules as
 *  readScoutDraftCandidates: the hive's OWN workspaceId; scout-origin read from the
 *  plan's own frontmatter. */
export async function readScoutReadyCandidates(
  sql: Sql,
  planWorkspaceId: string,
  installSlug: string,
  opts: { limit?: number } = {},
): Promise<ScoutReadyCandidate[]> {
  const limit = opts.limit ?? 20;
  // Item syntax note (verified live 2026-07-02): plans:add-item writes
  // `- **P-001** \`todo\` <text>` — NOT a `- [ ]` checkbox. Match the canonical
  // marker with an OPEN status (todo|wip).
  const rows = await sql<ReadyRow[]>`
    SELECT plan_slug, title,
           (content ~ ('- [*][*]P-[0-9]+[*][*] ' || chr(96) || '(todo|wip)' || chr(96))) AS has_open_items
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${planWorkspaceId}
       AND harness_slug = ${installSlug}
       AND status = 'ready'
       AND archived = false
       AND (op_status IS NULL OR op_status <> 'started')
       AND content LIKE ${'%\norigin: scout\n%'}
     ORDER BY updated_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    planSlug: r.plan_slug,
    title: r.title,
    hasOpenItems: Boolean(r.has_open_items),
  }));
}

/** Start ONE ratified scout plan in the hive's own workspace: op_status='started'
 *  (idempotent — COALESCE keeps the first started_at) + promote its items into
 *  work_items. Returns the promoted work-item ids. Mirrors plans:start's core but
 *  workspace-correct for scout plans (see module header). */
export async function startReadyScoutPlan(
  sql: Sql,
  args: { workspaceId: string; installSlug: string; planSlug: string },
): Promise<{ transitioned: boolean; promoted: number; flagOff: boolean }> {
  const now = new Date().toISOString();
  const rows = await sql<{ prev_op_status: string | null }[]>`
    UPDATE harness_shared.harness_plans AS p
       SET op_status     = 'started',
           op_started_at = COALESCE(p.op_started_at, ${now}),
           op_updated_at = ${now}
      FROM (
        SELECT plan_slug, op_status AS prev_op_status
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${args.workspaceId}
           AND harness_slug = ${args.installSlug}
           AND plan_slug    = ${args.planSlug}
           FOR UPDATE
      ) prev
     WHERE p.workspace_id = ${args.workspaceId}
       AND p.harness_slug = ${args.installSlug}
       AND p.plan_slug    = prev.plan_slug
    RETURNING prev.prev_op_status`;
  const transitioned = rows.length > 0 && rows[0].prev_op_status !== 'started';
  if (!transitioned) return { transitioned: false, promoted: 0, flagOff: false };
  const result = await promotePlanItems({
    workspaceId: args.workspaceId,
    harnessSlug: args.installSlug,
    planSlug: args.planSlug,
    createdBy: 'scout-ready-autostart',
  });
  return { transitioned: true, promoted: result.promoted, flagOff: result.flagOff === true };
}

export interface ScoutReadyAutostartResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'started' | 'decompose-nudged' | 'skipped' | 'error';
  planSlug?: string;
  promoted?: number;
  reason: string;
}

/** Debounced Queen wake for a ready-but-ITEMLESS scout plan: she must decompose
 *  items (plans:add-item) — the next sweep then auto-starts it. */
async function fireDecomposeWake(
  workspaceId: string,
  queenOwner: string,
  itemless: readonly ScoutReadyCandidate[],
): Promise<void> {
  const list = itemless
    .slice(0, 5)
    .map((c) => `• ${c.planSlug}${c.title ? ` — ${c.title}` : ''}`)
    .join('\n');
  await wakeRecipients([queenOwner], {
    summary:
      `Scout ready-plan autostart: ${itemless.length} RATIFIED scout plan(s) have NO open items, so ` +
      `they cannot start (nothing to promote to work_items). Decompose each into 1–5 concrete items ` +
      `(plans:add-item) — the autostart sweep then starts it and promotes the items into your ` +
      `surveyable frontier automatically. Do not leave a ratified plan itemless (that is the plan-rail ` +
      `dead end, WI-1574).\n\n${list}`,
    payload: { kind: 'scout-ready-decompose', slugs: itemless.map((c) => c.planSlug) },
    source: 'scout-ready-decompose',
    workspaceId,
  });
}

/**
 * The ready-plan autostart sweep. For each STARTED hive: auto-start every ratified
 * (ready, never-started) scout plan that has open items — promoting its items into
 * work_items under the hive's own workspace — and fire a debounced decompose-wake
 * for ratified plans with no items. Never throws. DEFAULT-SAFE: nothing ready ⇒
 * nothing happens. Kill switch: PAPERCUSP_SCOUT_READY_AUTOSTART=0.
 */
export async function scoutReadyAutostartSweep(): Promise<ScoutReadyAutostartResult[]> {
  const results: ScoutReadyAutostartResult[] = [];
  if (!scoutReadyAutostartEnabled()) return results;
  try {
    const started = await listStartedPots();
    if (started.length === 0) return results;
    const { sql } = getOrgPg();
    for (const { workspaceId, installSlug } of started) {
      try {
        const candidates = await readScoutReadyCandidates(sql, workspaceId, installSlug);
        if (candidates.length === 0) continue;
        const { startable, itemless } = partitionReadyCandidates(candidates);
        for (const plan of startable) {
          try {
            const r = await startReadyScoutPlan(sql, { workspaceId, installSlug, planSlug: plan.planSlug });
            results.push({
              workspaceId,
              installSlug,
              outcome: r.transitioned ? 'started' : 'skipped',
              planSlug: plan.planSlug,
              promoted: r.promoted,
              reason: r.transitioned
                ? r.flagOff
                  ? 'auto-started BUT promotion no-oped: PLAN_WORKITEM_PROMOTION flag is OFF — items will NOT reach the Queen until it is flipped'
                  : `auto-started ratified scout plan; promoted ${r.promoted} item(s)`
                : 'already started (race)',
            });
          } catch (e) {
            results.push({
              workspaceId,
              installSlug,
              outcome: 'error',
              planSlug: plan.planSlug,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (itemless.length > 0) {
          // Debounce the WAKE (1h window) — the plans stay selected until items land,
          // so without the debounce every 30s tick would re-wake the Queen.
          const alreadyFired =
            (await recentWatchdogFires(workspaceId, installSlug, 1, 'scout-ready-decompose')) > 0;
          if (!alreadyFired) {
            const queenOwner = await resolveMugOwner(sql, workspaceId, installSlug);
            if (queenOwner) {
              await fireDecomposeWake(workspaceId, queenOwner, itemless);
              await recordFire({
                workspaceId,
                installSlug,
                source: 'scout-ready-decompose',
                reason: `${itemless.length} ratified itemless scout plan(s): ${itemless
                  .slice(0, 5)
                  .map((c) => c.planSlug)
                  .join(', ')}`,
                wakeAt: null,
              });
              results.push({
                workspaceId,
                installSlug,
                outcome: 'decompose-nudged',
                reason: `${itemless.length} itemless ready plan(s)`,
              });
            }
          }
        }
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[scout-ready-autostart] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
