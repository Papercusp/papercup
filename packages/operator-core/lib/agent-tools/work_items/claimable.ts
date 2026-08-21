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
 * fleet drain-stamp already call, plus its companions `listIssueClaimableRows` and
 * `sampleIssueClaimExclusions` (all three built on one shared inner subquery + one shared
 * all-floors-pass predicate), so the count, the row list, the sample, and what `get_next`
 * would actually hand out cannot diverge in what they MEAN.
 *
 * ...and they are read at ONE INSTANT, which is a separate guarantee this originally
 * lacked (WI-5947). The shared predicate makes the three reads semantically identical; it
 * does not make three round-trips atomic. Against a table the fleet is actively claiming
 * from, a row counted by the first query could be gone by the second — surfacing as
 * `claimableCount:1, returned:0` under a limit of 50, which downstream read as a defect in
 * the claim path and instructed an agent to file a bug that did not exist. All three now go
 * through `readIssueClaimability`, one read-only REPEATABLE READ transaction.
 *
 * READ-ONLY: reports claimability; it never claims. Take one with work_items:claim /
 * work_items:claim_next / scheduler:get_next.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { readIssueClaimability } from '../../scheduler/get-next';
import { potHomeSlugForHarness } from '../../hive-federation';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  resolveFleetClaimSpec,
  listFleetClaimSpecCandidates,
  resolveClaimSpecWorkspace,
} from '../../scheduler/claim-spec-store';
import type { ClaimSpec, FilterNode } from '../../scheduler/claim-spec';

const ISSUE_KINDS = ['bug', 'change', 'task'] as const;

export interface ClaimableHarnessScope {
  requested: string;
  resolved: string;
  resolution: 'requested' | 'hive-home';
}

