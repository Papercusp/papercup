/**
 * coord-health-lane.ts — the COORD-HEALTH digest lane
 * (blender-self-learning-2026-07-12 P-008 / WI-4453).
 *
 * The coordination fabric continuously records how the FLEET is failing to
 * cooperate: escalations that re-mount over and over (a known-benign transient
 * whose "is this the same incident" dedup gate is too narrow — EI-9492), directed
 * messages that pile up unanswered (an agent alive but not draining its reply
 * queue), single inboxes flooded with thousands of near-duplicate wakes (a
 * subscription firehose or a re-firing sender), and claim conflicts (two agents
 * handed the same work-item). Today that pain reaches ideation only after a human
 * FILES an incident — the ideators never SAW the coordination breakdown itself,
 * only its downstream symptom. (Live example this lane was built from — 2026-07-13:
 * the `papercusp-stalled-claims-5agent-pattern` escalation re-mounted across ~4
 * consecutive Kettle reads and climbed advisory→blocker, while several su inboxes
 * carried tens of unanswered directed messages and ~9k coalesced-duplicate wakes.)
 *
 * This lane feeds the coordination fabric's health straight into the corpus digest
 * as grounded, citable patterns (`ref` = `coord:escalation-storm:<sig>` /
 * `coord:unanswered` / `coord:wake-storm:<recipient>` / `coord:claim-conflict` /
 * `coord:premise-resolve-rate`), so
 * ideation can target chronic coordination pain directly — the coordination
 * counterpart of the watchdog-health (P-007) and gate/pipeline-health (P-010) lanes.
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps readCorpus)
 * exactly like watchdogHealth / gatePipelineHealth: an outage here never disturbs
 * the digest or the cycle. The unanswered-directed signal REUSES the hardened
 * fetchUnansweredDirected reader (WI-4537 exclusions — machine chatter, ack
 * ping-pong, synthetic senders) rather than re-deriving its subtle SQL; the storm
 * aggregates are thin own-SQL over coord_event_log, exactly as the sibling lanes
 * aggregate their own source tables (watchdog_ticks / pipeline_events).
 *
 * The PREMISE-RESOLVE signal (P-011 / D-091) is the one pattern here that is
 * AGGREGATE-ONLY BY CONSTRUCTION: `coord:premise-resolve-rate` carries no sender
 * suffix and must never grow one. `coord:wake-storm:<recipient>` is keyed and
 * `coord:unanswered` is not, so both shapes already exist in this lane — the
 * unkeyed one is an existing precedent, not a special case. See
 * `CoordPremiseResolve` for why keying a metric on an ASSERTED field by its
 * asserter destroys the very thing it measures.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';
import type { PremiseRefKind } from '../agent-tools/coordination/message-fields';
import type { PremiseStatus } from '../agent-tools/coordination/premise-resolve';

/** One re-mounting escalation signature over the window (the pure builder input). */
export interface CoordEscalationStorm {
  /** the escalation's dedup signature (subjectSignature / livenessSignature / summary). */
  signature: string;
  /** distinct escalation OPEN events on this signature in the window (the re-mount count). */
  count: number;
  /** most-severe severity seen for this signature. */
  severity: 'blocker' | 'advisory' | 'unknown';
  /** a representative summary for context. */
  sample: string;
}

/** One recipient's inbound coord-message volume over the window. */
export interface CoordWakeStorm {
  recipient: string;
  /** messages + notifies delivered to this recipient in the window. */
  count: number;
}

/** One recipient's standing unanswered-directed backlog (from fetchUnansweredDirected). */
export interface CoordUnansweredTarget {
  recipient: string;
  count: number;
  oldestAgeMs: number;
}

/**
 * One REF KIND's premise-resolution tally (P-011 / D-091).
 *
 * Keyed by ref GRAMMAR, never by sender — see `CoordPremiseResolve` for why that
 * is a correctness constraint rather than a presentation choice.
 */
export interface CoordPremiseKindStat {
  kind: PremiseRefKind;
  /** refs that reached a falsifiable verdict (holds | broken | stale | unresolvable). */
  checked: number;
  holds: number;
  broken: number;
  stale: number;
  unresolvable: number;
}

