/**
 * work_items:list — cross-kind list over the unified surface (unify-work-items,
 * D-007). Default = top-level items only; chunks surface under their parent (D-004,
 * pass `parent` or includeChildren). Filter by harness / kind / state.
 */
import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../coordination/roles";
import { resolveAgentIdentity } from "../coordination/identity";
import {
  listWorkItems,
  type WorkItemKind,
} from "../../work-items";
import { boundRowField } from "../_bound-output";
import {
  COMPLETION_AUDITS,
  COMPLETION_AUTHORITY_FILTERS,
  type CompletionAuthorityFilter,
} from "../../completion-audit";
import { cachedRead, type CachedReadCtx } from "../../cache";

/**
 * SWR backstop for work_items:list (cache-expensive-tool-reads-2026-06-22 P-005).
 * The unified work-item table (harness_features_consolidated) carries the generic
 * .changed trigger, so any work-item write auto-invalidates the entry via the
 * cache-ECA (table tag below) — this short soft TTL only bounds staleness for any
 * dependency dimension a trigger doesn't cover. work_items:list is an OVERVIEW read,
 * decoupled from the scheduler claim hot path (claim_next), so caching it does NOT
 * touch the maintained readiness floor (D-004).
 */
const WORK_ITEMS_LIST_SOFT_TTL_MS = 20_000;

/**
 * Output `data` schema (token-efficient-tool-result-formats P-011). The result
 * is the bare WorkItem array — the row count rides in TOON's self-describing
 * `[N]{…}:` header, so the old `{ ok, count, items }` wrapper is redundant. This
 * unlocks the compact format for a high-traffic list tool (≈ −32% tokens for
 * agents). `payload` is `unknown`, so the schema proves TOON-eligibility but not
 * CSV; rows that happen to have a null payload still serialize as CSV on an
 * explicit request via the serializer's runtime flatness check.
 */
const WORK_ITEM_ROW = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  /** EI-1597: in list rows the summary is EXCERPTED (budget-aware) so a large backlog
   *  can't overflow the agent result cap; these flag a cut row. Full body via work_items:get. */
  summary_truncated: z.literal(true).optional(),
  summary_full_chars: z.number().optional(),
  state: z.string(),
  assignee: z.string().nullable(),
  assignedBy: z.string().nullable(),
  severity: z.string().nullable(),
  parent: z.string().nullable(),
  payload: z.unknown(),
  /** Shared backlog priority (feature_order) — LOWER = claimed sooner; null = unprioritized.
   *  Feature-family only (the Queen's steer lever, B7); issue-family is always null. */
  priority: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The completion prose recorded at terminal transition (work_items:complete's
   *  `completion.summary`), if any — always present on the row. */
  terminalCompletionRef: z.string().nullable().optional(),
  /** Structured verification evidence (testsRun/testResult/verifiedHow/filesChanged/
   *  addedTests), if the completion supplied any. P-004 makes this REQUIRED for a close
   *  to reach `committed`; a close without it lands `authority:'proposed'` instead. */
  terminalCompletionEvidence: z.record(z.string(), z.unknown()).nullable().optional(),
  /** P-004's judgement about this row's completion evidence ('committed' | 'proposed' |
   *  'validated' | 'pending_human' | 'invalid'), or null when the close was never judged
   *  — only `work_items:complete` stamps it, so a bare state-write close reads null
   *  regardless of how well evidenced it was. Declared here so the `completionAuthority`
   *  FILTER's own value is visible on the rows it returns (the schema strips undeclared
   *  keys, so an omitted field would silently blank a column the caller just filtered on). */
  completionAuthority: z.string().nullable().optional(),
});

// EI-1597: bound each list row's summary so a large backlog can't overflow the agent
// result cap (work_items:list returns the full WorkItem array; a 40-item backlog hit
// 73KB of summaries on one line). Per-row cap = min(SUMMARY_ROW_CAP, floor(BUDGET/n))
// — the budget-aware bound coord:inbox (EI-1752) + plans:get (WI-274) use: total
// summary text stays <= BUDGET at ANY list size, while small lists keep most rows full.
// Full body is always available via work_items:get { id }.
export const SUMMARY_ROW_CAP = 240;
export const SUMMARIES_TOTAL_BUDGET = 16_000;

// EI-1597: a thin semantic wrapper over the shared budget-aware bound — single
// source of truth for the per-field excerpt (was an inlined copy of the loop).
export function boundSummaries<T extends { summary?: string | null }>(
  rows: T[],
): T[] {
  return boundRowField(
    rows,
    "summary",
    SUMMARY_ROW_CAP,
    SUMMARIES_TOTAL_BUDGET,
  );
}

