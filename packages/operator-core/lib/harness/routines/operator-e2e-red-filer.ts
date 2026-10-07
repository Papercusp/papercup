/**
 * `system:operator-e2e-red-filer` — every red in the standing operator e2e run gets an owner
 * (plan operator-e2e-standing-isolated-run-2026-10-06 P-003, WI-10006806; umbrella WI-10006736).
 *
 * WHY. P-002's routine (`operator-e2e-isolated-action.ts`) runs the operator Playwright suite
 * nightly and its ledger reporter records one `harness_shared.test_runs` row per spec file under
 * the run group `operator-e2e-nightly:<fire>`. A ledger nobody reads is the failure WI-10006736
 * recorded: 40 of 58 specs had gone non-pass without anyone noticing. This sweep turns each red
 * spec in the newest COMPLETED nightly group into an owned work-item.
 *
 * WHY NOT THE EXISTING FILERS. Two filers already read `test_runs`, and neither fits a nightly
 * suite. The improvements watchdog's red-test collector (`improvements/watchdog.ts`) needs >= 3
 * failures in a 6h window, caps each source at 2 captures a tick, and files unassigned captures:
 * a spec that fails once a night never qualifies, and a 30-spec red night would take 15 ticks.
 * `testing:flakiness` autoFile files only flip-rate quarantine candidates. This module reuses
 * their pieces instead of their thresholds: the watchdog's repo-relative path normalization
 * (`normalizeRedTestPath`) and the shared create core (`createOneWorkItem`, which applies the
 * born-pending admission rules and the atomic create+claim).
 *
 * "ALREADY OWNED" (plan D-001 #2): an open work-item with a non-null assignee whose title or
 * summary names the spec. It is matched on the spec STEM as a whole token followed by `:` or
 * `.spec.` — the per-cluster items (WI-10006791 / WI-10006792) name specs as `home:15`, while a
 * filed item names the path. Two more outcomes keep the sweep idempotent without any watermark:
 *   - an item naming the spec that was CLOSED AFTER the group finished already answered this
 *     evidence (fixed or dropped since); the next red group re-files.
 *   - an OPEN but UNASSIGNED item naming the spec is assigned rather than duplicated.
 * So the same group can be swept every hour, and a spec red on two consecutive nights produces
 * exactly one owned item (P-003 acceptance).
 *
 * OWNER (plan D-002). The routine row's `payload_template.redOwner` names the owner explicitly.
 * Without one, the owner is the assignee of the umbrella item (`payload_template.umbrellaItem`,
 * default WI-10006736). With neither, the item is still filed, unassigned, and the result carries
 * `ownerUnresolved` so the routine's health shows the gap instead of hiding it.
 *
 * COMPLETENESS. A group whose run is still in flight (a pending/running task launched by
 * `system:operator-e2e-isolated`) is skipped: its ledger rows are partial until the reporter's
 * onEnd. The newest group that is NOT in flight is swept.
 */
import { listTasks } from '../../task-manager/store';
import { getOrgPg } from '@papercusp/db-org';
import { createOneWorkItem } from '../../agent-tools/work_items/_create-core';
import { claimWorkItem } from '../../work-items';
import { isTerminalStateInput } from '../../work-item-dispatch-states';
import { normalizeRedTestPath } from '../improvements/watchdog';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { OPERATOR_E2E_ISOLATED_ACTION, OPERATOR_E2E_RUN_GROUP_PREFIX } from './operator-e2e-isolated-action';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const OPERATOR_E2E_RED_FILER_ACTION = 'operator-e2e-red-filer';
/** The creator identity stamped on filed items. */
export const OPERATOR_E2E_RED_FILER_OWNER_ID = `system:${OPERATOR_E2E_RED_FILER_ACTION}`;
/** The umbrella item whose assignee owns reds when the routine names no explicit owner. */
export const OPERATOR_E2E_UMBRELLA_ITEM = 'WI-10006736';
/** How far back to look for nightly groups. A week covers a missed run or two. */
export const OPERATOR_E2E_GROUP_LOOKBACK_DAYS = 7;
/** Output kept on a filed item: enough for the failing assertion, bounded for the item body. */
export const OPERATOR_E2E_RED_TAIL_CHARS = 1_500;