/**
 * The premise-resolution aggregate over the window — the P-011 measurement that
 * REPLACES fill rate (D-104: forced sectioning made fill rate 100% by
 * construction, so it measures nothing).
 *
 * ⚠ THERE IS NO SENDER FIELD ON THIS TYPE, AND THERE MUST NEVER BE ONE (D-091).
 * `premises` is an ASSERTED field whose values are only PARTLY checkable: a typed
 * ref resolves against a graph, free prose cannot — and D-026 forbids excluding
 * the prose. Attach any per-agent consequence to being caught with an
 * unresolvable ref — a score, a nag, a warning, or merely a lane pattern naming
 * the sender — and the dominant strategy becomes "cite only what a graph can
 * verify, or stop citing". The measurement would then destroy what it measures,
 * and the uncheckable-but-true premises (the ones a sender must state precisely
 * BECAUSE no graph holds them) are the first to go. Same argument shape as the
 * owner's D-090 ruling on `forYouBecause`, and as `youMayNotKnow.provenance`.
 *
 * The breakdown is by REF KIND because that is what makes the reading ACTIONABLE
 * without attribution: it says which ref GRAMMAR is failing, which is fixable in
 * a tool description and in the docs. Attribution says only which agent to lean
 * on, which is the thing forbidden.
 */
export interface CoordPremiseResolve {
  /** distinct agent-authored premise refs seen in the window (context, NOT a rate). */
  refsSeen: number;
  /** refs that reached a falsifiable verdict — the RATE's denominator. */
  checked: number;
  /** refs that resolved and whose claim currently holds — the RATE's numerator. */
  holds: number;
  /** per-REF-KIND breakdown. Never per-agent. */
  byKind: readonly CoordPremiseKindStat[];
  /**
   * `doc` / `opaque` — declarable but never invalidatable (D-026). NOT failures,
   * and deliberately OUTSIDE the rate: counting them would punish the honest
   * citation of something no graph holds.
   */
  notCheckable: number;
  /** the probe itself failed. OUR failure, not the sender's — also outside the rate. */
  unknown: number;
  /** representative FAILING refs (ref + verdict only — never a sender). */
  samples: readonly { ref: string; status: PremiseStatus; note?: string }[];
}

/** The pure builder's input — the coordination-breakdown aggregate over the window. */
export interface CoordHealthInput {
  /** re-mounting escalation signatures (open events grouped by signature). */
  escalationStorms: readonly CoordEscalationStorm[];
  /** per-recipient inbound-message volume (inbox/wake flooding). */
  wakeStorms: readonly CoordWakeStorm[];
  /** fleet-wide standing unanswered-directed backlog per recipient. */
  unansweredTargets: readonly CoordUnansweredTarget[];
  /** claim-conflict events in the window. */
  claimConflicts: number;
  /** premise-citation quality (P-011 / D-091). Absent ⇒ the signal is simply not emitted. */
  premiseResolve?: CoordPremiseResolve;
}

export interface CoordHealthOpts {
  /** min re-mounts to surface an escalation storm (advisory); a blocker surfaces at 1. */
  minEscalationReMounts?: number;
  /** min per-recipient unanswered-directed count for a recipient to count as "backlogged". */
  minUnanswered?: number;
  /** min inbound-message count for a recipient to surface as an inbox/wake flood. */
  minWakeStorm?: number;
  /** min claim-conflict events to surface the pattern. */
  minClaimConflicts?: number;
  /** min CHECKED premise refs before the resolve-rate is worth reporting at all. */
  minPremiseChecked?: number;
  /** cap on emitted patterns. */
  limit?: number;
}

/** Slugify a free-text signature/recipient into a compact, stable ref suffix. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown'
  );
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function humanAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

/**
 * PURE: the coordination-breakdown aggregate → digest patterns.
 *
 * Emits (most-acute first): re-mounting ESCALATION STORMS (the leaking dedup gate —
 * a blocker surfaces even at one re-mount; an advisory needs a chronic count), the
 * fleet-wide UNANSWERED-DIRECTED backlog (comms stalling), CLAIM CONFLICTS (two
 * agents on one item), then the chronic WAKE/INBOX FLOODS (noise burning turns).
 * Sorted acute→chronic, capped.
 */
