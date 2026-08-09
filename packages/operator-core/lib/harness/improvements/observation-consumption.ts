/**
 * observation-consumption.ts — write back WHAT THE BLENDER ALREADY READ
 * (learning-loop-identity-and-consumption-2026-08-08 P-004 / WI-36774, D-028).
 *
 * ## The gap this closes, stated exactly
 *
 * [owner 2026-08-08, interactive, ratified as D-001]: *"the blender reads
 * every new observation within ~20 minutes via a live watermark; **what it does
 * not do is write anything back**."* That is the whole defect. The Scout corpus
 * digest reads the observation lane every cycle (`corpus-digest-deps.ts`
 * `friction()` ← `readObservationItems`), folds recurring ones into meta-patterns,
 * and then discards the fact that it ever looked. So a fully-mined observation and
 * a never-read one are byte-identical on the row, and an auditor counting the lane
 * sees 15k rows of "open" work that is actually a drained sensor log.
 *
 * ## What this module does NOT do, and why that is load-bearing
 *
 * It does **not** touch `status`, and it does not delete, close, retire, or
 * archive anything. Two standing rulings forbid that, and both were nearly
 * violated by the first draft of this work (D-028 records the correction):
 *
 *   - **D-005** — observation rows are a TIME SERIES. `status='open'` on this lane
 *     does not mean "unfinished work"; that is BY DESIGN, and those rows are already
 *     excluded from the claim queue and from `work_items:list`. A prior agent's bulk
 *     pass closed 806 observation rows as junk and it was a mistake. Do not repeat it.
 *   - **D-001** — the fix is CONSUMPTION MARKING, never deletion.
 *
 * So "unconsumed signal" becomes a FIELD predicate — `payload->'consumption' IS
 * NULL` — and no row's lifecycle state is ever mutated to express it. Readers get a
 * truthful count; the time series stays intact.
 *
 * `updated_ts` is deliberately NOT bumped either: the stamp is metadata about what
 * the blender saw, not a state change by an agent. Bumping it would make every
 * stamped row look freshly-touched to `hfc_updated_idx` readers and to the
 * accumulator's `updated_ts`-keyed lanes — a measurement artifact masquerading as
 * activity.
 *
 * ## Provenance is REUSED, not rebuilt
 *
 * "This work item traces back to these N observations" is already answerable via
 * `scout_routed_ideas.addresses_pattern_refs` — measured live 2026-08-09: 1031 of
 * 1200 routed ideas carry refs, 926 distinct `wi:` refs, **0 dangling**, 344 of them
 * observation rows (D-027). This module does not build a second edge. It records the
 * complementary fact that edge cannot: that the blender READ a row at all, including
 * the ~98% that are read and correctly found unremarkable.
 *
 * Watchdog-family shape (as `signal-accumulator.ts` / `hygiene.ts`): pure deciders
 * split from the PG write, env-tunable with a kill switch, and NEVER throws into the
 * cycle it rides on — a stamping failure must not cost a Scout cycle.
 */
import type { CorpusDigest, MetaPattern } from '../../scout/types';

/** `wi:` ref prefix used by every `MetaPattern.ref` that points at a work-item. */
const WI_REF_PREFIX = 'wi:';

/**
 * Max observations stamped in ONE cycle. The steady-state load is tiny (~281
 * observations/day measured 2026-08-09, so ~12/hour against an hourly cycle), but
 * the FIRST run after deploy faces the whole standing backlog (15,557 rows). The cap
 * makes that backfill drain over several cycles instead of one large write inside a
 * latency-sensitive cycle path.
 *
 * env `PAPERCUSP_OBS_CONSUMPTION_CAP`; `<= 0` DISABLES stamping entirely (kill switch).
 */
export function observationConsumptionCap(): number {
  const n = Number(process.env.PAPERCUSP_OBS_CONSUMPTION_CAP ?? 2000);
  return Number.isFinite(n) ? n : 2000;
}

/** The stamp written under `payload.consumption`. */
export interface ConsumptionStamp {
  /** ISO instant the blender read this observation. */
  at: string;
  /** The Scout cycle that read it (e.g. `scout-1786240815085`). */
  cycleId: string;
  /**
   * Pattern refs this observation was FOLDED INTO, when it fed one. Absent for a
   * row that was read and not folded — which is the common case and is recorded
   * deliberately: "read, found unremarkable" and "never looked at" are different
   * facts, and collapsing them is the ambiguity this module exists to remove.
   */
  patternRefs?: string[];
}

/** All digest lanes whose patterns carry a drill-back `ref` (see {@link CorpusDigest}). */
function digestLanes(digest: CorpusDigest): MetaPattern[][] {
  return [
    digest.recurringFriction,
    digest.timeTokenSinks,
    digest.chronicDeferrals,
    digest.capabilityGaps,
    digest.rubricRatings ?? [],
    digest.standingFacts ?? [],
    digest.nicheMap ?? [],
    digest.watchdogHealth ?? [],
  ].filter(Array.isArray);
}

/**
 * PURE: work-item id → the pattern refs that folded it, across every digest lane.
 *
 * Only `wi:`-prefixed refs name a work-item; the other ref namespaces in a digest
 * (`fact:`, `rubric:`, `niche:`, `watchdog:`, `plan:`, `usage:`, `coord:`) are
 * deliberately ignored rather than stripped blindly — an earlier version of this
 * plan's own analysis mis-keyed on a substring and had to be retracted (D-024).
 */