/**
 * Payload-tier shapers (context-trimming-tiers-2026-07-01 P-012). A trimmed/
 * standard session projects each row to its placement-relevant core — the
 * summary excerpt, timestamps, and the fat `payload` subtree are the measured
 * token sinks (~1 token/char over a UUID-dense backlog in the 2026-07-01 fleet
 * incident). Rows keep a UNIFORM key set per tier (null over absent) so TOON's
 * tabular form still applies; `payload.plan_item` is flattened to a short
 * `plan_ref` string ("slug#P-NNN"). No silent caps (D-004): a sliced list
 * appends a visible `(truncated)` notice row carrying the fetch-pointer.
 */
const LIST_TIER_CAPS = {
  trimmed: { rows: 40, title: 90, summary: 0 },
  standard: { rows: 120, title: 160, summary: 140 },
} as const;

export function shapeWorkItemsList(
  data: unknown,
  tier: keyof typeof LIST_TIER_CAPS,
): unknown {
  if (!Array.isArray(data)) return data;
  const c = LIST_TIER_CAPS[tier];
  const clip = (s: unknown, n: number): string | null =>
    typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;
  const project = (row: unknown): unknown => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const planItem = (
      r.payload as
        | { plan_item?: { plan_slug?: unknown; item_id?: unknown } | null }
        | null
        | undefined
    )?.plan_item;
    const planRef =
      planItem && typeof planItem === "object"
        ? `${String(planItem.plan_slug ?? "?")}#${String(planItem.item_id ?? "?")}`
        : null;
    return {
      id: r.id ?? null,
      kind: r.kind ?? null,
      harness: r.harness ?? null,
      title: clip(r.title, c.title),
      ...(c.summary > 0 ? { summary: clip(r.summary, c.summary) } : {}),
      state: r.state ?? null,
      assignee: r.assignee ?? null,
      severity: r.severity ?? null,
      priority: r.priority ?? null,
      plan_ref: planRef,
    };
  };
  const rows = data.slice(0, c.rows).map(project);
  if (data.length > c.rows) {
    rows.push({
      id: "(truncated)",
      kind: "notice",
      harness: null,
      title: `showing ${c.rows} of ${data.length} — narrow with state/kind/limit, work_items:get {id} for detail, or payloadTier:"full"`,
      ...(c.summary > 0 ? { summary: null } : {}),
      state: null,
      assignee: null,
      severity: null,
      priority: null,
      plan_ref: null,
    });
  }
  return rows;
}