export function buildCoordHealthPatterns(
  input: CoordHealthInput,
  opts: CoordHealthOpts = {},
): MetaPattern[] {
  const minReMounts = opts.minEscalationReMounts ?? 3;
  const minUnans = opts.minUnanswered ?? 5;
  const minWake = opts.minWakeStorm ?? 200;
  const minClaim = opts.minClaimConflicts ?? 3;
  const minPremiseChecked = opts.minPremiseChecked ?? 5;
  const limit = opts.limit ?? 10;

  const out: MetaPattern[] = [];

  // 1. Escalation storms — a signature that re-mounts a full escalation cascade.
  //    A blocker demands attention even at one re-mount; an advisory must be chronic.
  const storms = [...input.escalationStorms]
    .filter((s) => (s.severity === 'blocker' && s.count >= 1) || s.count >= minReMounts)
    .sort(
      (a, b) =>
        (b.severity === 'blocker' ? 1 : 0) - (a.severity === 'blocker' ? 1 : 0) ||
        b.count - a.count,
    );
  for (const s of storms) {
    out.push({
      category: 'coord-health',
      ref: `coord:escalation-storm:${slug(s.signature)}`,
      summary: `escalation re-mounted ${s.count}× in 24h (${s.severity}): ${trunc(s.signature, 80)} — a repeating cascade, not a one-off`,
      detail: `${s.count} escalation event(s)/24h on the same signature${
        s.sample ? `; e.g. "${trunc(s.sample, 120)}"` : ''
      }. A known-benign transient re-mounting a full escalation cascade (fresh work-item + probe + owner alert) means the "is this the same incident" dedup gate is too narrow (EI-9492): widen the dedup key or add a recently-resolved suppression so the same condition can't re-page every wake.`,
      weight: s.severity === 'blocker' ? 1 : 0.8,
    });
  }

  // 2. Unanswered directed — a directed message is meant to PREEMPT the recipient's
  //    work, so a growing per-agent backlog means agents are alive but not draining
  //    their reply queue (the "live but not converting" stall).
  const worst = [...input.unansweredTargets]
    .filter((t) => t.count >= minUnans)
    .sort((a, b) => b.count - a.count);
  if (worst.length > 0) {
    const total = worst.reduce((n, t) => n + t.count, 0);
    const top = worst
      .slice(0, 5)
      .map((t) => `${t.recipient} ${t.count} (${humanAge(t.oldestAgeMs)})`)
      .join(', ');
    out.push({
      category: 'coord-health',
      ref: 'coord:unanswered',
      summary: `${worst.length} agent(s) hold ≥${minUnans} unanswered directed message(s) (${total} total) — directed comms are stalling`,
      detail: `worst: ${top}. A directed message OUTRANKS the recipient's own work; a per-agent backlog that grows across wakes despite landed nudges is a coordination-comms stall (agents alive, producing turns, but not converting into reply-drain or claim progress) — the reply-obligation surfacing or the wake→reply path may be failing.`,
      weight: 0.7,
    });
  }

  // 3. Claim conflicts — two agents handed the same work-item (scheduler/claim-spec
  //    dedup leak, or a stale claim not releasing).
  if (input.claimConflicts >= minClaim) {
    out.push({
      category: 'coord-health',
      ref: 'coord:claim-conflict',
      summary: `${input.claimConflicts} claim conflict(s) in 24h — agents contending for the same work-item`,
      detail:
        'repeated claim conflicts mean the scheduler/claim-spec is surfacing the same item to multiple agents, or a stale claim is not releasing on session death; check claim TTLs, the hold-open sweep cadence, and scheduler dedup.',
      weight: 0.6,
    });
  }

  // 4. Premise-citation quality (P-011 / D-091) — the replacement for fill rate.
  //
  //    Deliberately emitted BEFORE the wake-storm floods: floods emit one pattern
  //    PER RECIPIENT and are the most numerous thing this lane produces, so a
  //    noisy fleet would push this single corpus-wide reading past `limit` and
  //    silently delete the measurement. Ordering is the cap policy here.
  const pr = input.premiseResolve;
  if (pr && pr.checked >= minPremiseChecked) {
    const failed = pr.checked - pr.holds;
    const rate = pr.holds / pr.checked;
    const failRate = 1 - rate;
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    // Per-KIND, worst grammar first — that ordering is the actionable part.
    const kinds = [...pr.byKind]
      .filter((k) => k.checked > 0)
      .sort(
        (a, b) => b.checked - b.holds - (a.checked - a.holds) || b.checked - a.checked,
      );
    const kindLine = kinds
      .map((k) => `${k.kind} ${k.holds}/${k.checked}`)
      .join(', ');
    const sampleLine = pr.samples
      .slice(0, 4)
      .map((s) => `${s.ref} → ${s.status}${s.note ? ` (${trunc(s.note, 60)})` : ''}`)
      .join('; ');

    out.push({
      category: 'coord-health',
      ref: 'coord:premise-resolve-rate',
      summary: `premise refs resolve ${pct(rate)} (${pr.holds}/${pr.checked} checked; ${failed} failing) — cited ground that does not hold`,
      detail:
        `by ref kind: ${kindLine || 'n/a'}. ` +
        `${pr.refsSeen} distinct agent-authored premise ref(s) in 24h; ${pr.notCheckable} not-checkable (doc/opaque — declarable but never invalidatable, D-026, deliberately outside the rate) and ${pr.unknown} unknown (the probe failed — our gap, not the sender's).` +
        (sampleLine ? ` Failing: ${sampleLine}.` : '') +
        ` A premise is what a sender's reasoning RESTED ON, so a ref that does not resolve means a message was built on ground that was never there (broken) or has since moved (stale). ` +
        `Read this by REF GRAMMAR, never by sender: the fix for a failing kind is a clearer ref form in the tool description and the docs. ` +
        `NOT a gate — a low rate never blocks, warns, or refuses a send (D-091; D-088's standing condition that verification is never authorisation).`,
      // Weight tracks the FAILURE rate, not the volume: an all-holds reading is
      // still emitted (a reader that only ever sees failures cannot tell "no
      // premises were checkable" from "all of them held" — the same argument
      // premise-resolve.ts makes for carrying both stamp halves), but it ranks
      // low enough that the cap deprioritises it naturally.
      weight: Math.min(0.75, 0.25 + 0.5 * failRate),
    });
  }

  // 5. Wake / inbox floods — one recipient buried under thousands of (often near-
  //    duplicate) deliveries: a subscription firehose or a re-firing sender whose
  //    coalescing/dedup is leaking; heavy wake traffic burns turns and buries real
  //    directed mail.
  const floods = [...input.wakeStorms]
    .filter((w) => w.count >= minWake)
    .sort((a, b) => b.count - a.count);
  for (const w of floods) {
    out.push({
      category: 'coord-health',
      ref: `coord:wake-storm:${slug(w.recipient)}`,
      summary: `${w.recipient} received ${w.count} coord message(s) in 24h — an inbox/wake flood`,
      detail: `${w.count} deliveries/24h to one recipient. A subscription firehose or a re-firing sender is flooding this inbox — if most are near-duplicates the coalescing/dedup is leaking; heavy wake traffic burns turns and buries real directed mail under noise.`,
      weight: Math.min(0.6, 0.2 + w.count / 5000),
    });
  }

  return out.slice(0, Math.max(1, limit));
}

