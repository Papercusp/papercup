/**
 * fleet-population — make every fleet headcount SAY WHICH POPULATION IT COUNTED,
 * computed from the same predicate that produced the rows (P-010,
 * fleet-lead-instrumentation-audit-2026-08-09).
 *
 * WHY THIS EXISTS. Measured across a few minutes of one fleet, the SAME fleet read
 * as 11 members (leader-brief `summary.members`), then 11 rows and 14 rows
 * (leader-brief `members[]`, the second with `include_stale:true`), then 8 and 9
 * agents (fleet:assignments, claim-scoped). Every one of those numbers is
 * defensible on its own terms and NOTHING in any response reconciles them, so a
 * leader comparing two of them concludes members appeared or vanished. The
 * default that hides stale-idle members hides them precisely WHEN MEMBERS ARE
 * DYING, which is the moment the count matters most.
 *
 * THE FIX IS STRUCTURAL, NOT DOCUMENTARY. A `population: '...'` string that a
 * caller sets by hand next to a count it computed separately is exactly the
 * arrangement that drifts — the label keeps saying what the filter USED to do.
 * So {@link selectFleetPopulation} takes the candidates AND the predicate and
 * returns the rows and the census TOGETHER: the numbers are derived from the same
 * array and the same `keep` in one pass, and there is no supported way to publish
 * a census that disagrees with the rows shipped beside it.
 *
 * The census answers, in every response that carries a headcount:
 *   - which population is being counted (`population` + `basis`),
 *   - how many rows existed BEFORE this response's filter (`candidates`),
 *   - how many were withheld and WHY (`withheld` / `withheldReason`),
 *   - the exact argument that reveals them (`reveal`).
 *
 * `withheld: 0` is as informative as a nonzero one — it says the filter had
 * nothing to hide, which is the reading a bare count cannot give you.
 */

/** What a response counted, stated beside the count itself. */
export interface FleetPopulationCensus {
  /** Stable name of the population — the thing `counted` is a count OF. */
  population: string;
  /** One sentence: what qualifies a row for this population. */
  basis: string;
  /** Rows considered BEFORE this response's filter ran. */
  candidates: number;
  /** Rows that passed the filter — the number every count in this response describes. */
  counted: number;
  /** candidates - counted. Always present, including when it is 0. */
  withheld: number;
  /** Why the withheld rows were withheld; null only when none were. */
  withheldReason: string | null;
  /** The exact argument that would include them; null when there is no such lever. */
  reveal: string | null;
  /**
   * Rows actually PRESENT in the payload, when a later byte/row budget dropped
   * some of what `counted` counts. Omitted when the payload carries them all.
   * This is a SECOND, independent way a list stops matching its own summary —
   * `counted` describes the filter's verdict, `shown` describes what survived
   * transport — and conflating them is the same defect one level down.
   */
  shown?: number;
  /** Why `shown` < `counted`; present only alongside `shown`. */
  shownReason?: string;
}

export interface FleetPopulationMeta {
  population: string;
  basis: string;
  withheldReason: string;
  reveal: string | null;
}

/**
 * Filter a candidate roster AND describe what the filter did, in one pass.
 *
 * Both halves come from the same `candidates` array and the same `keep`
 * predicate, so a census can never describe a different selection than the rows
 * returned with it. `withheldReason` is dropped to null when nothing was actually
 * withheld — a reason attached to zero rows reads as an admission that something
 * is hidden, and would train readers to discount the field when it matters.
 */
export function selectFleetPopulation<T>(
  candidates: readonly T[],
  keep: (row: T) => boolean,
  meta: FleetPopulationMeta,
): { rows: T[]; census: FleetPopulationCensus } {
  const rows = candidates.filter((row) => keep(row));
  const withheld = candidates.length - rows.length;
  return {
    rows,
    census: {
      population: meta.population,
      basis: meta.basis,
      candidates: candidates.length,
      counted: rows.length,
      withheld,
      withheldReason: withheld > 0 ? meta.withheldReason : null,
      reveal: withheld > 0 ? meta.reveal : null,
    },
  };
}

/**
 * Record that a later budget trimmed the rows actually shipped below `counted`.
 *
 * Returns a NEW census — the original stays a faithful record of the filter's
 * verdict. A `shown` equal to (or above) `counted` is a no-op rather than an
 * error: transport dropping nothing is the normal case, and a census that
 * announced a truncation of zero rows would be noise.
 */
export function withShownCount(
  census: FleetPopulationCensus,
  shown: number,
  shownReason: string,
): FleetPopulationCensus {
  if (!Number.isFinite(shown) || shown >= census.counted) return census;
  return { ...census, shown, shownReason };
}

/**
 * One line for a human/agent reading the response — the reconciliation sentence
 * a leader otherwise has to assemble from two tool calls.
 */
export function renderPopulationCensus(census: FleetPopulationCensus): string {
  const parts = [`${census.counted} ${census.population} (of ${census.candidates} on the roster)`];
  if (census.withheld > 0) {
    parts.push(
      `${census.withheld} withheld: ${census.withheldReason}` +
        (census.reveal ? ` — reveal with ${census.reveal}` : ''),
    );
  }
  if (census.shown != null) {
    parts.push(`only ${census.shown} shown in this payload: ${census.shownReason}`);
  }
  parts.push(census.basis);
  return parts.join('. ') + '.';
}