export default defineTool({
  name: 'work_items:claimable',
  profile: 'engineer',
  description:
    // PROMPT-WEIGHT (EI-10966): was 1805 — 205 over the 1600 HARD CAP, redding the green gate
    // and freezing deploys fleet-wide. Trimmed; the detail moved here:
    //   · The full row shape is { id, kind, title, status, severity, plan, featureOrder, createdTs }.
    //   · `status='open'` alone overcounts ~13× — it is not claimability.
    //   · excludedBreakdown buckets OVERLAP, so they never sum to matched − claimable.
    //   · sampleExcluded (1-10) → excludedSample, N ids PER FLOOR, for stale-hold triage without
    //     raw SQL. Raw SQL is the trap it replaces: harness_shared.work_items carries BOTH a
    //     legacy `kind` column and the real discriminator `item_kind`, so a hand-written
    //     kind='bug' filter matches ZERO rows and reads exactly like a drained queue.
    //   · An unrecognized `spec` returns { ok:false, error, candidates } — never a silent
    //     whole-backlog fallback, which would look like a suddenly-huge lane.
    "The authoritative issue-family \"claimable right now\" read — bug/change/task rows surviving the spec filter + all ~12 real claim floors, via the SAME oracle scheduler:get_next uses. READ-ONLY. `claimableCount` is the trustworthy drain number; `excludedBreakdown` buckets OVERLAP so they do not sum; `affinityCoverage` warns when fewer than 50% of claimable rows carry non-empty `payload.paths`; `sampleExcluded` (1-10) adds `excludedSample` — ids per floor for stale-hold triage.",
  guidance: {
    when: "How many/which issue-family items (bug/change/task) are ACTUALLY claimable — before a drain/wind-down call, a backlog read, or picking work. SSOT, not raw SQL or the claimable view.",
    notWhen:
      "Taking an item → work_items:claim / claim_next / scheduler:get_next (this only reports). Feature-family (F-…) claimability, or a backlog incl. gated rows → work_items:list.",
    chaining:
      "→ work_items:claim { id } (take a surfaced row) · scheduler:get_next (top-ranked pick).",
    seeAlso: [
      'scheduler:get_next (claims the single top-ranked eligible item — same floors)',
      'work_items:observe (claimability of specific ids you already have)',
    ],
    byRole: {
      mug: {
        when:
          "Before winding a fleet down confirm claimableCount===0 here (the drain-stamp records this oracle); `status='open'` alone risks a premature drain.",
      },
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20226779878046151: the claimability oracle owns its store reads and
  // never reads ctx.tx. Avoid retaining the ambient org-app transaction while
  // the multi-floor census runs inside coord:orient.
  skipWorkspaceTx: true,
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
        "a fleet's claim-spec scoping the lane (its view.filter + states + rank ordering) — either the FLEET SLUG or the spec's own `specId` (both resolve; an unrecognized value errors with candidates, it never silently widens to the whole backlog). Omit ⇒ the whole issue-family lane for the harness (DEFAULT_CLAIM_SPEC).",
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
    sampleExcluded: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe(
        'also return `excludedSample`: up to this many ids PER FLOOR (taken/claimHold/needsHuman/…, same overlapping-bucket semantics as excludedBreakdown) — the ROW-LEVEL diagnostic companion to the counts, answering "which items" instead of just "how many" without raw SQL. Omit to skip (cheaper — one extra bounded query per call when set).',
      ),
  }),
  async handler(args, ctx) {
    const requestedHarness = args.harness;
    // Issue-family work is stored on the Hive home lane. A member harness is a valid
    // session scope, but passing it directly to the oracle reads an empty sibling lane
    // and makes "wrong scope" indistinguishable from "drained queue" (EI-20683725849634683).
    // Fail open to the requested lane if the resolver cannot answer; the scope envelope
    // still tells the caller exactly which lane was measured.
    let harness = requestedHarness;
    let claimableHarnessScope: ClaimableHarnessScope = {
      requested: requestedHarness,
      resolved: requestedHarness,
      resolution: 'requested',
    };
    try {
      const workspaceId = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
      const hiveHome = await potHomeSlugForHarness(workspaceId, requestedHarness);
      if (hiveHome) {
        harness = hiveHome;
        claimableHarnessScope = {
          requested: requestedHarness,
          resolved: hiveHome,
          resolution: hiveHome === requestedHarness ? 'requested' : 'hive-home',
        };
      }
    } catch {
      /* Resolver failure must not turn a readable requested lane into a false zero. */
    }
    // The caller identity feeds the release-cooldown + reserved-plan-lane floors exactly
    // as the real claim path resolves them (a row THIS agent just released is on cooldown
    // for it, a plan-lane reserved for it is NOT excluded for it).
    const assignee = resolveAgentIdentity(ctx).ownerId;
    const ws = resolveClaimSpecWorkspace((ctx as { workspaceId?: string | null }).workspaceId);

    // Optionally resolve a fleet claim-spec to scope the lane (filter + states + rank).
    // EI-18672834165659298: `args.spec` may be either the fleet SLUG or the spec's own
    // specId — resolveFleetClaimSpec tries both namespaces and returns null when NEITHER
    // matches. A miss is a hard error (candidates included), never a silent fall-through to
    // the whole-backlog DEFAULT_CLAIM_SPEC — that silent widening (safe→unsafe) is exactly
    // the bug this fixes.
    let specFilter: FilterNode | undefined;
    let spec: ClaimSpec | undefined;
    let specStates: readonly string[] | undefined;
    let specProvenance: {
      specId: string;
      revision: number | null;
      source: 'cup' | 'fleet' | 'default';
      fleetSlug?: string;
      matchedBy?: 'fleet-slug' | 'spec-id';
    } = {
      specId: 'default-fixed-ordering',
      revision: 0,
      source: 'default',
    };
    if (args.spec) {
      const resolved = await resolveFleetClaimSpec({ spec: args.spec, workspaceId: ws }).catch(() => undefined);
      if (resolved === undefined) {
        // A genuine lookup failure (e.g. DB hiccup) — distinguish from "no match" below by
        // erroring rather than silently proceeding on an unfiltered lane.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `failed to resolve claim-spec '${args.spec}' — lookup error, not a not-found; retry`,
              }),
            },
          ],
        };
      }
      if (resolved === null) {
        const candidates = await listFleetClaimSpecCandidates({ workspaceId: ws }).catch(() => []);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `no fleet or claim-spec named '${args.spec}' found (checked both the fleet-slug and specId ` +
                  `namespaces) — refusing to fall back to the unfiltered whole-backlog lane. Pass a valid fleet ` +
                  `slug or specId from \`candidates\`, or omit \`spec\` to intentionally read the whole lane.`,
                candidates,
              }),
            },
          ],
        };
      }
      const rec = resolved.record;
      spec = rec.spec;
      specFilter = rec.spec.view.filter;
      specStates = rec.spec.states;
      specProvenance = {
        specId: rec.spec.specId ?? args.spec,
        revision: rec.revision,
        source: rec.source,
        fleetSlug: resolved.fleetSlug,
        matchedBy: resolved.matchedBy,
      };
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

    // ONE read-only REPEATABLE READ snapshot for the counts, the row list, AND the
    // excluded sample (WI-5947). Issued as separate round-trips these observe different
    // snapshots of a concurrently-mutating table, and the response presents them as a
    // single verdict — which is how `claimableCount:1, returned:0` (under a limit of 50)
    // reached a caller and was read as a claim-path defect. A read failure THROWS here
    // rather than degrading to a partial or zeroed reading: "could not measure" must not
    // masquerade as "measured none" when the answer drives a drain/wind-down call.
    const { breakdown, rows: claimable, sample: excludedSample, admitted } = await readIssueClaimability(
      filter,
      { harness, states, assignee, spec },
      { limit, breakdownOnly: args.breakdownOnly, sampleLimit: args.sampleExcluded },
    );

    const payload = {
      ok: true as const,
      harness,
      claimableHarnessScope,
      /** The authoritative count: rows passing spec_match AND every claim floor. */
      claimableCount: breakdown.claimable,
      /** EI-18835176695181727: alias of `claimableCount`. Sibling read tools (e.g.
       *  dev:pg_query) return `{ rows, count }`; a caller who guesses that shape here
       *  instead of `{ claimable, claimableCount }` gets `undefined`-keyed access —
       *  which silently yields `[]`/`0`, not an error, and `0` reads as "queue drained"
       *  at exactly the moment a drain/wind-down call is made on it. Purely additive. */
      count: breakdown.claimable,
      /** In-lane issue-family rows the spec's own filter matched, BEFORE floors. */
      matchedByFilter: breakdown.matchedByFilter,
      /** EI-16028: coverage of the affinity rank term's item-side path metadata over the
       * full claimable survivor set (never the returned, LIMIT-capped page). */
      affinityCoverage: breakdown.affinityCoverage,
      returned: claimable.length,
      claimable,
      /** EI-18835176695181727: alias of `claimable` — see `count` above. */
      rows: claimable,
      /** Per-floor stranding counts (INDEPENDENT/overlapping — they do NOT sum). */
      excludedBreakdown: breakdown.excluded,
      /** WI-6673: what the admitted set is MADE OF — byKind, bySeverity, lowSeverityShare,
       *  degenerate, peakDay. The counterpart to excludedBreakdown (what was REJECTED).
       *  Always present, because the failure this prevents is a caller quoting the count
       *  without having thought to ask what is in it. */
      admittedBreakdown: admitted,
      /** Only present when `sampleExcluded` was passed: up to that many ids PER FLOOR
       *  (same overlapping-bucket semantics as excludedBreakdown) — which rows, not just
       *  how many. */
      ...(excludedSample ? { excludedSample } : {}),
      spec: specProvenance,
      states: states ? [...states] : null,
      note:
        '`claimableCount` is the authoritative claimable total (spec_match AND all ~12 floors — the SAME oracle scheduler:get_next runs). excludedBreakdown buckets OVERLAP, so they do NOT sum to matched−claimable. READ ONLY — nothing was claimed; take one via work_items:claim / scheduler:get_next.' +
        (breakdown.affinityCoverage.belowFloor
          ? ` ⚠ AFFINITY PATH COVERAGE WARNING: ${breakdown.affinityCoverage.nonEmptyPaths}/${breakdown.affinityCoverage.denominator} claimable row(s) carry non-empty payload.paths, below the ${Math.round(breakdown.affinityCoverage.floor * 100)}% floor; affinity ranking is under-informed (EI-16028).`
          : '') +
        (admitted.degenerate
          ? ` ⚠ COMPOSITION WARNING: ${Math.round((admitted.lowSeverityShare ?? 0) * 100)}% of this lane is nit/minor severity` +
            (admitted.peakDay ? ` and ${admitted.peakDay.count} of it was filed on a single day (${admitted.peakDay.day})` : '') +
            `. A count this size is NOT a workload — read admittedBreakdown before quoting it as one (WI-6673).`
          : ''),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