const RED_STATUSES = new Set(['fail', 'error']);

export interface GroupSpecRow {
  filePath: string;
  status: string;
  finishedAt: string;
  outputTail: string | null;
  failedCaseTitles: string[];
}

export interface RedSpec {
  specPath: string;
  status: string;
  finishedAt: string;
  outputTail: string | null;
  failedCaseTitles: string[];
}

export interface OwnershipCandidate {
  id: string;
  status: string;
  assignee: string | null;
  closedAt: string | null;
  title: string;
  summary: string | null;
}

export type Ownership =
  | { kind: 'owned'; id: string; assignee: string }
  | { kind: 'resolved-after-evidence'; id: string }
  | { kind: 'unassigned-open'; id: string }
  | { kind: 'none' };

/** PURE: `apps/operator/e2e/home.spec.ts` -> `home`. */
export function specStem(specPath: string): string {
  const base = specPath.split('/').pop() ?? specPath;
  return base.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '').replace(/\.[cm]?[jt]sx?$/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PURE: a regex (valid in both JavaScript and Postgres ARE) that matches text NAMING the spec:
 * its stem as a whole token followed by `:` (a cluster item's `home:15`) or `.spec.` (a path).
 * `workspace-home:12` does not name `home`, because `-` counts as part of the token.
 */
export function specMentionPattern(specPath: string): string {
  return `(^|[^A-Za-z0-9_-])${escapeRegex(specStem(specPath))}(:[0-9]|\\.spec\\.)`;
}

export function namesSpec(text: string | null | undefined, specPath: string): boolean {
  return text != null && new RegExp(specMentionPattern(specPath)).test(text);
}

/** PURE: the latest row per spec in one group, kept only when that latest row is red. */
export function redSpecsFromGroupRows(rows: readonly GroupSpecRow[]): RedSpec[] {
  const latest = new Map<string, GroupSpecRow>();
  for (const row of rows) {
    const specPath = normalizeRedTestPath(row.filePath);
    if (specPath == null) continue;
    const prev = latest.get(specPath);
    if (!prev || Date.parse(row.finishedAt) > Date.parse(prev.finishedAt)) latest.set(specPath, { ...row, filePath: specPath });
  }
  return [...latest.values()]
    .filter((row) => RED_STATUSES.has(row.status))
    .map((row) => ({
      specPath: row.filePath,
      status: row.status,
      finishedAt: row.finishedAt,
      outputTail: row.outputTail,
      failedCaseTitles: row.failedCaseTitles,
    }))
    .sort((a, b) => a.specPath.localeCompare(b.specPath));
}

/**
 * PURE: decide whether a red spec already has an answer (plan D-001 #2). An open assigned item
 * wins; then an item closed after the evidence; then an open unassigned item to adopt.
 */
export function classifyOwnership(
  specPath: string,
  candidates: readonly OwnershipCandidate[],
  groupFinishedAt: string,
): Ownership {
  const naming = candidates.filter((c) => namesSpec(c.title, specPath) || namesSpec(c.summary, specPath));
  const open = naming.filter((c) => !isTerminalStateInput(c.status));
  const owned = open.find((c) => c.assignee != null && c.assignee.trim() !== '');
  if (owned) return { kind: 'owned', id: owned.id, assignee: owned.assignee as string };
  const evidenceMs = Date.parse(groupFinishedAt);
  const answered = naming.find(
    (c) => isTerminalStateInput(c.status) && c.closedAt != null && Date.parse(c.closedAt) >= evidenceMs,
  );
  if (answered) return { kind: 'resolved-after-evidence', id: answered.id };
  if (open[0]) return { kind: 'unassigned-open', id: open[0].id };
  return { kind: 'none' };
}

/** PURE: the filed item's title and summary. */
export function renderRedItem(red: RedSpec, runGroup: string): { title: string; summary: string } {
  const cases =
    red.failedCaseTitles.length > 0
      ? red.failedCaseTitles.map((title) => `- ${title}`).join('\n')
      : '- (the ledger row carries no case identities; read the output tail below)';
  const tail = (red.outputTail ?? '').replace(/\u001b\[[0-9;]*m/g, '').slice(-OPERATOR_E2E_RED_TAIL_CHARS);
  return {
    title: `Operator e2e red: ${red.specPath}`,
    summary:
      `${red.specPath} finished ${red.status} in the standing isolated operator e2e run ` +
      `(run group ${runGroup}, finished ${red.finishedAt}). Filed by ${OPERATOR_E2E_RED_FILER_OWNER_ID} ` +
      `(plan operator-e2e-standing-isolated-run-2026-10-06 P-003): every red in that run gets one owned item.\n\n` +
      `Failing tests:\n${cases}\n\n` +
      `Re-run just this spec in the isolated rig: npm --prefix apps/operator run test:e2e:isolated -- ${red.specPath}\n` +
      `Decide whether the spec is stale (the product changed on purpose) or the product regressed, and fix that side.\n\n` +
      `Output tail:\n${tail || '(no output captured)'}`,
  };
}

export interface LatestGroup {
  runGroup: string;
  finishedAt: string;
}

export interface RedFilerDeps {
  /** Newest-first nightly groups recorded for this workspace inside the lookback. */
  listGroups(workspaceId: string): Promise<LatestGroup[]>;
  /** Run groups of runs that are still in flight. */
  inFlightGroups(workspaceId: string): Promise<string[]>;
  groupRows(runGroup: string): Promise<GroupSpecRow[]>;
  ownershipCandidates(workspaceId: string, harnessSlug: string, specPath: string): Promise<OwnershipCandidate[]>;
  /** The assignee of `id`, or null when unassigned or missing. */
  assigneeOf(id: string, harnessSlug: string): Promise<string | null>;
  create(args: Parameters<typeof createOneWorkItem>[0], ctx: Parameters<typeof createOneWorkItem>[1]): Promise<{ id: string | null; error?: string }>;
  assign(id: string, owner: string, harnessSlug: string): Promise<boolean>;
}

export interface RedFilingOutcome {
  specPath: string;
  outcome: 'filed' | 'assigned' | 'owned' | 'resolved-after-evidence' | 'unassigned-open' | 'error';
  id?: string;
  detail?: string;
}

export interface RedFilerResult {
  status: 'swept' | 'skipped';
  reason?: string;
  runGroup?: string;
  reds?: number;
  owner?: string | null;
  ownerUnresolved?: boolean;
  outcomes?: RedFilingOutcome[];
}

export async function resolveRedOwner(
  ctx: Pick<SystemActionCtx, 'payloadTemplate'>,
  harnessSlug: string,
  deps: Pick<RedFilerDeps, 'assigneeOf'>,
): Promise<string | null> {
  const template = ctx.payloadTemplate ?? {};
  const explicit = typeof template.redOwner === 'string' ? template.redOwner.trim() : '';
  if (explicit) return explicit;
  const umbrella =
    typeof template.umbrellaItem === 'string' && template.umbrellaItem.trim() !== ''
      ? template.umbrellaItem.trim()
      : OPERATOR_E2E_UMBRELLA_ITEM;
  return deps.assigneeOf(umbrella, harnessSlug).catch(() => null);
}

export async function fileOperatorE2eReds(
  ctx: Pick<SystemActionCtx, 'installSlug' | 'workspaceId' | 'payloadTemplate'>,
  deps: RedFilerDeps = defaultRedFilerDeps(),
): Promise<RedFilerResult> {
  const home = operatorHomeHarnessSlug();
  if (ctx.installSlug && ctx.installSlug !== home) {
    return { status: 'skipped', reason: `not the operator-home harness (got "${ctx.installSlug}", home is "${home}")` };
  }
  const harnessSlug = ctx.installSlug || home;
  const [groups, inFlight] = await Promise.all([deps.listGroups(ctx.workspaceId), deps.inFlightGroups(ctx.workspaceId)]);
  const busy = new Set(inFlight);
  const group = groups.find((g) => !busy.has(g.runGroup));
  if (!group) {
    return {
      status: 'skipped',
      reason: groups.length === 0 ? 'no nightly run group in the lookback' : 'the only recent group is still running',
    };
  }
  const reds = redSpecsFromGroupRows(await deps.groupRows(group.runGroup));
  const owner = reds.length > 0 ? await resolveRedOwner(ctx, harnessSlug, deps) : null;
  const outcomes: RedFilingOutcome[] = [];
  for (const red of reds) {
    try {
      const ownership = classifyOwnership(
        red.specPath,
        await deps.ownershipCandidates(ctx.workspaceId, harnessSlug, red.specPath),
        group.finishedAt,
      );
      if (ownership.kind === 'owned' || ownership.kind === 'resolved-after-evidence') {
        outcomes.push({ specPath: red.specPath, outcome: ownership.kind, id: ownership.id });
        continue;
      }
      if (ownership.kind === 'unassigned-open') {
        const assigned = owner ? await deps.assign(ownership.id, owner, harnessSlug) : false;
        outcomes.push({
          specPath: red.specPath,
          outcome: assigned ? 'assigned' : 'unassigned-open',
          id: ownership.id,
          ...(owner ? {} : { detail: 'no owner resolved' }),
        });
        continue;
      }
      const { title, summary } = renderRedItem(red, group.runGroup);
      const created = await deps.create(
        {
          kind: 'bug',
          title,
          summary,
          harness: harnessSlug,
          severity: 'major',
          ...(owner ? { assign_to: owner } : {}),
          payload: {
            source: OPERATOR_E2E_RED_FILER_ACTION,
            specPath: red.specPath,
            runGroup: group.runGroup,
            failedCaseTitles: red.failedCaseTitles,
            plan: 'operator-e2e-standing-isolated-run-2026-10-06',
            umbrella: OPERATOR_E2E_UMBRELLA_ITEM,
          },
        },
        { ownerId: OPERATOR_E2E_RED_FILER_OWNER_ID, workspaceId: ctx.workspaceId, harnessSlug },
      );
      outcomes.push(
        created.id
          ? { specPath: red.specPath, outcome: 'filed', id: created.id }
          : { specPath: red.specPath, outcome: 'error', detail: created.error ?? 'create_failed' },
      );
    } catch (error) {
      outcomes.push({ specPath: red.specPath, outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  // A routine-level owner is only required when this sweep leaves red work unassigned.
  // Existing assigned items and items resolved after the test evidence need no new owner.
  const ownerUnresolved =
    owner == null && outcomes.some((outcome) => outcome.outcome === 'filed' || outcome.outcome === 'unassigned-open');
  return {
    status: 'swept',
    runGroup: group.runGroup,
    reds: reds.length,
    owner,
    ownerUnresolved,
    outcomes,
  };
}

/** The live implementations. Every query is workspace-scoped and bounded. */
export function defaultRedFilerDeps(): RedFilerDeps {
  const prefix = `${OPERATOR_E2E_RUN_GROUP_PREFIX}:%`;
  return {
    async listGroups(workspaceId) {
      const { sql } = getOrgPg();
      const rows = await sql<{ run_group_id: string; finished_at: Date | string }[]>`
        SELECT run_group_id, max(finished_at) AS finished_at
          FROM harness_shared.test_runs
         WHERE run_group_id LIKE ${prefix}
           AND workspace_id = ${workspaceId}
           AND created_at > now() - make_interval(days => ${OPERATOR_E2E_GROUP_LOOKBACK_DAYS})
         GROUP BY run_group_id
         ORDER BY max(finished_at) DESC
         LIMIT 10`;
      return rows.map((r) => ({ runGroup: r.run_group_id, finishedAt: new Date(r.finished_at).toISOString() }));
    },
    async inFlightGroups(workspaceId) {
      const rows = await listTasks({
        workspaceId,
        launchedBy: `system:${OPERATOR_E2E_ISOLATED_ACTION}`,
        states: ['pending', 'running'],
        limit: 5,
      });
      return rows
        .map((row) => (row.detail as { runGroup?: unknown } | null | undefined)?.runGroup)
        .filter((group): group is string => typeof group === 'string');
    },
    async groupRows(runGroup) {
      const { sql } = getOrgPg();
      const rows = await sql<{ file_path: string; status: string; finished_at: Date | string; output_tail: string | null; titles: unknown }[]>`
        SELECT file_path, status, finished_at, output_tail, execution_details->'failedCaseTitles' AS titles
          FROM harness_shared.test_runs
         WHERE run_group_id = ${runGroup}
         ORDER BY finished_at DESC
         LIMIT 500`;
      return rows.map((r) => ({
        filePath: r.file_path,
        status: r.status,
        finishedAt: new Date(r.finished_at).toISOString(),
        outputTail: r.output_tail,
        failedCaseTitles: Array.isArray(r.titles) ? r.titles.filter((t): t is string => typeof t === 'string') : [],
      }));
    },
    async ownershipCandidates(workspaceId, harnessSlug, specPath) {
      const { sql } = getOrgPg();
      const pattern = specMentionPattern(specPath);
      const rows = await sql<{ feature_id: string; status: string; taken_by: string | null; closed_ts: Date | string | null; title: string; summary: string | null }[]>`
        SELECT feature_id, status, taken_by, closed_ts, title, summary
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND lane IS DISTINCT FROM 'observation'
           AND (title ~ ${pattern} OR coalesce(summary, '') ~ ${pattern})
         ORDER BY updated_ts DESC
         LIMIT 25`;
      return rows.map((r) => ({
        id: r.feature_id,
        status: r.status,
        assignee: r.taken_by,
        closedAt: r.closed_ts == null ? null : new Date(r.closed_ts).toISOString(),
        title: r.title,
        summary: r.summary,
      }));
    },
    async assigneeOf(id, harnessSlug) {
      const { sql } = getOrgPg();
      const rows = await sql<{ taken_by: string | null; status: string }[]>`
        SELECT taken_by, status FROM harness_shared.work_items
         WHERE feature_id = ${id} AND harness_slug = ${harnessSlug}
         LIMIT 1`;
      const row = rows[0];
      return row && !isTerminalStateInput(row.status) && row.taken_by ? row.taken_by : null;
    },
    async create(args, ctx) {
      const res = await createOneWorkItem(args, ctx);
      return res.ok ? { id: res.workItem.id } : { id: null, error: res.error ?? 'create_failed' };
    },
    async assign(id, owner, harnessSlug) {
      const claimed = await claimWorkItem(id, owner, { harness: harnessSlug, assignedBy: OPERATOR_E2E_RED_FILER_OWNER_ID });
      return claimed != null;
    },
  };
}

registerSystemAction(
  OPERATOR_E2E_RED_FILER_ACTION,
  async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
    const result = await fileOperatorE2eReds(ctx);
    const errors = (result.outcomes ?? []).filter((o) => o.outcome === 'error');
    if (result.status === 'skipped') console.log(`[${OPERATOR_E2E_RED_FILER_ACTION}] skip: ${result.reason}`);
    return {
      diagnostics: { ...result },
      ...(errors.length > 0
        ? { softError: `${errors.length} red spec(s) could not be filed: ${errors.map((e) => `${e.specPath} (${e.detail})`).join('; ').slice(0, 500)}` }
        : result.ownerUnresolved
          ? { softError: 'reds were filed without an owner: set payload_template.redOwner or assign the umbrella item' }
          : {}),
    };
  },
  { routineTimeoutMs: 120_000 },
);
