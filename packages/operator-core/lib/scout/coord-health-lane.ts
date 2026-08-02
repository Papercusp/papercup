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
 * `coord:unanswered` / `coord:wake-storm:<recipient>` / `coord:claim-conflict`), so
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

  // 4. Wake / inbox floods — one recipient buried under thousands of (often near-
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

    return buildCoordHealthPatterns({
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