/** Bound on how many distinct refs one lane pass will probe. */
const PREMISE_REFS_MAX = 200;

/**
 * The premise-resolution read (P-011 / D-091).
 *
 * ⚠ REUSES THE LIVE RESOLVER — `resolvePremiseStamps` + the production
 * `premiseProbes()` — deliberately, and this is the load-bearing design choice
 * rather than convenience. A second, lane-local "does this ref resolve" checker
 * would be free to drift from the one the SEND path stamps with, and the two
 * would then disagree about what "resolves" means: the corpus digest would
 * report a rate that no message stamp corroborates. One resolver, two callers.
 *
 * Every dependency is imported DYNAMICALLY inside the function, matching this
 * lane's existing treatment of `fetchUnansweredDirected` and premise-probes.ts's
 * own rule — the stores stay out of the module graph at load time.
 *
 * Fail-soft to `undefined`: an outage here removes the signal, never the lane.
 */
export async function loadCoordPremiseResolve(
  ws: string,
): Promise<CoordPremiseResolve | undefined> {
  try {
    const { sql } = getOrgPg();
    const [{ MACHINE_SENDER_PATTERN }, { resolvePremiseStamps, PREMISE_STAMPS_MAX }, { premiseProbes }] =
      await Promise.all([
        import('../agent-tools/coordination/machine-authored'),
        import('../agent-tools/coordination/premise-resolve'),
        import('../agent-tools/coordination/premise-probes'),
      ]);

    // AGENT-AUTHORED ONLY (D-091's denominator). The exclusion reuses the ONE
    // canonical machine-sender pattern shared by sendMessage and
    // unanswered-directed rather than a third hand-maintained list — a private
    // copy here is exactly how the three call sites would drift apart.
    // `premises` live on SECTIONS, never on the envelope (verified against the
    // live corpus: 78 sectioned rows, 0 envelope-level).
    const rows = await sql<Array<{ ref: string }>>`
      SELECT DISTINCT p AS ref
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements(e.body->'sections') s
        CROSS JOIN LATERAL jsonb_array_elements_text(s->'premises') p
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.ts > now() - interval '24 hours'
         AND jsonb_typeof(e.body->'sections') = 'array'
         AND jsonb_typeof(s->'premises') = 'array'
         AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
       LIMIT ${PREMISE_REFS_MAX}`;

    const refs = rows.map((r) => r.ref).filter(Boolean);
    if (refs.length === 0) return undefined;

    // `resolvePremiseStamps` caps at PREMISE_STAMPS_MAX (its per-MESSAGE
    // contract), so a window-wide read is chunked to that cap rather than
    // bypassing it — the cap keeps its meaning and the resolver stays untouched.
    const probes = premiseProbes({});
    const stamps: Awaited<ReturnType<typeof resolvePremiseStamps>> = [];
    for (let i = 0; i < refs.length; i += PREMISE_STAMPS_MAX) {
      stamps.push(...(await resolvePremiseStamps(refs.slice(i, i + PREMISE_STAMPS_MAX), probes)));
    }

    return aggregatePremiseStamps(stamps);
  } catch {
    return undefined;
  }
}

