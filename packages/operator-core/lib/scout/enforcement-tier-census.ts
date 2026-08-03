/**
 * enforcement-tier-census.ts — every agent-facing coordination behaviour ×
 * its declared enforcement tier × its measured adoption
 * (plan coordination-spec-adoption-2026-08-03, P-002; the D-016/D-047 debt).
 *
 * WHY THIS EXISTS. D-016/D-047 required a tier per behaviour and the coordination
 * verbs never got one. The consequence is not bookkeeping: without a tier column
 * you cannot tell a verb that is UNUSED from a verb that is merely UNENFORCED,
 * so the reflex for every low number is "add more prompt text" — which D-001
 * measured as the weakest lever there is (0–8 calls/week across 149 agents).
 *
 * THE TIER LADDER IS D-001's, RANKED BY MEASURED EFFECT, NOT BY TASTE:
 *
 *   1 auto-stamp     the agent never has to remember; ~100% by construction.
 *                    (`auto:true` via sendMessage; capability_tags at 68/68.)
 *   2 schema-refusal the old shape is rejected at the tool boundary.
 *                    Measured 0% -> 73% in ONE day, held 72–81% for a week.
 *   3 see-also       result-time surfacing. 3.4x lift in 4h; long-window unproven.
 *   4 prompt-only    NOT A TIER (D-016). Recorded as a tier VALUE here only so the
 *                    census can say "this behaviour's only enforcement is prose",
 *                    which is the finding, not a passing grade.
 *
 * ⚠ DO NOT "reuse" `CONVENTION_ENFORCEMENT_TIERS` (structural|gate|detector) from
 * agent-facts/store.ts here. Both cite D-016, which makes them look like the same
 * axis; they are not. That one grades CONVENTIONS and has a live DB check
 * constraint. Collapsing coordination behaviours into it would erase the
 * see-also-vs-prompt distinction, and that distinction is the entire operative
 * content of D-001: *a behaviour that cannot be given tier 1–3 is a candidate for
 * retirement, not for more prompt text*.
 *
 * HOW THIS AVOIDS DRIFT — the part that matters. The behaviour LIST is never
 * hand-maintained. It is generated from `buildBuiltinToolCatalog()` (a pure
 * filesystem scan of `defineTool` names, already extracted by
 * agent-trap-guards-2026-07-26 P-007 so a second scanner would not be built).
 * {@link DECLARED_COORD_TIERS} carries ONLY the positive, evidence-backed
 * declarations; every scanned verb without one becomes an `undeclared` row
 * automatically. So the census is complete BY CONSTRUCTION: a coordination verb
 * added tomorrow shows up as untiered debt without anyone remembering to list it,
 * and there is no giant hand-kept table to fall out of date.
 *
 * Making the declaration MANDATORY AT REGISTRATION (so `undeclared` becomes
 * unrepresentable rather than merely visible) is P-009, deliberately a separate
 * item. This one measures the debt; that one closes the door.
 *
 * D-003 — every count here names its denominator. There is deliberately NO
 * single "coordination adoption %" on this type: the whole reason P-001 exists is
 * that one such number was wrong by two orders of magnitude
 * (EI-19300252001829260).
 */

/** D-001's ladder. `prompt-only` is included as a VALUE but is not a tier (D-016). */
export type EnforcementTier = 'auto-stamp' | 'schema-refusal' | 'see-also' | 'prompt-only';

/** A behaviour with no declaration at all — the D-016/D-047 debt this census measures. */
export const UNDECLARED = 'undeclared' as const;

export type CensusTier = EnforcementTier | typeof UNDECLARED;

/**
 * D-001's ranking, strongest first. `prompt-only` and `undeclared` deliberately
 * have NO rank: ranking them would invite averaging them into a score, and a mean
 * over "how enforced is this" is exactly the summary that hides the finding.
 */
export const ENFORCEMENT_TIER_RANK: Readonly<Record<EnforcementTier, number | null>> = Object.freeze({
  'auto-stamp': 1,
  'schema-refusal': 2,
  'see-also': 3,
  'prompt-only': null,
});

/** Tiers that count as real enforcement (D-001's 1–3). */
export const ENFORCED_TIERS: readonly EnforcementTier[] = Object.freeze([
  'auto-stamp',
  'schema-refusal',
  'see-also',
]);

