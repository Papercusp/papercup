/**
 * work_items:claimable — the ONE authoritative "what issue-family work can I actually
 * claim right now" read (work-item-claimability-clarity / claimable-read-tool-and-sql-
 * encapsulation-audit-2026-07-21, P-001).
 *
 * WHY this tool exists: `status='open'` is NOT claimability. The real claim path applies
 * ~12 unconditional floors (taken, claim-hold, needs-human, observation-lane, external
 * blocker, plan-lane reservation, federation, loop-noise, terminal-completion, cross-
 * machine-rig, blocked-dep, release-cooldown), so a hand-rolled `WHERE status='open'`
 * overcounts ~13×. The SSOT floors previously lived only in a SQL VIEW + the scheduler's
 * own miss-diagnosis, so every guidance surface pointed agents at raw `dev:pg_query`
 * (still SQL) — and three surfaces disagreed (8 vs 2 vs 0). This tool wraps the SAME
 * `aggregateIssueClaimExclusions` oracle that `scheduler:get_next`'s miss-path and the
 * fleet drain-stamp already call, plus its companion `listIssueClaimableRows` (built on
 * one shared inner subquery + one shared all-floors-pass predicate), so the count, the
 * row list, and what `get_next` would actually hand out structurally cannot diverge.
 *
 * READ-ONLY: reports claimability; it never claims. Take one with work_items:claim /
 * work_items:claim_next / scheduler:get_next.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  aggregateIssueClaimExclusions,
  listIssueClaimableRows,
} from '../../scheduler/get-next';
import {
  getClaimSpecRecord,
  fleetSpecBeeKey,
  resolveClaimSpecWorkspace,
} from '../../scheduler/claim-spec-store';
import type { ClaimSpec, FilterNode } from '../../scheduler/claim-spec';

const ISSUE_KINDS = ['bug', 'change', 'task'] as const;

export default defineTool({
  name: 'work_items:claimable',
  profile: 'engineer',
  description:
    "The authoritative \"what issue-family work can I claim RIGHT NOW\" read — bug/change/task rows that survive the spec filter AND all ~12 real claim floors, via the SAME oracle scheduler:get_next runs (NOT `status='open'`, which overcounts ~13×). READ-ONLY: never claims. Returns { ok, harness, claimableCount, matchedByFilter, returned, claimable:[{ id, kind, title, status, severity, plan, featureOrder, createdTs }], excludedBreakdown, spec }. `claimableCount` is the trustworthy \"0 claimable / N claimable\" number a drain/wind-down decision hinges on; `excludedBreakdown` buckets OVERLAP (a row can be stranded by several floors) so they do NOT sum. Pass `spec:'<fleet-slug>'` to scope to a fleet's lane, `kind` to restrict, `breakdownOnly` to skip the rows.",
  guidance: {
    when: "You need to know how many / which issue-family items (bugs/changes/tasks) are ACTUALLY claimable in a harness — before a wind-down/drain call, a backlog read, or picking work. This is the SSOT; use it instead of raw SQL on work_items or the claimable view.",
    notWhen:
      "You want to TAKE an item → work_items:claim / work_items:claim_next / scheduler:get_next (those claim; this only reports). Feature-family (F-…) claimability or a full backlog incl. gated rows → work_items:list.",
    chaining:
      "work_items:claimable → work_items:claim { id } (take a surfaced row) · or scheduler:get_next (let the queue hand you the top-ranked one).",
    seeAlso: [
      'scheduler:get_next (claims the single top-ranked eligible item — same floors)',
      'work_items:observe (claimability of specific ids you already have)',
    ],
    byRole: {
      mug:
        "Before draining/winding a fleet down, confirm claimableCount===0 here (the drain-stamp records this same oracle). A non-zero count with a bare `status='open'` justification means the drain is premature.",
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80).describe('the harness lane to read claimable issue-family work for'),
    kind: z
      .union([z.enum(ISSUE_KINDS), z.array(z.enum(ISSUE_KINDS)).min(1)])
      .optional()
      .describe("restrict to these issue-family kind(s); default all of bug/change/task"),
    spec: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "a FLEET SLUG whose sentinel claim-spec scopes the lane (its view.filter + states + rank ordering). Omit ⇒ the whole issue-family lane for the harness (DEFAULT_CLAIM_SPEC).",
      ),
    states: z
      .array(z.string().min(1).max(40))
      .min(1)
      .optional()
      .describe("claimable-status floor override (default: the spec's states, else ['todo']-family claimable states)"),
    limit: z.number().int().positive().max(200).optional().describe('max claimable rows to return (default 20, cap 200)'),
    breakdownOnly: z
      .boolean()
      .optional()
      .describe('skip the row list — return only claimableCount + matchedByFilter + excludedBreakdown (cheaper)'),
  }),
  async handler(args, ctx) {
    const harness = args.harness;
    // The caller identity feeds the release-cooldown + reserved-plan-lane floors exactly
    // as the real claim path resolves them (a row THIS agent just released is on cooldown
    // for it, a plan-lane reserved for it is NOT excluded for it).
    const assignee = resolveAgentIdentity(ctx).ownerId;
    const ws = resolveClaimSpecWorkspace((ctx as { workspaceId?: string | null }).workspaceId);

    // Optionally resolve a fleet claim-spec to scope the lane (filter + states + rank).
    let specFilter: FilterNode | undefined;
    let spec: ClaimSpec | undefined;
    let specStates: readonly string[] | undefined;
    let specProvenance: { specId: string; revision: number | null; source: 'cup' | 'fleet' | 'default' } = {
      specId: 'default-fixed-ordering',
      revision: 0,
      source: 'default',
    };
    if (args.spec) {
      const rec = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(args.spec), workspaceId: ws }).catch(() => null);
      if (rec) {
        spec = rec.spec;
        specFilter = rec.spec.view.filter;
        specStates = rec.spec.states;
        specProvenance = { specId: rec.spec.specId ?? args.spec, revision: rec.revision, source: rec.source };
      }
    }

    // Effective filter = the spec's filter AND (optional) a kind restriction. Both are
    // validated FilterNodes over the closed spec vocabulary, so compileFilter is SQL-safe.
    const kinds = args.kind ? (Array.isArray(args.kind) ? args.kind : [args.kind]) : undefined;
    const kindFilter: FilterNode | undefined =
      kinds && kinds.length > 0
        ? kinds.length === 1
          ? { field: 'kind', op: '=', value: kinds[0]! }
          : { field: 'kind', op: 'in', value: [...kinds] }
        : undefined;
    const filter: FilterNode | undefined =
      specFilter && kindFilter ? { all: [specFilter, kindFilter] } : (specFilter ?? kindFilter);

    // undefined states ⇒ the oracle/lister apply their own ISSUE_FAMILY_CLAIMABLE_STATES default.
    const states = args.states ?? specStates;
    const limit = args.limit ?? 20;

    const breakdown = await aggregateIssueClaimExclusions(filter, { harness, states, assignee });
    const claimable = args.breakdownOnly
      ? []
      : await listIssueClaimableRows(filter, { harness, states, assignee, spec }, limit);

    const payload = {
      ok: true as const,
      harness,
      /** The authoritative count: rows passing spec_match AND every claim floor. */
      claimableCount: breakdown.claimable,
      /** In-lane issue-family rows the spec's own filter matched, BEFORE floors. */
      matchedByFilter: breakdown.matchedByFilter,
      returned: claimable.length,
      claimable,
      /** Per-floor stranding counts (INDEPENDENT/overlapping — they do NOT sum). */
      excludedBreakdown: breakdown.excluded,
      spec: specProvenance,
      states: states ? [...states] : null,
      note:
        '`claimableCount` is the authoritative claimable total (spec_match AND all ~12 floors — the SAME oracle scheduler:get_next runs). excludedBreakdown buckets OVERLAP, so they do NOT sum to matched−claimable. READ ONLY — nothing was claimed; take one via work_items:claim / scheduler:get_next.',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