export function foldedObservationRefs(digest: CorpusDigest): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const lane of digestLanes(digest)) {
    for (const p of lane) {
      const ref = p?.ref;
      if (typeof ref !== 'string' || !ref.startsWith(WI_REF_PREFIX)) continue;
      const id = ref.slice(WI_REF_PREFIX.length);
      if (!id) continue;
      const prior = out.get(id);
      if (prior) {
        if (!prior.includes(ref)) prior.push(ref);
      } else {
        out.set(id, [ref]);
      }
    }
  }
  return out;
}

/** One row's planned stamp. */
export interface PlannedStamp {
  id: string;
  stamp: ConsumptionStamp;
}

/**
 * PURE: plan the stamps for one cycle.
 *
 * `readIds` is every candidate the digest's friction lane returned — which is the
 * improvement lane UNIONED with the observation lane. Non-observation ids are left
 * in deliberately and filtered by the WRITE's `lane = 'observation'` predicate:
 * making the SQL the single authority on what counts as an observation means this
 * planner cannot drift from it as the lane definition moves (P-006 is an open item
 * about exactly that population split).
 *
 * Idempotency is NOT enforced here — the write skips rows already carrying a stamp,
 * so it is decided against live state rather than against a snapshot that a
 * concurrent cycle could invalidate.
 */
export function planConsumptionStamps(opts: {
  readIds: readonly string[];
  digest: CorpusDigest;
  cycleId: string;
  nowIso: string;
  cap?: number;
}): PlannedStamp[] {
  const cap = opts.cap ?? observationConsumptionCap();
  if (cap <= 0) return []; // kill switch
  const folded = foldedObservationRefs(opts.digest);

  // A folded observation may not be inside `readIds` (a pattern can cite a row the
  // friction window no longer covers), so the planned set is the UNION — stamping
  // only the read set would silently drop exactly the rows with the most provenance.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [...opts.readIds, ...folded.keys()]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= cap) break;
  }

  return ids.map((id) => {
    const refs = folded.get(id);
    return {
      id,
      stamp: {
        at: opts.nowIso,
        cycleId: opts.cycleId,
        ...(refs && refs.length > 0 ? { patternRefs: refs } : {}),
      },
    };
  });
}

/** Injectable write seam (tests stub it; prod uses the org pool). */
export interface ObservationConsumptionDeps {
  stamp: (workspaceId: string, planned: readonly PlannedStamp[]) => Promise<number>;
}

/**
 * The PG write. ONE statement, driven by a jsonb id→stamp map.
 *
 * `payload->'consumption' IS NULL` makes it idempotent BY CONSTRUCTION: a re-run,
 * an overlapping cycle, or a replayed tick can never re-stamp a row or overwrite the
 * cycle that first read it. That matters because the FIRST reader is the interesting
 * one — "when did the blender first see this" is the question the stamp answers.
 */
export async function stampObservationConsumptionPg(
  workspaceId: string,
  planned: readonly PlannedStamp[],
): Promise<number> {
  if (planned.length === 0) return 0;
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const map: Record<string, ConsumptionStamp> = {};
  for (const p of planned) map[p.id] = p.stamp;
  const rows = await sql<Array<{ feature_id: string }>>`
    UPDATE harness_shared.work_items w
       SET payload = COALESCE(w.payload, '{}'::jsonb)
                     || jsonb_build_object('consumption', s.stamp)
      FROM (SELECT key AS id, value AS stamp FROM jsonb_each(${JSON.stringify(map)}::jsonb)) s
     WHERE w.workspace_id = ${workspaceId}
       AND w.lane = 'observation'
       AND w.feature_id = s.id
       AND w.payload -> 'consumption' IS NULL
   RETURNING w.feature_id`;
  return rows.length;
}

const defaultDeps: ObservationConsumptionDeps = { stamp: stampObservationConsumptionPg };

export interface RecordConsumptionResult {
  planned: number;
  stamped: number;
  /** Set when stamping failed — the cycle continues regardless. */
  error?: string;
}

/**
 * Record that this cycle read these observations. Best-effort by contract: it
 * NEVER throws, so a stamping fault cannot cost a Scout cycle (the same fail-soft
 * rule the accumulator sweep already follows).
 *
 * This stamp is now the ONLY bound on observation growth. The delete-based
 * retention sweep that used to sit beside it was retired 2026-08-09 (D-001/D-029),
 * so consumption is what makes an observation's usefulness legible — and any
 * future storage bound must be archive/rollup over CONSUMED rows, never a DELETE.
 */
export async function recordObservationConsumption(
  opts: {
    workspaceId: string;
    readIds: readonly string[];
    digest: CorpusDigest;
    cycleId: string;
    nowIso?: string;
    cap?: number;
  },
  deps: ObservationConsumptionDeps = defaultDeps,
): Promise<RecordConsumptionResult> {
  try {
    const planned = planConsumptionStamps({
      readIds: opts.readIds,
      digest: opts.digest,
      cycleId: opts.cycleId,
      nowIso: opts.nowIso ?? new Date().toISOString(),
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
    if (planned.length === 0) return { planned: 0, stamped: 0 };
    const stamped = await deps.stamp(opts.workspaceId, planned);
    return { planned: planned.length, stamped };
  } catch (err) {
    return { planned: 0, stamped: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