/**
 * PURE: resolved stamps → the per-REF-KIND aggregate. Split out from the IO so
 * the counting rules (what lands in the rate, what is held outside it) are
 * unit-testable without a database.
 */
export function aggregatePremiseStamps(
  stamps: readonly { ref: string; kind: PremiseRefKind; status: PremiseStatus; note?: string }[],
): CoordPremiseResolve {
  const byKind = new Map<PremiseRefKind, CoordPremiseKindStat>();
  let checked = 0;
  let holds = 0;
  let notCheckable = 0;
  let unknown = 0;
  const samples: { ref: string; status: PremiseStatus; note?: string }[] = [];

  for (const s of stamps) {
    // `not-checkable` and `unknown` are held OUTSIDE the rate on purpose: the
    // first would punish honestly citing something no graph holds (D-026), the
    // second would charge the sender for OUR probe failing.
    if (s.status === 'not-checkable') {
      notCheckable += 1;
      continue;
    }
    if (s.status === 'unknown') {
      unknown += 1;
      continue;
    }

    let k = byKind.get(s.kind);
    if (!k) {
      k = { kind: s.kind, checked: 0, holds: 0, broken: 0, stale: 0, unresolvable: 0 };
      byKind.set(s.kind, k);
    }
    k.checked += 1;
    checked += 1;
    if (s.status === 'holds') {
      k.holds += 1;
      holds += 1;
    } else {
      if (s.status === 'broken') k.broken += 1;
      else if (s.status === 'stale') k.stale += 1;
      else k.unresolvable += 1;
      if (samples.length < 8) samples.push({ ref: s.ref, status: s.status, note: s.note });
    }
  }

  return {
    refsSeen: stamps.length,
    checked,
    holds,
    byKind: [...byKind.values()],
    notCheckable,
    unknown,
    samples,
  };
}

