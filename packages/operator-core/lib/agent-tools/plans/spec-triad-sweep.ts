/**
 * SPEC TRIAD auto-file sweep — okf-frontmatter-adoption workstream H(b).
 *
 * This is the half that makes the triad requirement a QUEUE rather than a WALL.
 *
 * `plans:items` holds an in-scope plan's items back from `actionable` when the
 * plan owes `## Requirements` / `## Design` (spec-triad-policy.ts). On its own
 * that is a gate with no exit — the work stops and waits for someone to notice.
 * This sweep is the exit: for every plan that owes the triad it files ONE work
 * item, unassigned, which any agent can claim through the ordinary claim path.
 * The gate then resolves itself.
 *
 * That structure is deliberate and non-negotiable per the standing design
 * mandate: a design that routes a decision to a person is a defect. Nothing here
 * escalates, notifies a human, or waits for approval — it files claimable work.
 *
 * ## Safety rails, in the order they matter
 *
 *  1. **Bounded filing.** At most {@link SPEC_TRIAD_MAX_FILINGS_PER_RUN} items per
 *     run. If the epoch is ever moved backwards by mistake, the blast radius is
 *     one batch and a loud log line — not several hundred work items.
 *  2. **Idempotent.** Each filing stamps `payload.specTriadPlan` with the plan's
 *     fully-qualified ref; a plan with a non-terminal filing already open is
 *     skipped. Re-running the sweep is a no-op, which is what lets it be daily.
 *  3. **Cheap candidate selection.** Phase 1 reads plan METADATA only (no
 *     `content`) so the common case costs one small scan; phase 2 fetches content
 *     for the handful of rows that survive the scope test. A naive
 *     `SELECT content FROM harness_plans` would move tens of MB per tick.
 *  4. **Never throws.** A thrown step makes DBOS mark the workflow permanently
 *     dead — i.e. a transient error would stop the sweep FOREVER, silently. Every
 *     leg degrades to a warn.
 *
 * Kill-switch: `PAPERCUSP_SPEC_TRIAD_SWEEP=0`, or turn the
 * `SPEC_TRIAD_REQUIRED` flag off (which also un-gates `plans:items`).
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { describeSpecTriadGap } from '@papercusp/plan-parser';
import { createWorkItem } from '../../work-items';
import { specTriadGate, specTriadEpoch, planInSpecTriadScope } from './spec-triad-policy';

/** Upper bound on work items filed in a single run. See the rails note above. */
export const SPEC_TRIAD_MAX_FILINGS_PER_RUN = 25;

/** Plan statuses that still have work ahead of them. */
const LIVE_PLAN_STATUSES = ['draft', 'ready', 'active'];

/** Work-item statuses that mean "this filing is still outstanding". */
const NON_TERMINAL_STATUSES = ['open', 'todo', 'wip', 'in_progress', 'blocked', 'needs-human', 'validating', 'failing'];

export interface SpecTriadSweepResult {
  skipped: boolean;
  reason?: string;
  /** Plans whose metadata was examined. */
  scanned: number;
  /** Plans in scope for the requirement. */
  inScope: number;
  /** In-scope plans missing at least one leg. */
  owing: number;
  /** Work items filed this run. */
  filed: number;
  /** Owing plans that already had an open filing. */
  alreadyFiled: number;
  /** Owing plans left unfiled because the per-run cap was hit. */
  deferred: number;
  filedIds: string[];
  summary: string;
}

interface PlanMetaRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  created: string | null;
  has_declaration: boolean;
}

interface PlanContentRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  created: string | null;
  content: string;
  items: unknown;
}

function planRef(r: { workspace_id: string; harness_slug: string; plan_slug: string }): string {
  return `${r.workspace_id}/${r.harness_slug}/${r.plan_slug}`;
}

function itemCountOf(items: unknown): number | undefined {
  return Array.isArray(items) ? items.length : undefined;
}

