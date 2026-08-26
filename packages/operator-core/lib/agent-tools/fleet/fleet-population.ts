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
 *
 * ── The SECOND way a headcount misleads (EI-21550192883916303) ───────────────
 * Saying which population you counted is not enough, because the remaining
 * number still reads as ACTIVITY. Measured 2026-08-26: an agent diagnosing a
 * saturated MCP proxy counted 415 processes carrying a fleet's slug and reported
 * "415 members are saturating the proxy". 411 of them were PARKED — zero in a
 * running state, ~9% of the box between them. The count was right; the word
 * "active" was the reader's, and nothing in the answer contradicted it.
 *
 * A census that says `counted: 415` and stops has told the reader the filter's
 * verdict and left the composition — the part that decides whether the number
 * means anything about load — to be assumed. So {@link composeLiveness} keys the
 * counted rows by `sessionState`, the SHARED liveness oracle, and
 * {@link renderPopulationCensus} states the split inline. Note the vocabulary
 * gap this closes: both call sites filter on `alive`, which is raw heartbeat
 * FRESHNESS, while `sessionState: 'live'` is the derived verdict "taking turns".
 * A warm-dead session is `alive: true, sessionState: 'ended'`, so the filter that
 * produces the count cannot itself answer the question the count gets read for.
 */

import type { SessionState } from '../coordination/presence-wakeability';

/** How a row's liveness verdict is read. Null/undefined ⇒ counted as unknown. */
export type SessionStateOf<T> = (row: T) => SessionState | null | undefined;

/**
 * The liveness composition of the rows a census COUNTED.
 *
 * `counted` says how many rows passed the filter. This says what they are — and
 * it is the half that determines whether the count supports a conclusion about
 * work being done.
 */
export interface FleetLivenessComposition {
  /** Count per `sessionState`. Only states actually present appear. */
  byState: Partial<Record<SessionState, number>>;
  /** Counted rows whose `sessionState` did not resolve. */
  unknown: number;
  /** Rows with `sessionState: 'live'` — the only ones that are taking turns. */
  live: number;
  /** `live / counted`, 0 when nothing was counted. */
  liveShare: number;
  /**
   * True when the `live` rows are not a MAJORITY of the counted ones — i.e.
   * exactly when reading this count as a measure of activity would overstate it.
   * Named for the misreading rather than the data so a caller cannot render the
   * number without the caveat being in reach.
   *
   * The boundary is `live * 2 <= counted`, not `<`: at exactly half, the total
   * still overstates activity twofold, which is material. `unknown` rows count
   * against liveness for the same reason they get their own bucket — an
   * unresolved verdict is not evidence of work, and crediting it to `live` would
   * silence the caveat on precisely the reads that are least certain.
   */
  overstatesActivity: boolean;
}

/**
 * PURE: bucket rows by liveness verdict.
 *
 * Kept separate from the filter because the two call sites learn `sessionState`
 * at different times — leader-brief's rows arrive decorated, while
 * fleet:assignments stamps the verdict only after `decorateMemberVerdicts` runs,
 * which is why {@link withLivenessComposition} exists alongside the resolver
 * argument on {@link selectFleetPopulation}.
 */
export function composeLiveness<T>(
  rows: readonly T[],
  sessionStateOf: SessionStateOf<T>,
): FleetLivenessComposition {
  const byState: Partial<Record<SessionState, number>> = {};
  let unknown = 0;
  for (const row of rows) {
    const state = sessionStateOf(row);
    if (state == null) unknown += 1;
    else byState[state] = (byState[state] ?? 0) + 1;
  }
  const live = byState.live ?? 0;
  return {
    byState,
    unknown,
    live,
    liveShare: rows.length > 0 ? live / rows.length : 0,
    overstatesActivity: rows.length > 0 && live * 2 <= rows.length,
  };
}

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
   * What the counted rows ARE, by liveness verdict. Present whenever the caller
   * could resolve `sessionState`; absent means nobody asked, NOT that every row
   * is live — a distinction `renderPopulationCensus` states out loud rather than
   * letting the omission read as a clean bill of health.
   */
  liveness?: FleetLivenessComposition;
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
  sessionStateOf?: SessionStateOf<T>,
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
      ...(sessionStateOf ? { liveness: composeLiveness(rows, sessionStateOf) } : {}),
    },
  };
}

/**
 * Attach the liveness composition to a census whose rows only learned their
 * verdict later.
 *
 * Mirrors {@link withShownCount}: returns a NEW census and leaves the original a
 * faithful record of the filter's verdict. `rows` must be the rows the census
 * counted — passing a different array is the drift this module exists to
 * prevent, so callers apply it to the same array they are about to publish.
 */
export function withLivenessComposition<T>(
  census: FleetPopulationCensus,
  rows: readonly T[],
  sessionStateOf: SessionStateOf<T>,
): FleetPopulationCensus {
  return { ...census, liveness: composeLiveness(rows, sessionStateOf) };
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
 * Render the liveness split as the clause a reader would otherwise supply from
 * assumption.
 *
 * The `overstatesActivity` caveat is spelled out rather than left to the
 * numbers because the failure this guards against is not arithmetic — the agent
 * who reported "415 members saturating the proxy" could see 415 and would have
 * seen `4 live, 411 parked` too. What was missing was the sentence saying the
 * count does not measure activity.
 */
function renderLiveness(counted: number, liveness: FleetLivenessComposition): string {
  const split = [
    ...Object.entries(liveness.byState).map(([state, n]) => `${n} ${state}`),
    ...(liveness.unknown > 0 ? [`${liveness.unknown} unknown`] : []),
  ];
  const head = `of the ${counted} counted: ${split.join(', ')}`;
  if (!liveness.overstatesActivity) return head;
  const pct = Math.round(liveness.liveShare * 100);
  return (
    `${head} — only ${liveness.live} of ${counted} (${pct}%) are live, so this count does ` +
    `NOT measure activity; parked sessions are indistinguishable from working ones in a total`
  );
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
  if (census.liveness && census.counted > 0) {
    parts.push(renderLiveness(census.counted, census.liveness));
  } else if (census.counted > 0) {
    // Silence here would read as "all live". Say which question went unasked.
    parts.push('liveness composition not resolved for this read — the count is not an activity measure');
  }
  parts.push(census.basis);
  return parts.join('. ') + '.';
}
