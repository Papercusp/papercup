/**
 * testing:coverage — read the SURFACE CENSUS and its depth grading
 * (`harness_shared.testing_surface_depth`), plan
 * deterministic-coverage-census-2026-08-17 P-005.
 *
 * P-001–P-004 built a census that WRITES: `testing_surfaces` (what exists),
 * `coverage_evidence` (what proved it), and the `testing_surface_depth` view that
 * grades one against the other. Nothing READ any of it, which is why the whole
 * mechanism could sit at zero rows for a day without anyone noticing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE MISREAD THIS TOOL EXISTS TO MAKE UNREPRESENTABLE
 *
 * A coverage number is a RATIO, and a ratio over an empty census is not zero and
 * not one hundred — it is NOT MEASURED. Those three readings are trivially
 * confusable and only one of them is honest:
 *
 *   0 surfaces, 0 below floor  →  "0 gaps! everything is covered"   ← vacuous truth
 *   0 surfaces, 0 meeting floor →  "0% covered, everything is broken" ← equally wrong
 *
 * Both were LIVE readings on 2026-08-18: all four census tables sat at 0 rows
 * because nothing ever registered a provider (WI-39809), while the routine
 * reported healthy fires. So `pct` is `null` — never a number — whenever its
 * denominator is 0, `verdict` says `not-measured` in words, and `censusUnknown`
 * hoists WHY at the result level, where a hurried caller cannot miss it.
 *
 * This is the same rule the migration wrote into the view's own comment ("a
 * coverage number computed over a weak census can never be read as one computed
 * over a declared census"), applied one level up: a number computed over NO
 * census may not be read as a number at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO MARKERS RIDE EVERY AGGREGATE (the P-005 acceptance requirement)
 *
 * `fidelity` — HOW the counted population was derived (declared > spec >
 * convention > observed > file-only). A 90% figure over a `file-only` census and
 * a 90% figure over a `declared` census are different claims, and the number
 * alone cannot tell them apart. Every aggregate therefore carries its own
 * distribution plus `weakest`, so the qualifier travels WITH the number rather
 * than being available somewhere else in the payload.
 *
 * `basis` — what the count was computed OVER. The root CLAUDE.md rule is that a
 * caller's `limit` bounds ROW LISTS ONLY and an aggregate computed over a capped
 * fetch must say so ON THE AGGREGATE. Here every count is computed in SQL across
 * the whole matching set and is genuinely independent of `limit` — but "it
 * happens to be unbounded today" is exactly the kind of invariant that decays
 * silently, so it is DECLARED (`boundedByLimit: false`) and pinned by a
 * behavioural test that re-reads at two different limits and requires the
 * aggregates to be identical. Only `rows` is capped, and it says so itself.
 *
 * NOT this tool: the test-run ledger is `testing:runs` (did this file pass);
 * running tests is `testing:run`. This answers "what SURFACES exist and which are
 * proven", which no ledger of runs can answer — a green suite says nothing about
 * the routes it never touched.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { toIso } from '../_pg-timestamp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

const DEFAULT_LIMIT = 50;

/** Strongest → weakest, matching the CHECK constraint and FIDELITY_ORDER. */
export const FIDELITY_ORDER = ['declared', 'spec', 'convention', 'observed', 'file-only'] as const;
type Fidelity = (typeof FIDELITY_ORDER)[number];

/**
 * The rungs, each mapped to the view's own boolean FLAG.
 *
 * ⚠ NEVER `depth >= n`. The view's comment is explicit that the rungs are NOT
 * strictly nested — a surface can be intent-tested (L3) while the fuzzer has never
 * run against it (no L2) — so a `depth >= 2` test would ask a question the data
 * cannot answer and silently report that surface as failing a rung it was never
 * judged on. `depth` exists only as a human-facing summary of the highest rung
 * reached, and this tool treats it as such.
 */
export const RUNGS = {
  l1: { column: 'meets_l1', label: 'executed — something demonstrably reached it' },
  l2: { column: 'meets_l2', label: 'conformant — a generated adversarial suite passed' },
  l3: { column: 'meets_l3', label: 'intent-tested — a test a machine did not write exercised it' },
  l4: { column: 'meets_l4', label: 'hardened — the intent tests kill mutants' },
} as const;
export type Rung = keyof typeof RUNGS;