export interface TierDeclaration {
  readonly tier: EnforcementTier;
  /**
   * WHY this behaviour carries this tier — the mechanism, not a restatement of the
   * tier name. Required (non-empty) so a declaration cannot be asserted without
   * saying what enforces it; an unfalsifiable declaration is worse than none,
   * because it reads as covered.
   */
  readonly evidence: string;
}

/**
 * The POSITIVE declarations only. Anything scanned and absent from here is
 * reported `undeclared` — so this map never needs to be exhaustive, and adding a
 * coordination verb cannot silently produce a covered-looking row.
 *
 * Keep each `evidence` to the concrete mechanism (a chokepoint, a validator, a
 * result-time surface). "The prompt says to" is `prompt-only` by definition.
 */
export const DECLARED_COORD_TIERS: ReadonlyMap<string, TierDeclaration> = new Map<string, TierDeclaration>([
  [
    'coord:send',
    {
      tier: 'schema-refusal',
      evidence:
        'The message envelope is validated at the tool boundary: a hand-authored agent message without sections is refused. This is the 2026-07-27 step-function — 0% -> 73% overnight on a schema change with NO prompt change, held 72–81% for the following week.',
    },
  ],
  [
    'coord:declare-intent',
    {
      tier: 'auto-stamp',
      evidence:
        'coord:orient declares intent as part of the mandated wake bootstrap, so the agent never has to remember a separate call. The stamping happens on a path every wake already takes.',
    },
  ],
]);

/** One behaviour's measured adoption over the census window. Denominators are the caller's to supply. */
export interface BehaviourAdoption {
  /** calls in the window (tool_invocations). */
  readonly calls: number;
  /** DISTINCT agents that made them — the number that separates "one agent's loop" from "the fleet uses it". */
  readonly callers: number;
}

export interface CensusRow {
  readonly id: string;
  readonly tier: CensusTier;
  /** D-001 rank, or null for prompt-only/undeclared (deliberately unranked — see ENFORCEMENT_TIER_RANK). */
  readonly tierRank: number | null;
  readonly evidence: string | null;
  readonly calls: number;
  readonly callers: number;
  /**
   * TIER DEBT: no declaration at all. This is the D-016/D-047 gap — the thing
   * P-002 exists to count.
   */
  readonly tierDebt: boolean;
  /**
   * D-001: "a behaviour that cannot be given tier 1–3 is a candidate for
   * retirement, not for more prompt text." True when the behaviour took ZERO
   * calls in the window AND carries no real enforcement.
   *
   * ⚠ CANDIDATE, never a verdict. D-092 ruled explicitly: do NOT retire the
   * zero-call verbs — make them discoverable first, re-measure at +7d, and retire
   * only what stays at zero. This flag is an input to that re-measurement.
   */
  readonly retirementCandidate: boolean;
}

export interface EnforcementTierCensus {
  readonly windowDays: number;
  /** Sorted: strongest tier first, then by calls desc, then id — so the debt sinks to the bottom where it is legible as a block. */
  readonly rows: readonly CensusRow[];
  readonly totals: {
    /** DENOMINATOR for every ratio a reader might compute (D-003). */
    readonly behaviours: number;
    readonly declared: number;
    readonly undeclared: number;
    /** declared, but only as prose — D-016 says this is not enforcement. */
    readonly promptOnly: number;
    /** carries one of D-001's tiers 1–3. */
    readonly enforced: number;
    readonly retirementCandidates: number;
    /** behaviours with zero calls in the window, whatever their tier. */
    readonly zeroCall: number;
  };
}

/** Order rows strongest-first so the undeclared block lands together at the bottom. */
function sortKey(r: CensusRow): [number, number, string] {
  const rank = r.tierRank ?? (r.tier === 'prompt-only' ? 8 : 9);
  return [rank, -r.calls, r.id];
}

/**
 * PURE. Build the census from a scanned behaviour list + measured adoption.
 *
 * `behaviourIds` should come from the tool-registry scan (see
 * {@link selectCoordBehaviours}), NOT from a literal list — that is what makes
 * the result drift-proof.
 *
 * A behaviour with no adoption entry is treated as ZERO calls, not as unknown:
 * absence from `tool_invocations` over the window IS the measurement. (An
 * unmeasurable behaviour would be a different, louder bug than a quiet zero.)
 */