export interface SpecTriadSweepOptions {
  /** Override the per-run filing cap (tests). */
  maxFilings?: number;
  /** Skip the flag read (tests / a caller that already resolved it). */
  flagEnabled?: boolean;
}

export async function runSpecTriadSweepOnce(
  opts: SpecTriadSweepOptions = {},
): Promise<SpecTriadSweepResult> {
  const empty = (skipReason: string): SpecTriadSweepResult => ({
    skipped: true,
    reason: skipReason,
    scanned: 0,
    inScope: 0,
    owing: 0,
    filed: 0,
    alreadyFiled: 0,
    deferred: 0,
    filedIds: [],
    summary: `skipped: ${skipReason}`,
  });

  if (process.env.PAPERCUSP_SPEC_TRIAD_SWEEP === '0') return empty('kill-switch');

  let flagEnabled = opts.flagEnabled;
  if (flagEnabled === undefined) {
    try {
      flagEnabled = await getFlag(FLAGS.SPEC_TRIAD_REQUIRED, 'system:spec-triad-sweep');
    } catch {
      // Fail CLOSED for the sweep (the opposite of plans:items, deliberately):
      // this side WRITES. An unreadable flag store must not be able to file work
      // items nobody asked for.
      return empty('flag unreadable');
    }
  }
  if (!flagEnabled) return empty('flag off');

  const epoch = specTriadEpoch();
  const maxFilings = opts.maxFilings ?? SPEC_TRIAD_MAX_FILINGS_PER_RUN;
  const { sql } = getOrgPg();

  // Phase 1 — metadata only. `content` is deliberately NOT selected here; the
  // `specTriad:` probe is pushed into SQL as a boolean so a pre-epoch plan that
  // OPTED IN is still a candidate without transferring every plan body.
  let metas: PlanMetaRow[] = [];
  try {
    metas = (await sql`
      SELECT workspace_id,
             harness_slug,
             plan_slug,
             created,
             (content LIKE '%specTriad:%') AS has_declaration
        FROM harness_shared.harness_plans
       WHERE archived = false
         AND is_legacy = false
         AND (status IS NULL OR status = ANY(${LIVE_PLAN_STATUSES}))
    `) as unknown as PlanMetaRow[];
  } catch (err) {
    return empty(`plan scan failed: ${(err as Error).message}`);
  }

  // Scope test on metadata alone. A plan carrying a `specTriad:` declaration
  // always needs its content read (the declaration decides scope in BOTH
  // directions, and phase 1 cannot tell `required` from `exempt`).
  const candidates = metas.filter((m) => {
    if (m.has_declaration) return true;
    return planInSpecTriadScope({ content: '', created: m.created }, { flagEnabled: true, epoch })
      .inScope;
  });

  if (candidates.length === 0) {
    return {
      skipped: false,
      scanned: metas.length,
      inScope: 0,
      owing: 0,
      filed: 0,
      alreadyFiled: 0,
      deferred: 0,
      filedIds: [],
      summary: `${metas.length} live plan(s) scanned, none in scope for the spec triad`,
    };
  }

  // Phase 2 — content for the survivors only.
  const slugs = candidates.map((c) => c.plan_slug);
  let rows: PlanContentRow[] = [];
  try {
    rows = (await sql`
      SELECT workspace_id, harness_slug, plan_slug, created, content, items
        FROM harness_shared.harness_plans
       WHERE archived = false
         AND is_legacy = false
         AND plan_slug = ANY(${slugs})
    `) as unknown as PlanContentRow[];
  } catch (err) {
    return empty(`plan content read failed: ${(err as Error).message}`);
  }

  const candidateKeys = new Set(candidates.map(planRef));
  const owing: Array<{ row: PlanContentRow; missing: string[]; gap: string }> = [];
  let inScope = 0;

  for (const row of rows) {
    if (!candidateKeys.has(planRef(row))) continue; // the ANY(slugs) can widen across tenants
    const verdict = specTriadGate(
      {
        planSlug: row.plan_slug,
        content: row.content,
        created: row.created,
        itemCount: itemCountOf(row.items),
      },
      { flagEnabled: true, epoch },
    );
    if (verdict.scope.inScope) inScope++;
    if (!verdict.gated || !verdict.triad) continue;
    owing.push({ row, missing: verdict.missing, gap: describeSpecTriadGap(verdict.triad) });
  }

  // Which owing plans already have an outstanding filing?
  let alreadyOpen = new Set<string>();
  try {
    const existing = (await sql`
      SELECT DISTINCT payload->>'specTriadPlan' AS ref
        FROM harness_shared.work_items
       WHERE payload->>'specTriadPlan' IS NOT NULL
         AND status = ANY(${NON_TERMINAL_STATUSES})
    `) as unknown as Array<{ ref: string | null }>;
    alreadyOpen = new Set(existing.map((e) => e.ref).filter((r): r is string => !!r));
  } catch (err) {
    // Cannot prove absence ⇒ do not file. Filing duplicates every day is worse
    // than filing nothing today; the next run retries.
    return empty(`dedupe read failed: ${(err as Error).message}`);
  }

  const toFile = owing.filter((o) => !alreadyOpen.has(planRef(o.row)));
  const batch = toFile.slice(0, maxFilings);
  const deferred = toFile.length - batch.length;

  const filedIds: string[] = [];
  for (const { row, missing, gap } of batch) {
    const ref = planRef(row);
    try {
      const item = await createWorkItem({
        kind: 'task',
        harness: row.harness_slug,
        workspaceId: row.workspace_id,
        createdBy: 'system:spec-triad-sweep',
        title: `Write the spec triad for plan '${row.plan_slug}' — missing ${missing.join(' + ')}`,
        summary:
          `Plan \`${row.plan_slug}\` is in scope for the SPEC TRIAD (okf-frontmatter-adoption H(b)) ` +
          `and is missing: ${gap}\n\n` +
          `Its items are held back from \`plans:items { actionable: true }\` until the sections are ` +
          `written — so this is not paperwork, it is what unblocks that plan's lane.\n\n` +
          `**To resolve**, add to the plan (\`plans:set-content\` / \`plans:edit\`):\n` +
          `- \`## Requirements\` — what the change must be true of when it is done. Not a task list.\n` +
          `- \`## Design\` — how it will be built, and the trade-off you settled.\n` +
          `- \`P-NNN\` items — the tasks themselves (\`plans:add-item\`).\n\n` +
          `A heading with nothing under it does NOT satisfy the check, and neither does \`TBD\` — ` +
          `the detector requires real body content (\`evaluateSpecTriad\`, @papercusp/plan-parser).\n\n` +
          `**If the triad genuinely does not apply to this plan**, that is a legitimate answer: add ` +
          `\`specTriad: exempt\` to its frontmatter and close this item with that as the completion ` +
          `evidence. The requirement is not meant to be a wall.`,
        payload: { specTriadPlan: ref, planSlug: row.plan_slug, missing },
      });
      const id = (item as { feature_id?: string; id?: string }).feature_id ?? (item as { id?: string }).id;
      if (id) filedIds.push(id);
    } catch (err) {
      console.warn(`[spec-triad-sweep] filing for ${ref} failed (non-fatal): ${(err as Error).message}`);
    }
  }

  const summary =
    `${metas.length} live plan(s) scanned · ${inScope} in scope · ${owing.length} owing the triad · ` +
    `${filedIds.length} filed · ${owing.length - toFile.length} already filed` +
    (deferred > 0 ? ` · ${deferred} DEFERRED past the ${maxFilings}/run cap` : '');

  return {
    skipped: false,
    scanned: metas.length,
    inScope,
    owing: owing.length,
    filed: filedIds.length,
    alreadyFiled: owing.length - toFile.length,
    deferred,
    filedIds,
    summary,
  };
}