export type FidelityCounts = Record<Fidelity, number>;

export interface FidelityMarker {
  counts: FidelityCounts;
  /** The WEAKEST fidelity present — the honest ceiling on how much this number means. */
  weakest: Fidelity | null;
  /** Share of the population derived from a live code registry (cannot drift). */
  declaredPct: number | null;
}

/** Declared, not implied — see the header. Frozen so a caller cannot mutate the claim. */
export const AGGREGATE_BASIS = Object.freeze({
  countedOver: 'every census row matching the filters',
  boundedByLimit: false,
  limitAppliesTo: 'rows',
} as const);

export interface Aggregate {
  surfaces: number;
  meets: number;
  below: number;
  waived: number;
  /** NULL when `surfaces` is 0. A ratio with no denominator is not-measured, never 0 or 100. */
  pct: number | null;
  fidelity: FidelityMarker;
  basis: typeof AGGREGATE_BASIS;
}

export const emptyFidelityCounts = (): FidelityCounts =>
  Object.fromEntries(FIDELITY_ORDER.map((f) => [f, 0])) as FidelityCounts;

export function fidelityMarker(counts: FidelityCounts, total: number): FidelityMarker {
  // WEAKEST, not strongest: the ceiling on what the number means is set by the
  // flimsiest row in the population, not the sturdiest.
  const weakest = [...FIDELITY_ORDER].reverse().find((f) => counts[f] > 0) ?? null;
  return {
    counts,
    weakest,
    declaredPct: total > 0 ? round1((counts.declared / total) * 100) : null,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The one place a ratio is formed, so the null-when-vacuous rule cannot be
 *  forgotten at one call site out of six. */
export function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round1((numerator / denominator) * 100) : null;
}

export function aggregate(input: {
  surfaces: number;
  meets: number;
  waived: number;
  fidelityCounts: FidelityCounts;
}): Aggregate {
  return {
    surfaces: input.surfaces,
    meets: input.meets,
    below: input.surfaces - input.meets,
    waived: input.waived,
    pct: pct(input.meets, input.surfaces),
    fidelity: fidelityMarker(input.fidelityCounts, input.surfaces),
    basis: AGGREGATE_BASIS,
  };
}

const num = (v: unknown): number => Number(v ?? 0);

/** Row shapes as they arrive from postgres — counts are strings from `count(*)`. */
export interface CoverageRawInput {
  scope: { workspace: string; harness: string };
  rung: Rung;
  totals:
    | {
        surfaces: string | number;
        retired: string | number;
        waived: string | number;
        last_census_at: string | null;
        meets_l1: string | number;
        meets_l2: string | number;
        meets_l3: string | number;
        meets_l4: string | number;
        meets_floor: string | number;
      }
    | undefined;
  fidelityRows: { fidelity: string; n: string | number }[];
  byKindRows: { kind: string; fidelity: string; n: string | number; meets: string | number; waived: string | number }[];
  registrations: { registered: string | number; enabled: string | number } | undefined;
  rows: {
    kind: string;
    surface_id: string;
    source_file: string | null;
    provider: string;
    fidelity: string;
    depth: number;
    meets_l1: boolean;
    meets_l2: boolean;
    meets_l3: boolean;
    meets_l4: boolean;
    mutation_score: number | null;
    authored_evidence: string | number;
    last_evidence_at: string | null;
    first_seen: string;
    retired_at: string | null;
    waived: boolean;
  }[];
  rowTotal: number;
  /** Injectable so the age computation is testable without freezing the clock. */
  now?: number;
}

/**
 * Turn raw query results into the response.
 *
 * PURE AND EXPORTED ON PURPOSE. Everything this plan item is judged on — the
 * null-when-vacuous ratio, the not-measured verdict, the hoisted reason, and the
 * fidelity/basis markers riding every aggregate — lives HERE rather than inside the
 * handler, so the guarantees are asserted against the real function instead of against
 * a mocked `sql` tagged template. A guarantee that can only be tested through a mock is
 * one the mock can be wrong about.
 */
export function assembleCoverage(input: CoverageRawInput) {
  const { scope, rung, totals, registrations } = input;
  const now = input.now ?? Date.now();
  const surfaces = num(totals?.surfaces);

  const fidelityCounts = emptyFidelityCounts();
  for (const r of input.fidelityRows) {
    if ((FIDELITY_ORDER as readonly string[]).includes(r.fidelity)) {
      fidelityCounts[r.fidelity as Fidelity] = num(r.n);
    }
  }

  const byKindMap = new Map<
    string,
    { surfaces: number; meets: number; waived: number; fid: FidelityCounts }
  >();
  for (const r of input.byKindRows) {
    const entry = byKindMap.get(r.kind) ?? {
      surfaces: 0,
      meets: 0,
      waived: 0,
      fid: emptyFidelityCounts(),
    };
    entry.surfaces += num(r.n);
    entry.meets += num(r.meets);
    entry.waived += num(r.waived);
    if ((FIDELITY_ORDER as readonly string[]).includes(r.fidelity)) {
      entry.fid[r.fidelity as Fidelity] += num(r.n);
    }
    byKindMap.set(r.kind, entry);
  }

  const providersRegistered = num(registrations?.registered);

  /**
   * The hoist (D-039 shape): result-level, enumerated, and populated ONLY when the
   * ratio genuinely has no denominator. A caller who reads nothing but `pct` still gets
   * `null` rather than a number; a caller who reads nothing but `verdict` still gets the
   * word. Both roads lead away from the vacuous reading.
   */
  const censusUnknown: string[] = [];
  if (surfaces === 0) {
    if (providersRegistered === 0) {
      censusUnknown.push(
        'no-providers-registered: harness_shared.census_provider_registrations has no row for this scope, so runCensus iterates an empty list and can never write a surface — its fires still report success (WI-39809)',
      );
    } else if (!totals?.last_census_at) {
      censusUnknown.push(
        'census-has-not-run: providers are registered but no census run has ever written a surface row for this scope',
      );
    } else {
      censusUnknown.push(
        'no-surfaces-match-filters: the census has rows, but none match this query',
      );
    }
  }

  const lastCensusAt = totals?.last_census_at ? toIso(totals.last_census_at) : null;

  return {
    scope,

    /** Words, not just a null number — the two say the same thing on purpose. */
    verdict: surfaces > 0 ? ('measured' as const) : ('not-measured' as const),
    censusUnknown: censusUnknown.length > 0 ? censusUnknown : null,

    census: {
      surfaces,
      retired: num(totals?.retired),
      lastCensusAt,
      ageMs: lastCensusAt ? now - Date.parse(lastCensusAt) : null,
      providersRegistered,
      providersEnabled: num(registrations?.enabled),
      fidelity: fidelityMarker(fidelityCounts, surfaces),
      basis: AGGREGATE_BASIS,
    },

    coverage: {
      floor: rung,
      floorMeans: RUNGS[rung].label,
      ...aggregate({
        surfaces,
        meets: num(totals?.meets_floor),
        waived: num(totals?.waived),
        fidelityCounts,
      }),
      /** Every rung, so a caller sees the shape of the ladder without four calls.
       *  Each carries its own markers — a per-rung number is an aggregate too. */
      byRung: Object.fromEntries(
        (Object.keys(RUNGS) as Rung[]).map((r) => [
          r,
          aggregate({
            surfaces,
            meets: num(totals?.[RUNGS[r].column as keyof NonNullable<CoverageRawInput['totals']>]),
            waived: num(totals?.waived),
            fidelityCounts,
          }),
        ]),
      ) as Record<Rung, Aggregate>,
    },

    byKind: [...byKindMap.entries()]
      .map(([k, v]) => ({
        kind: k,
        ...aggregate({
          surfaces: v.surfaces,
          meets: v.meets,
          waived: v.waived,
          fidelityCounts: v.fid,
        }),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),

    rows: input.rows.map((r) => ({
      kind: r.kind,
      surfaceId: r.surface_id,
      sourceFile: r.source_file,
      provider: r.provider,
      fidelity: r.fidelity,
      depth: r.depth,
      meets: { l1: r.meets_l1, l2: r.meets_l2, l3: r.meets_l3, l4: r.meets_l4 },
      mutationScore: r.mutation_score,
      authoredEvidence: num(r.authored_evidence),
      lastEvidenceAt: r.last_evidence_at ? toIso(r.last_evidence_at) : null,
      firstSeen: toIso(r.first_seen),
      retiredAt: r.retired_at ? toIso(r.retired_at) : null,
      waived: r.waived,
    })),
    count: input.rows.length,
    total: input.rowTotal,
    truncatedByLimit: input.rows.length < input.rowTotal,
  };
}

export default defineTool({
  name: 'testing:coverage',
  description:
    'Read the SURFACE CENSUS (harness_shared.testing_surface_depth): which testable surfaces exist (http-route | mcp-tool | sync-query | …) and which are proven to the depth floor. Aggregates overall and by kind, plus the gap list. `pct` is null — never 0 or 100 — when the census is empty, and `verdict:"not-measured"` says so. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Answering "what is actually tested here" / "what did this plan leave unproven": the census knows about surfaces no test ever touched, which a run ledger cannot. rung + gapsOnly gives the gap queue.',
    notWhen:
      'For "did this file pass / what failed at this sha" use testing:runs (the run ledger — a different question). To RUN tests use testing:run. This tool never says whether a suite is green; it says what the suite reached.',
    chaining:
      'gapsOnly:true at your floor for the gap list → sourceFile to scope it to the files a plan touched → testing:runs on the surface\'s source_file for the run history behind its evidence.',
    // Response docs live HERE, not in description/when — those are prompt-weight budgeted.
    returns: [
      'verdict "measured" | "not-measured". not-measured means the RATIO HAS NO DENOMINATOR (zero censused surfaces) — it is NOT a coverage of 0%, and censusUnknown carries the reason (no-providers-registered | census-has-not-run | no-surfaces-match-filters).',
      'Every aggregate (root `coverage`, each `byKind` entry, each `byRung` entry) carries `fidelity` { counts, weakest, declaredPct } and `basis` { countedOver, boundedByLimit:false, limitAppliesTo:"rows" }. fidelity.weakest is the ceiling on what the number means: 90% over a "file-only" census is not 90% over a "declared" one.',
      '`pct` is null whenever its denominator is 0, at every level including per-kind. A null pct is an honest unknown; treating it as 0 is the misread this tool exists to prevent.',
      'Aggregates are computed in SQL over the WHOLE matching set and do not move with `limit`; only `rows` is capped, and reports count/total/truncatedByLimit.',
      'Rungs are judged by the view\'s meets_lN FLAG, never depth >= N — the rungs are not nested (an intent-tested surface the fuzzer never ran against is L3 with no L2), so `depth` is a human-facing summary only.',
      'census { surfaces, retired, lastCensusAt, ageMs, providersRegistered, providersEnabled } describes the POPULATION. providersRegistered:0 means the census loop has nothing to iterate and cannot ever write a row (WI-39809) — the state that reads as a healthy zero everywhere else.',
    ].join(' '),
    seeAlso: [
      'testing:runs (did this test file pass — the run ledger)',
      'testing:run (actually run test files)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness slug to read (default: the operator home harness).'),
    workspace: z
      .string()
      .max(120)
      .optional()
      .describe('Workspace id (default: the active workspace).'),
    kind: z
      .string()
      .max(80)
      .optional()
      .describe('Only this surface kind (http-route | mcp-tool | sync-query | …).'),
    sourceFile: z
      .string()
      .max(400)
      .optional()
      .describe(
        'Only surfaces whose implementing file matches this SUBSTRING — the reverse map that scopes coverage to the files a plan touched.',
      ),
    rung: z
      .enum(['l1', 'l2', 'l3', 'l4'])
      .optional()
      .describe(
        'The depth floor to judge against (default l1). Judged by the meets_lN flag, never depth >= N.',
      ),
    gapsOnly: z
      .boolean()
      .optional()
      .describe('Return only surfaces BELOW the floor — the gap queue.'),
    includeRetired: z
      .boolean()
      .optional()
      .describe('Include surfaces the census no longer finds (default false).'),
    includeWaived: z
      .boolean()
      .optional()
      .describe(
        'Count waived surfaces in the gap list (default false — a live waiver is an accepted, expiry-dated gap).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`Max ROWS (default ${DEFAULT_LIMIT}). Never bounds the aggregates.`),
  }),
  // ⚠ WRAPPED IN `{ data }`, like every sibling tool. A handler must return a
  // `ToolResult | ToolResponse`, not a bare payload — `dispatchReadOnlyTool` unwraps
  // `data`, which is why the state cells' declared paths are rooted at `coverage.pct`
  // rather than `data.coverage.pct`.
  //
  // Returning the payload raw fails as `TS2769: No overload matches this call` pointing
  // at this line — a headline whose indented sub-messages name the RETURN type as the
  // mismatch while the parameter types are shown matching exactly. Read those
  // sub-messages (a full `tsc` run; `lint:tsc` prints only the first line) before
  // concluding anything about this signature.
  async handler(args) {
    return { data: await readCoverage(args) };
  },
});

/** The argument shape, shared by every surface that reads coverage. */
export interface CoverageArgs {
  harness?: string;
  workspace?: string;
  kind?: string;
  sourceFile?: string;
  /**
   * MANY source-file substrings, matched as a union (a surface counts if ANY of them
   * matches). The reverse map for a multi-file scope — "the surfaces the files this plan
   * touched implement" — expressed as ONE query so the aggregate is still computed in
   * SQL across the whole matching population.
   *
   * ⚠ The alternative (call readCoverage once per file and add the results up) is
   * FORBIDDEN by this module's own contract: summing per-file aggregates double-counts
   * any surface two patterns both match, and re-derives a ratio outside the one place
   * {@link pct} enforces the null-when-vacuous rule. Widen the query, never the caller.
   */
  sourceFiles?: string[];
  rung?: Rung;
  gapsOnly?: boolean;
  includeRetired?: boolean;
  includeWaived?: boolean;
  limit?: number;
}

/**
 * THE coverage resolver. Exported because the `/admin/testing` panel reads it through
 * the sync registry (`testing.coverage`) and the state cells read it through the tool —
 * three surfaces, ONE derivation.
 *
 * ⚠ A surface may PROJECT or SUBSET this; none may re-derive it. The panel in particular
 * must not recompute a percentage from the row list it happens to have been sent: the
 * rows are capped by `limit` and the aggregates are not, so a client-side ratio would be
 * computed over a page instead of a population — silently, and in the flattering
 * direction. That is the exact defect this plan item exists to make unrepresentable, and
 * it would be reintroduced by the most natural line of UI code anyone could write.
 */
export async function readCoverage(args: CoverageArgs) {
  {
    const { sql } = getOrgPg();
    const harness = args.harness ?? operatorHomeHarnessSlug();
    const workspace = args.workspace ?? activeWorkspaceId();
    const rung: Rung = args.rung ?? 'l1';
    const limit = args.limit ?? DEFAULT_LIMIT;
    const includeRetired = args.includeRetired ?? false;
    const includeWaived = args.includeWaived ?? false;
    const filePattern = args.sourceFile ? `%${args.sourceFile}%` : null;
    // A union of substrings. Empty-after-trim ⇒ null, NOT an empty array: `ILIKE ANY('{}')`
    // matches nothing, so an all-blank list would silently produce a 0-surface scope that
    // reads as a real (and vacuously passing) measurement. null means "no filter"; a
    // caller that meant to scope to specific files and supplied none must not be handed
    // the whole census either — that is the CALLER's error to detect, and the coverage
    // check's scope resolver refuses it before it ever reaches this function.
    const filePatterns =
      args.sourceFiles && args.sourceFiles.some((f) => f.trim() !== '')
        ? args.sourceFiles.filter((f) => f.trim() !== '').map((f) => `%${f.trim()}%`)
        : null;
    const kind = args.kind ?? null;

    // The flag column for the requested rung. Interpolated from the RUNGS table, never
    // from caller input — the zod enum already bounds it, and this keeps it obvious.
    const meetsCol = sql(RUNGS[rung].column);

    const where = sql`
       WHERE workspace_id = ${workspace}
         AND harness_slug = ${harness}
         AND (${includeRetired}::boolean OR retired_at IS NULL)
         AND (${kind}::text IS NULL OR kind = ${kind})
         AND (${filePattern}::text IS NULL OR source_file ILIKE ${filePattern})
         AND (${filePatterns}::text[] IS NULL OR source_file ILIKE ANY(${filePatterns}))`;

    // ── The aggregates. Computed across the whole matching set in SQL, so `limit`
    //    cannot reach them (AGGREGATE_BASIS declares this, the behavioural test pins it).
    const [totals] = await sql<
      {
        surfaces: string;
        retired: string;
        waived: string;
        last_census_at: string | null;
        meets_l1: string;
        meets_l2: string;
        meets_l3: string;
        meets_l4: string;
        meets_floor: string;
      }[]
    >`
      SELECT count(*)                                                      AS surfaces,
             count(*) FILTER (WHERE retired_at IS NOT NULL)                AS retired,
             count(*) FILTER (WHERE waived)                                AS waived,
             max(last_seen)                                                AS last_census_at,
             count(*) FILTER (WHERE meets_l1)                              AS meets_l1,
             count(*) FILTER (WHERE meets_l2)                              AS meets_l2,
             count(*) FILTER (WHERE meets_l3)                              AS meets_l3,
             count(*) FILTER (WHERE meets_l4)                              AS meets_l4,
             count(*) FILTER (WHERE ${meetsCol})                           AS meets_floor
        FROM harness_shared.testing_surface_depth
        ${where}
    `;

    const fidelityRows = await sql<{ fidelity: string; n: string }[]>`
      SELECT fidelity, count(*) AS n
        FROM harness_shared.testing_surface_depth
        ${where}
       GROUP BY fidelity
    `;

    const byKindRows = await sql<
      { kind: string; surfaces: string; meets: string; waived: string; fidelity: string; n: string }[]
    >`
      SELECT kind,
             fidelity,
             count(*)                            AS n,
             count(*) FILTER (WHERE ${meetsCol}) AS meets,
             count(*) FILTER (WHERE waived)      AS waived,
             0                                   AS surfaces
        FROM harness_shared.testing_surface_depth
        ${where}
       GROUP BY kind, fidelity
       ORDER BY kind
    `;

    // ── Provider registrations: the census loop iterates THESE, so zero of them means
    //    the census can never write a row however healthy its fires look (WI-39809).
    const [registrations] = await sql<{ registered: string; enabled: string }[]>`
      SELECT count(*)                             AS registered,
             count(*) FILTER (WHERE enabled)      AS enabled
        FROM harness_shared.census_provider_registrations
       WHERE workspace_id = ${workspace}
         AND harness_slug = ${harness}
    `;

    // ── The rows. The ONLY capped thing in this response.
    const rowWhere = args.gapsOnly
      ? sql`${where} AND NOT ${meetsCol} ${includeWaived ? sql`` : sql`AND NOT waived`}`
      : where;

    const rows = await sql<
      {
        kind: string;
        surface_id: string;
        source_file: string | null;
        provider: string;
        fidelity: string;
        depth: number;
        meets_l1: boolean;
        meets_l2: boolean;
        meets_l3: boolean;
        meets_l4: boolean;
        mutation_score: number | null;
        authored_evidence: string;
        last_evidence_at: string | null;
        first_seen: string;
        retired_at: string | null;
        waived: boolean;
      }[]
    >`
      SELECT kind, surface_id, source_file, provider, fidelity, depth,
             meets_l1, meets_l2, meets_l3, meets_l4, mutation_score,
             authored_evidence, last_evidence_at, first_seen, retired_at, waived
        FROM harness_shared.testing_surface_depth
        ${rowWhere}
       ORDER BY depth ASC, kind ASC, surface_id ASC
       LIMIT ${limit}
    `;

    const [rowTotal] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.testing_surface_depth ${rowWhere}
    `;

    return assembleCoverage({
      scope: { workspace, harness },
      rung,
      totals,
      fidelityRows,
      byKindRows,
      registrations,
      rows,
      rowTotal: num(rowTotal?.n),
    });
  }
}