export function buildEnforcementTierCensus(input: {
  readonly behaviourIds: Iterable<string>;
  readonly adoption: ReadonlyMap<string, BehaviourAdoption>;
  readonly windowDays: number;
  readonly declared?: ReadonlyMap<string, TierDeclaration>;
}): EnforcementTierCensus {
  const declared = input.declared ?? DECLARED_COORD_TIERS;
  const seen = new Set<string>();
  const rows: CensusRow[] = [];

  for (const id of input.behaviourIds) {
    if (seen.has(id)) continue; // a scan can legitimately see the same name twice
    seen.add(id);

    const decl = declared.get(id);
    const tier: CensusTier = decl?.tier ?? UNDECLARED;
    const a = input.adoption.get(id);
    const calls = a?.calls ?? 0;
    const enforced = decl != null && (ENFORCED_TIERS as readonly string[]).includes(decl.tier);

    rows.push({
      id,
      tier,
      tierRank: decl ? ENFORCEMENT_TIER_RANK[decl.tier] : null,
      evidence: decl?.evidence ?? null,
      calls,
      callers: a?.callers ?? 0,
      tierDebt: decl == null,
      retirementCandidate: calls === 0 && !enforced,
    });
  }

  rows.sort((x, y) => {
    const [ax, bx, cx] = sortKey(x);
    const [ay, by, cy] = sortKey(y);
    return ax - ay || bx - by || cx.localeCompare(cy);
  });

  return {
    windowDays: input.windowDays,
    rows,
    totals: {
      behaviours: rows.length,
      declared: rows.filter((r) => !r.tierDebt).length,
      undeclared: rows.filter((r) => r.tierDebt).length,
      promptOnly: rows.filter((r) => r.tier === 'prompt-only').length,
      enforced: rows.filter((r) => r.tierRank != null).length,
      retirementCandidates: rows.filter((r) => r.retirementCandidate).length,
      zeroCall: rows.filter((r) => r.calls === 0).length,
    },
  };
}

/** The namespace whose behaviours this census governs. */
export const COORD_TOOL_PREFIX = 'coord:';

/**
 * Narrow a full tool-name catalog (from `buildBuiltinToolCatalog`) to the
 * coordination behaviours. Kept separate from the scan itself so the census stays
 * pure and unit-testable with no filesystem.
 */
export function selectCoordBehaviours(catalog: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of catalog) if (name.startsWith(COORD_TOOL_PREFIX)) out.push(name);
  return out.sort();
}

/**
 * IO seam: per-behaviour adoption over the window, from `tool_invocations`.
 *
 * Kept as a separate exported function (not folded into the builder) so the
 * census itself stays pure and unit-testable with no PG — the same split
 * `deriveContextPressure` / `fetchContextPressure` uses.
 *
 * ⚠ THIS QUERY WAS EXECUTED AGAINST THE LIVE DB BEFORE THIS FUNCTION WAS WRITTEN,
 * and that is not ceremony. A fail-soft loader reports a broken query as "no
 * signal", which is indistinguishable from a genuine zero — and a census whose
 * whole job is counting zeros cannot tell those apart. Passing unit tests would
 * not have caught it either, because the fixtures encode the same assumption the
 * query does. This is the EI-19300252001829260 class, and it already bit P-001
 * once (a denominator that silently admitted ~1738 machine emitters).
 *
 * Measured 2026-08-03 over 7d, workspace papercusp-workspace: 25 of the 43
 * registered coord verbs took any call at all. coord:glance 151,575 · coord:emit
 * 4,910 · coord:inbox 2,661 · coord:send 1,645 · coord:read 15.
 *
 * `calls` counts EVERY invocation, not just `status='ok'`. Reaching for a verb is
 * the adoption signal; whether it then errored is a different (also interesting)
 * one — coord:send ran 1,645 calls for 1,377 ok, so a 16% failure rate would
 * otherwise vanish into an "adoption" number silently. Kept out of this type
 * deliberately rather than smuggled in.
 */