export default defineTool({
  name: "work_items:list",
  profile: "engineer",
  description:
    "List work-items across kinds (feature/chunk/bug/change/task). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state. Returns the WorkItem array directly — each row's summary is EXCERPTED to keep the list bounded (a row carries summary_truncated + summary_full_chars when cut); use work_items:get { id } for a full body.",
  guidance: {
    when: "You want the current work-items in a harness (or operator-wide). Default hides chunks; pass `parent` to see a parent's chunks. Each row carries `priority` (the shared backlog order, LOWER = claimed sooner) so the Mug can read the whole backlog's order in one call before steering it with work_items:set_priority.",
    chaining:
      "work_items:list → work_items:get { id } for detail; work_items:claim to take one; work_items:set_priority to re-order the backlog.",
    notWhen:
      "EI-7589: a row's `assignee:null` does NOT by itself mean 'unclaimed' when the row carries a `plan_item`/`plan_ref` link (payload.plan_item, or the trimmed/standard `plan_ref` field) — a plan-item can be under active coverage (effectiveStatus 'wip', a live worker holding it) while the work-item row's own assignee stays null. Before self-claiming a plan-linked row, cross-check `plans:items { slug }` for that item's effectiveStatus — do not trust the bare assignee field alone, or you risk duplicating in-flight work.",
    seeAlso: [
      'work_items:claimable (issue-family: how many / which are ACTUALLY claimable — the full claim floors, unlike admissibleOnly here)',
      'work_items:set_priority (steer the backlog order you just read)',
      'work_items:get (full detail on specific ids)',
      'work_items:claim_next (take the next claimable item)',
      'plans:items (the effectiveStatus / live-coverage source of truth for a plan-linked row)',
    ],
  },
  capability: "work_items:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional(),
    // P-001/P-011 generic-kind: a built-in kind OR a workspace-registered generic-kind
    // datatype (declared via meta:define-datatype). familyOf() maps any non-issue kind to
    // the feature family + featureFamilyKindClause admits registered generic kinds, so the
    // filter works downstream; an unknown kind simply lists empty. Enum-locking this arg
    // was the observability gap — the queue could hold demo-bet rows the list tool refused
    // to filter by. Free string mirrors work_items:create.
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype',
      ),
    state: z.string().max(40).optional(),
    assignee: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Filter to items assigned to this agent (feature → taken_by; issue → assignee). Use `mine: true` instead to mean \"me\" without naming your own id.",
      ),
    mine: z
      .boolean()
      .optional()
      .describe(
        "Filter to items assigned to the CALLER (resolves your own agent identity) — EI-6506: a leader's 'see your work item' handoff, findable without raw PG or knowing your own ownerId string. Overridden by an explicit `assignee` if both are passed.",
      ),
    parent: z
      .string()
      .max(80)
      .optional()
      .describe("list children (chunks) of this parent id"),
    includeChildren: z
      .boolean()
      .optional()
      .describe("include child items (chunks) in the list"),
    admissibleOnly: z
      .boolean()
      .optional()
      .describe(
        "EI-7841/WI-3649: a cheap STRUCTURAL pre-filter — excludes rows the claim path refuses on ORIGIN/ADMISSION grounds ONLY, NOT the full claim-floor verdict. Feature-family: the G2 admission/trust gate (remote, un-admitted, untrusted-author) work_items:claim/claim_next enforce. Issue-family (bug/change/task): a federated origin='remote' row (owned by its authoring peer, never locally claimable) + the observation lane. It does NOT apply claim-hold / needs-human / reserved-plan-lane / blocked-dep / cooldown / rig, so a row it admits may STILL be unclaimable — this weaker check caused the 2026-07-12 idle-fleet miss. ⚠ NOT the claimable verdict: for 'what issue-family work can I claim right now' use work_items:claimable (the full floors). Default false (full backlog incl. gated items, for overview/leader reads).",
      ),
    audit: z
      .enum(COMPLETION_AUDITS)
      .optional()
      .describe(
        "Completion-integrity diagnostics over TERMINAL rows. NOTE (P-006): the old 'no-evidence' bareness sweep is GONE — evidence is now required at WRITE time, so a close without it lands `authority:'proposed'` (out of burn-down, still owned by its closer) rather than needing a later audit. Every bucket below fires on rows that PASS that gate. 'no-completion-record' = no completionRef AND no authority: a legacy/pre-gate close — mostly the benign, EXPECTED system skipCompletionGate flips (watchdog/hygiene/orphan/bee-exit/revert). 'no-completion-record-suspicious' = the ACTIONABLE subset: same shape but NOT credited to one of those recognized system identities — structurally impossible for a gated caller, so a hit means an undiscovered write path slipped past the gate; investigate directly. 'geometry-unverified' = touches a layout-bearing file (*.css/*.tsx/*.jsx) with verifiedHow 'unit' or absent — structure-passing, pixel-failing risk. 'intermittent-underevidenced' = titled intermittent/flaky/racy, carries evidence, but only a streak of consecutive passes — no failure rate, root cause, or deterministic repro, which cannot falsify 'we sampled the passing branch N times'. 'reconciler-sourced' = closed by the plan-item reconciler, which MIRRORS a linked plan item's status and is by construction never independently verified — a mis-flipped plan item silently marks a live defect fixed. Newest-first. Composes with `state`.",
      ),
    completionAuthority: z
      .enum(COMPLETION_AUTHORITY_FILTERS)
      .optional()
      .describe(
        "Filter TERMINAL rows by the completion-authority judgement the P-004 gate stamped: 'committed' (evidence sufficient — verifiedHow PLUS testsRun/testResult), 'proposed' (closed but under-evidenced: recorded, out of burn-down, still owned by its closer), 'validated'/'pending_human'/'invalid', or 'unjudged' for a close carrying NO judgement. This is how you LIST under-evidenced closes — the read D-012 left open when P-006/D-003 deleted the 'no-evidence' audit bucket. ⚠ 'unjudged' measures the INSTRUMENT, not the agents: only work_items:complete stamps an authority, so a close made via the bare state-write path lands NULL however well evidenced it was (that path records its evidence in terminalCompletionRef instead, and complete's structured evidence lands in payload._completionEvidence — three places, so no single field is a complete evidence test). Measured 2026-07-27: 38.2% of that day's agent closes were gate-judged vs 0.1% the day before, so an 'unjudged' hit means \"never judged\", NOT \"unevidenced\". Non-terminal rows never match. Composes with `state` and `audit`.",
      ),
    includeObservations: z
      .boolean()
      .optional()
      .describe(
        "EI-10422: by default a payload.lane:'observation' row (a turn-end reflection / rubric scorecard filed via improvements:capture { lane:'observation' }) is EXCLUDED — by design (D-005) it never enters the work queue/triage. Pass true to include raw observations in this read (a curation surface); the default keeps the backlog/triage view free of the ~2,700 open notes that otherwise masquerade as claimable `change` work.",
      ),
    limit: z.number().int().positive().max(500).optional(),
  }),
  result: z.array(WORK_ITEM_ROW),
  // Freshness negotiation (agent-tool-delta-client-rollout-2026-06-23, P-001) — the #1
  // LLM-agent re-read by total bytes×repeats (queen/bee/overwatch poll the backlog ~3×/wake,
  // ~25KB/call). The diffable unit is the WorkItem row set (the data IS the array), keyed by
  // `id`; `kind` is the row type. The framework folds the filter args (harness/kind/state/
  // parent/includeChildren/limit) into the view fingerprint; `scope` adds the workspace.
  // NOTE: row summaries are budget-EXCERPTED by list size, so a row's content-hash can shift
  // when the list size changes — that just re-sends the row as `updated` (still checksum-correct,
  // never wrong). Dormant until a delta-aware client sends `_meta.delta` (the WI-514 follow-up).
  delta: {
    rows: (data) => (Array.isArray(data) ? data : null),
    itemKey: (row) => (row as { id: string }).id,
    itemKeyField: "id",
    rowType: (row) => (row as { kind: string }).kind,
    orderKey: "priority",
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? "",
    schemaVersion: "work-items-list-v1",
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-012: trimmed/standard sessions get projected rows
  // (see shapeWorkItemsList). The cache stores the UNSHAPED rows (shaping runs
  // post-handler in defineTool dispatch), so one cached read serves every tier.
  shape: {
    standard: (data) => shapeWorkItemsList(data, "standard"),
    trimmed: (data) => shapeWorkItemsList(data, "trimmed"),
  },
  async handler(args, ctx) {
    // EI-6506: `mine` resolves to the CALLER's own agent identity — an explicit
    // `assignee` wins if both are passed (mine is the no-args-needed convenience,
    // not an override of a deliberate lookup of someone else's work).
    const assignee = args.assignee ?? (args.mine ? resolveAgentIdentity(ctx).ownerId : undefined);
    // Cache the expensive list read (cache-expensive-tool-reads P-005). Non-principal-
    // scoped (depends only on workspace + the filter args). The bounding is folded INTO
    // the cached factory so the stored value is the final, deterministic-per-args result.
    const items = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "work_items:list",
        key: {
          harness: args.harness ?? null,
          kind: args.kind ?? null,
          state: args.state ?? null,
          assignee: assignee ?? null,
          parent: args.parent ?? null,
          includeChildren: args.includeChildren === true,
          admissibleOnly: args.admissibleOnly === true,
          audit: args.audit ?? null,
          completionAuthority: args.completionAuthority ?? null,
          includeObservations: args.includeObservations === true,
          limit: args.limit ?? null,
        },
        // WI-4491: tag with the base TABLE `work_items` (the emit_change_notify producer,
        // bumped on EVERY work-item write), NOT the compat VIEW `harness_features_consolidated`
        // (relkind 'v' post-mig-374 — emits no `.changed`, so tagging it left this list
        // TTL-only-invalidated and serving stale backlogs after a write). Table-level is
        // correct for a list read: any work-item write can change the result set.
        tags: ["work_items"],
        softTtlMs: WORK_ITEMS_LIST_SOFT_TTL_MS,
      },
      async () => {
        const rows = await listWorkItems({
          harness: args.harness,
          kind: args.kind as WorkItemKind | undefined,
          state: args.state,
          assignee,
          parent: args.parent,
          includeChildren: args.includeChildren,
          admissibleOnly: args.admissibleOnly,
          audit: args.audit,
          completionAuthority: args.completionAuthority as CompletionAuthorityFilter | undefined,
          includeObservations: args.includeObservations,
          limit: args.limit,
        });
        // EI-1597: excerpt per-row summaries so a large backlog can't overflow the agent
        // result cap. Full body via work_items:get { id }.
        return boundSummaries(rows);
      },
    );
    return { data: items };
  },
});