/**
 * The PG edge: the 24h coordination-breakdown aggregate over coord_event_log for
 * the active workspace + the fleet-wide unanswered-directed read (REUSING the
 * hardened fetchUnansweredDirected). Returns [] on any failure (fail-soft lane).
 */
export async function buildCoordHealthLane(
  opts: { workspaceId?: string } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();

    // Re-mounting escalations: OPEN events (kind='escalation', not the resolved
    // markers) grouped by dedup signature over 24h. The count is the storm.
    const escRows = await sql<
      Array<{ sig: string; n: number; sev_rank: number; sample: string | null }>
    >`
      SELECT
        coalesce(
          body->>'subjectSignature',
          body->>'livenessSignature',
          left(body->>'summary', 80)
        ) AS sig,
        count(*)::int AS n,
        max(
          CASE body->>'severity'
            WHEN 'blocker' THEN 2
            WHEN 'advisory' THEN 1
            ELSE 0
          END
        )::int AS sev_rank,
        (array_agg(body->>'summary' ORDER BY ts DESC))[1] AS sample
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'escalations'
         AND body->>'kind' = 'escalation'
         AND ts > now() - interval '24 hours'
       GROUP BY 1`;

    // Per-recipient inbound volume (inbox/wake flooding): real agent recipients
    // only — never a broadcast ('*'), an audience selector ('@…'), or 'human'.
    const wakeRows = await sql<Array<{ recipient: string; n: number }>>`
      SELECT r AS recipient, count(*)::int AS n
        FROM harness_shared.coord_event_log
        CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND jsonb_typeof(body->'to') = 'array'
         AND r NOT IN ('human', '*')
         AND r NOT LIKE '@%'
       GROUP BY 1
      HAVING count(*) >= 100`;

    // Claim conflicts in the window (best-effort text match — the coord log does
    // not carry a dedicated conflict kind).
    const claimRows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND (
           body->>'summary' ILIKE '%claim%conflict%'
           OR body::text ILIKE '%claim_conflict%'
         )`;

    // Unanswered directed — REUSE the hardened reader over the active recipient
    // set (best-effort: an unavailable coord fast-path yields no targets).
    let unansweredTargets: CoordUnansweredTarget[] = [];
    try {
      const recipRows = await sql<Array<{ r: string }>>`
        SELECT DISTINCT r
          FROM harness_shared.coord_event_log
          CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
         WHERE workspace_id = ${ws}
           AND surface = 'messages'
           AND ts > now() - interval '3 days'
           AND r ~ '^(su-|s-|cup-)'
         LIMIT 300`;
      const recipients = recipRows.map((x) => x.r).filter(Boolean);
      if (recipients.length > 0) {
        const { fetchUnansweredDirected } = await import(
          '../agent-tools/coordination/unanswered-directed'
        );
        const map = await fetchUnansweredDirected(recipients);
        unansweredTargets = [...map.entries()].map(([recipient, s]) => ({
          recipient,
          count: s.count,
          oldestAgeMs: s.oldestAgeMs,
        }));
      }
    } catch {
      /* best-effort — the unanswered signal is optional decoration */
    }

    // Premise-citation quality (P-011 / D-091) — independent + fail-soft, so a
    // premise-read outage costs this one signal and never the whole lane.
    let premiseResolve: CoordPremiseResolve | undefined;
    try {
      premiseResolve = await loadCoordPremiseResolve(ws);
    } catch {
      /* best-effort — the premise signal is optional decoration */
    }

    return buildCoordHealthPatterns({
      premiseResolve,
      escalationStorms: escRows.map((r) => ({
        signature: r.sig || 'unknown',
        count: Number(r.n) || 0,
        severity: r.sev_rank >= 2 ? 'blocker' : r.sev_rank >= 1 ? 'advisory' : 'unknown',
        sample: r.sample ?? '',
      })),
      wakeStorms: wakeRows.map((r) => ({
        recipient: r.recipient,
        count: Number(r.n) || 0,
      })),
      unansweredTargets,
      claimConflicts: Number(claimRows[0]?.n) || 0,
    });
  } catch {
    return [];
  }
}