export async function loadCoordBehaviourAdoption(opts: {
  readonly workspaceId: string;
  readonly windowDays: number;
  readonly getSql: () => {
    <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  };
}): Promise<Map<string, BehaviourAdoption>> {
  const sql = opts.getSql();
  const rows = await sql<{ tool_name: string; calls: string | number; callers: string | number }[]>`
    SELECT tool_name,
           count(*)                       AS calls,
           count(DISTINCT coord_owner_id) AS callers
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND tool_name LIKE ${COORD_TOOL_PREFIX + '%'}
       AND invoked_at >= now() - make_interval(days => ${opts.windowDays})
     GROUP BY tool_name
  `;
  const out = new Map<string, BehaviourAdoption>();
  for (const r of rows) {
    out.set(r.tool_name, { calls: Number(r.calls), callers: Number(r.callers) });
  }
  return out;
}

/**
 * A coord-verb count below this means the registry is not fully initialised, NOT
 * that coordination shrank. Measured 2026-08-03: both independent sources — the
 * `buildBuiltinToolCatalog()` filesystem scan and the live projected registry —
 * return the SAME 43-element set (diffed, identical, not merely equal counts).
 * So anything near 20 is a partial read, and publishing it would understate the
 * denominator rather than fail.
 */
export const MIN_PLAUSIBLE_COORD_BEHAVIOURS = 20;

/**
 * RUNTIME IO seam: the coordination behaviour list, from the LIVE projected
 * registry — deliberately NOT the filesystem scan the tests use.
 *
 * ⚠ WHY NOT `buildBuiltinToolCatalog()` HERE. It is a SYNCHRONOUS recursive walk
 * that reads every .ts file under four source dirs. Measured 2026-08-03 on this
 * repo: 1,485 files, 11.2 MB, **123 ms of blocking I/O**. That is fine in a test
 * and is the repo's A1 "serial fs loop" anti-pattern inside the operator's event
 * loop. The live registry is already in memory and answers in ~0 ms.
 *
 * ⚠ WHY NOT `getCatalog()`. The legacy catalog is documented as INCOMPLETE —
 * `requirePrincipal: false` role-gated tools never enter it (see
 * capabilities/from-tooldef.ts and server-catalog.ts, where reading it silently
 * dropped whole tool groups from the palette). Using it would quietly shrink the
 * census denominator, which is the exact EI-19300252001829260 class of error this
 * plan exists to stop. `listAllProjectedTools()` is the full surface.
 *
 * Both sources were cross-checked live before this function was written (the
 * discipline that produced D-093): the FS scan and the projected registry return
 * IDENTICAL 43-element coord sets. They are two views of one truth, so the census
 * denominator does not depend on which one a caller reaches for.
 *
 * Returns `undefined` — the signal REMOVED, not a smaller number — when the
 * registry looks partial. A census whose entire job is counting zeros must never
 * report a shrunken denominator as if it were a measurement.
 *
 * Imported dynamically to keep this module's pure builder free of the agent-mcp
 * module graph, matching coord-health-lane.ts's own convention for its stores.
 */
export async function loadCoordBehaviourIds(): Promise<string[] | undefined> {
  try {
    const { listAllProjectedTools } = await import('@papercusp/agent-mcp');
    const names: string[] = [];
    for (const t of listAllProjectedTools()) {
      const name = t.expose?.mcp?.name;
      if (name) names.push(name);
    }
    const coord = selectCoordBehaviours(names);
    return coord.length >= MIN_PLAUSIBLE_COORD_BEHAVIOURS ? coord : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The anti-drift guard, as a function so a test can assert on it: every DECLARED
 * behaviour must still exist in the scanned catalog.
 *
 * This is the direction that rots silently. An undeclared verb is loud — it shows
 * up as a debt row. But a declaration left behind by a RENAMED or DELETED verb
 * keeps asserting that something is enforced when nothing by that name exists,
 * and nothing else in the system would ever notice.
 */
export function findStaleDeclarations(
  catalog: Iterable<string>,
  declared: ReadonlyMap<string, TierDeclaration> = DECLARED_COORD_TIERS,
): string[] {
  const live = new Set(catalog);
  return [...declared.keys()].filter((id) => !live.has(id)).sort();
}
