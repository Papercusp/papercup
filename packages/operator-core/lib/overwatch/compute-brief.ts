/**
 * overwatch/compute-brief — B-03 of overwatch-role-2026-06-15.
 *
 * Two halves, by design (D-006: "one health aggregation, two consumers"):
 *
 *  1. THE ANOMALY→ACTION LAYER (this file, landed) — `detectAnomalies(brief)`:
 *     the pure detectors + suggested nudges/observations/escalations that turn a
 *     populated `OverwatchBrief` (C-1) into the actionable `Anomaly[]`. This is
 *     the part B-03 ADDS on top of the shared health model — it is pure logic
 *     over the C-1 types (B-02), so it unit-tests with no DB and is fully
 *     decoupled from the data-gathering half.
 *
 *  2. THE AGGREGATOR WRAPPER (pending) — `computeOverwatchBrief(workspaceId,
 *     hiveSlug)`: calls `computeSystemHealth(workspaceId)` (system-health-tab
 *     P-002, owned by the Health-tab brief — co-owned per D-006), maps its
 *     SystemHealth panels onto the `OverwatchBrief` actionable subset, then runs
 *     `detectAnomalies`. The mapping is a thin structural bind once
 *     `computeSystemHealth` + its `SystemHealth` type land; it is intentionally
 *     NOT built here against an unpublished type. We do NOT build a second
 *     health-gatherer (D-006). Awaiting `system-health:compute:ready`.
 *
 * The thresholds live HERE (not in the renderer): the renderer is a dumb
 * formatter; the JUDGMENT — what counts as a drift, how severe, what to do — is
 * this layer. Each detector is fail-independent: it reads only its own panel, so
 * a degraded panel (a flaky source greyed by the fail-soft aggregator) simply
 * doesn't trip its detector — it never throws the whole detection.
 */
import { emptyOverwatchBrief } from './brief-types';
import type { Anomaly, OverwatchBrief } from './brief-types';
import { computeSystemHealth, deriveQueenAlive } from '../system-health';
import type { SystemHealth } from '../system-health/types';

/**
 * Detect the system-health drifts in a populated brief and attach a suggested
 * action to each. Pure + deterministic — same brief in, same anomalies out (no
 * clock / random; order is the fixed detector order below, and the renderer
 * re-sorts by severity).
 *
 * The overwatch-side detectors (7 of the 8 `AnomalyKind`s — `overwatch-dark` is
 * Queen-side, raised in the Queen's brief by B-09, never in overwatch's own):
 *  - `queen-dark` / `queen-stalled` — liveness first, then cadence (dark wins).
 *  - `token-paused` — starvation (no fallback accounts) escalates; transient observes.
 *  - `work-feed-stuck` — a dead routine escalates (structural); placeable-but-stuck
 *    or stranded-on-a-resolved-constraint nudges the Queen.
 *  - `bees-churning` — churn / dead claims nudge the Queen to re-place.
 *  - `escalation-aging` — aging escalations nudge the Queen to triage.
 *  - `observation-dark` — a flat lane while the fleet runs is observed.
 */
export function detectAnomalies(brief: OverwatchBrief): Anomaly[] {
  const out: Anomaly[] = [];
  const { queen, bees, workFeed, tokens, plans, observations, crossMonitor } = brief;

  // ── Queen liveness + cadence ───────────────────────────────────────────────
  // Cross-monitor "dark" (no heartbeat) is the harder signal and takes precedence
  // over "stalled" (heartbeat present but past cadence) — never raise both.
  if (!crossMonitor.queenAlive) {
    out.push({
      kind: 'queen-dark',
      severity: 'critical',
      subject: 'queen',
      detail: 'Queen liveness has gone dark — no fresh heartbeat (who-watches-the-watcher, D-004).',
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message:
          'Queen — you have gone dark. Waking you: re-derive your survey and resume placement. If this wake misses (woken:0), escalate — a Queen that will not wake is structural.',
      },
    });
  } else if (queen.stalled) {
    out.push({
      kind: 'queen-stalled',
      severity: 'critical',
      subject: 'queen',
      detail:
        `Queen last woke ${queen.lastWakeAt ?? 'unknown'} and is past her cadence` +
        `${queen.workingTracked > 0 ? ` with ${queen.workingTracked} placement(s) in flight` : ''}.`,
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message:
          'Queen — you have stalled past your cadence. Wake, clear your recovering placements, and declare a fresh wake.',
      },
    });
  }

  // ── Tokens / gateway ───────────────────────────────────────────────────────
  // A paused bucket WITH fallback accounts is usually transient RPM saturation —
  // observe. A paused bucket with ZERO accounts available is real starvation and
  // needs a structural fix overwatch cannot perform — escalate (D-002).
  if (tokens.pausedBuckets.length > 0) {
    const buckets = tokens.pausedBuckets.join(', ');
    if (tokens.accountsAvailable <= 0) {
      out.push({
        kind: 'token-paused',
        severity: 'critical',
        subject: 'token buckets',
        detail: `Paused buckets [${buckets}] AND no accounts available — the fleet is token-starved.`,
        suggestedAction: {
          type: 'escalate',
          target: 'owner',
          message:
            `All paused (${buckets}) with zero fallback accounts — a structural rate/account fix is needed ` +
            '(scale-out or rate config). Overwatch cannot rebind the gateway or flip rate config.',
        },
      });
    } else {
      out.push({
        kind: 'token-paused',
        severity: 'warning',
        subject: 'token buckets',
        detail: `Paused buckets [${buckets}] with ${tokens.accountsAvailable} account(s) still available — likely transient RPM saturation.`,
        suggestedAction: {
          type: 'observe',
          message: `Bucket(s) ${buckets} paused on RPM saturation; ${tokens.accountsAvailable} account(s) available. Watching — escalate only if it persists across wakes.`,
        },
      });
    }
  }

  // ── Work feed ──────────────────────────────────────────────────────────────
  // A dead routine is structural (the feed stopped pumping — EI-584): escalate.
  if (workFeed.deadRoutines > 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'critical',
      subject: 'work feed',
      detail: `${workFeed.deadRoutines} dead work-feed routine(s) — auto-eligible work is not flowing (the EI-584 signature).`,
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        message: `${workFeed.deadRoutines} work-feed routine(s) dead; auto-eligible items are stranded. A routine restart is structural — overwatch cannot restart it.`,
      },
    });
  }
  // Placeable work not being placed while routines are alive — the Queen's to place.
  if (workFeed.autoEligibleStuck > 0 && workFeed.deadRoutines === 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'warning',
      subject: 'work feed',
      detail: `${workFeed.autoEligibleStuck} auto-eligible item(s) at attempts:0 unplaced, with the routines alive.`,
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message: `Queen — ${workFeed.autoEligibleStuck} auto-eligible item(s) are ready (attempts:0) but unplaced; place them.`,
      },
    });
  }
  // Work blocked on a constraint that has since resolved — re-open it (the canonical nudge).
  if (workFeed.blockedStranded > 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'warning',
      subject: 'stranded work',
      detail: `${workFeed.blockedStranded} item(s) blocked on an already-resolved constraint.`,
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message: `Queen — ${workFeed.blockedStranded} item(s) are stranded blocked-on-a-resolved-constraint; re-open them so they re-enter the frontier.`,
      },
    });
  }

  // ── Bees ───────────────────────────────────────────────────────────────────
  if (bees.churning > 0 || bees.deadClaims > 0) {
    const parts: string[] = [];
    if (bees.churning > 0) parts.push(`${bees.churning} churning`);
    if (bees.deadClaims > 0) parts.push(`${bees.deadClaims} dead claim(s)`);
    out.push({
      kind: 'bees-churning',
      // A dead claim is abandoned work (worse than churn alone).
      severity: bees.deadClaims > 0 ? 'warning' : 'info',
      subject: 'bees',
      detail: `${parts.join(' · ')} (running ${bees.running}).`,
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message: `Queen — bees: ${parts.join(', ')}; re-place the abandoned unit(s) and check the churning bee(s) for a wedged loop.`,
      },
    });
  }

  // ── Escalations aging ──────────────────────────────────────────────────────
  if (plans.agingEscalations > 0) {
    out.push({
      kind: 'escalation-aging',
      severity: 'warning',
      subject: 'escalations',
      detail: `${plans.agingEscalations} escalation(s) aging past the attention threshold.`,
      suggestedAction: {
        type: 'nudge',
        target: 'queen',
        message: `Queen — ${plans.agingEscalations} escalation(s) are aging; triage them before they age further.`,
      },
    });
  }

  // ── Observation lane dark while the fleet is active ────────────────────────
  if (observations.laneCount === 0 && bees.running > 0) {
    out.push({
      kind: 'observation-dark',
      severity: 'info',
      subject: 'observation lane',
      detail: `Observation lane flat (0 this window) while ${bees.running} bee(s) run — the fleet has stopped recording sensor readings.`,
      suggestedAction: {
        type: 'observe',
        message: `Observation lane flat while ${bees.running} bee(s) active — the turn-end reflection step may be getting skipped fleet-wide.`,
      },
    });
  }

  return out;
}

/**
 * Return a copy of the brief with its `anomalies` populated by `detectAnomalies`.
 * The aggregator wrapper (and tests) use this so detection is applied in exactly
 * one place. Pure — does not mutate the input.
 */
export function withAnomalies(brief: OverwatchBrief): OverwatchBrief {
  return { ...brief, anomalies: detectAnomalies(brief) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE AGGREGATOR WRAPPER — `computeSystemHealth` → `OverwatchBrief` (D-006).
 *
 * The overwatch brief is the ACTIONABLE SUBSET of the shared `SystemHealth`
 * model — we WRAP the single Health-tab aggregator and never build a second
 * health-gatherer (D-006). `mapSystemHealthToBrief` is the pure structural bind
 * (SystemHealth panels → the OverwatchBrief panels); `computeOverwatchBrief` is
 * the thin async wrapper that gathers + maps + detects.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Format an ms-epoch as ISO-8601, or null. Pure given the input ms (no clock). */
function msToIso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Map a `SystemHealth` snapshot (system-health-tab P-001/P-002) onto the
 * actionable `OverwatchBrief` subset (C-1). Pure + deterministic — no I/O, no
 * clock — so it unit-tests against fixtures with no DB.
 *
 * FAIL-SOFT BY CONSTRUCTION (the B-03 requirement): start from
 * `emptyOverwatchBrief` (everything healthy + zeroed) and fill each section ONLY
 * from a panel whose `data` is present. `computeSystemHealth` greys an unreadable
 * source to `status:'unknown'` + `data:null`; such a panel keeps the neutral
 * default here, so one flaky source degrades that field instead of fabricating an
 * anomaly (mirrors the SystemHealth "unknown is never a fabricated outage" stance).
 *
 * Mapping notes where the shared model and the C-1 subset don't line up 1:1:
 *  - `bees.churning`  ← `bees.stale` (running-but-presence-stale = the churn signal);
 *    `bees.deadClaims` ← `bees.orphanedClaims` (active claim, dead holder).
 *  - `workFeed.blockedStranded` ← `bees.placements.stranded` — su-3b017 sourced the
 *    stranded-on-a-resolved-constraint count there in response to the B-03 co-shape
 *    flag (it is NOT `workFeed.frontierBlocked`, which is blocked-on-UNsatisfied).
 *  - `crossMonitor.queenAlive` is the SHARED `deriveQueenAlive` derivation (in
 *    system-health/thresholds) — the SAME function `computeSystemHealth` uses, so
 *    this mapper and the Health tab can't disagree. It is liveness-only, kept
 *    DISTINCT from `stalled` so the detector's `queen-stalled` path stays live:
 *    dark = the loop is gone (started, no next wake armed, AND stale); a started-
 *    but-armed Queen is alive even when stalled; a paused (not-started) Queen is
 *    intentional, never dark. EI-623 was the earlier drift — the shared model and
 *    this mapper each carried their OWN copy and the shared one lagged on
 *    `started && !stalled`; the one shared helper removes that whole drift class.
 *
 * Known degraded-to-default fields until the shared model exposes them (each is
 * renderer-context only OR fail-soft-quiet for its detector, never a wrong alarm):
 *  - `tokens.pausedBuckets` is a COUNT in `TokensHealth`, not bucket NAMES; we
 *    surface a count descriptor so the detector still trips (length>0) and reads
 *    informatively. `tokens.gatewayFailovers` / `gw429s` aren't in the rate model
 *    yet (default 0; no detector keys on them). (Names + gw telemetry flagged.)
 *  - `bees.completed` (no per-window completed count in `BeesHealth`) and
 *    `workFeed.autoEligibleStuck` (su-3b017 adds the attempts:0 count when wiring)
 *    default to 0.
 */
export function mapSystemHealthToBrief(health: SystemHealth, hiveSlug: string): OverwatchBrief {
  const brief = emptyOverwatchBrief(hiveSlug);
  const panels = health.panels;

  const queen = panels.queen.data;
  if (queen) {
    brief.queen = {
      lastWakeAt: msToIso(queen.lastWakeAt),
      stalled: queen.stalled,
      cadenceOk: queen.cadenceOk,
      workingTracked: queen.workingTracked,
      nextFireAt: msToIso(queen.nextFireAt),
      // Resolved by the async computeOverwatchBrief wrapper (needs DB) — the pure
      // mapper leaves it null; SystemHealth.QueenHealth has no coord owner.
      coordOwner: null,
    };
  }

  const bees = panels.bees.data;
  if (bees) {
    brief.bees = {
      running: bees.running,
      completed: 0, // no per-window completed count in BeesHealth — fail-soft default (renderer-only).
      churning: bees.stale,
      deadClaims: bees.orphanedClaims,
    };
  }

  const workFeed = panels.workFeed.data;
  // Surface each work-feed field from its own source (independent fail-soft): the
  // frontier/dead-routine counts from the workFeed panel, the stranded count from
  // the bees panel's placement dispositions (see mapping notes above).
  brief.workFeed = {
    frontier: workFeed?.frontier ?? 0,
    autoEligibleStuck: 0, // attempts:0 count not in WorkFeedHealth yet — fail-soft default.
    deadRoutines: workFeed?.deadRoutines ?? 0,
    blockedStranded: bees?.placements.stranded ?? 0,
  };

  const tokens = panels.tokens.data;
  if (tokens) {
    brief.tokens = {
      // TokensHealth exposes a COUNT, not names; surface a descriptor so the
      // detector trips (length>0) and the nudge reads informatively until names land.
      pausedBuckets:
        tokens.pausedBuckets > 0 ? [`${tokens.pausedBuckets} of ${tokens.totalBuckets} bucket(s)`] : [],
      gatewayFailovers: 0, // not in the rate model yet — fail-soft default (no detector keys on it).
      gw429s: 0, // not in the rate model yet — fail-soft default.
      accountsAvailable: tokens.accountsAvailable,
    };
  }

  // Plans + escalations are two SystemHealth panels feeding the one C-1 plan panel.
  const plans = panels.plans.data;
  const escalations = panels.escalations.data;
  brief.plans = {
    active: plans?.active ?? 0,
    stalledItems: plans?.stalledPlans ?? 0,
    agingEscalations: escalations?.aging ?? 0,
  };

  const observations = panels.observations.data;
  if (observations) {
    brief.observations = {
      laneCount: observations.laneCount,
      recentByRole: { ...observations.recentByRole }, // copy — don't alias the source.
    };
  }

  // Cross-monitor (D-004). queenAlive = the shared liveness-only derivation
  // (deriveQueenAlive) — the SAME function the shared SystemHealth model uses, so
  // the brief and the Health tab can't disagree (EI-623: they used to be duplicated
  // copies that drifted). overwatchAlive defaults true on its own brief (it is
  // computing → alive); B-09 wires the real reverse leg into the shared model.
  const queenAlive = deriveQueenAlive(queen);
  brief.crossMonitor = {
    queenAlive,
    overwatchAlive: health.crossMonitor.overwatchAlive ?? true,
  };

  return brief;
}

/**
 * Compute the overwatch's wake brief for one hive: gather the shared
 * `SystemHealth` (D-006), map it onto the actionable `OverwatchBrief` subset, and
 * run the anomaly→action detector. The async entry point B-04's wake-launch calls
 * (it then renders the result via `renderOverwatchBrief`).
 *
 * FAIL-SOFT: `computeSystemHealth` is itself per-panel fail-soft (a flaky source
 * greys its card), so a partial snapshot already degrades gracefully through the
 * mapper. The try/catch here covers the catastrophic case (the whole aggregator
 * throws) — we return the neutral `emptyOverwatchBrief` (healthy + no anomalies)
 * so the wake still fires with a coherent, non-alarming brief rather than failing
 * the launch (mirrors `computeQueenWakeBrief`'s graceful degradation).
 */
export async function computeOverwatchBrief(
  workspaceId: string,
  hiveSlug: string,
  opts: { wokeBy?: string } = {},
): Promise<OverwatchBrief> {
  const wokeBy = opts.wokeBy?.trim();
  try {
    const health = await computeSystemHealth(workspaceId);
    const brief = mapSystemHealthToBrief(health, hiveSlug);
    if (wokeBy) brief.wokeBy = wokeBy;
    // Resolve the Queen's coord owner so the overwatch can address a nudge to her
    // (it lands in her next wake brief's inbox — the SAME resolveQueenOwner the
    // Queen's own brief reads, so addressing it delivers). Fail-soft: any error
    // leaves coordOwner null → the persona escalates Queen-drift instead of nudging.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { resolveQueenOwner } = await import('../hive/placement-watchdog');
      const { sql } = getOrgPg();
      brief.queen.coordOwner = await resolveQueenOwner(sql, workspaceId, hiveSlug);
    } catch (e) {
      console.warn(
        `[overwatch-brief] could not resolve the Queen coord owner for '${hiveSlug}' — nudges will escalate:`,
        e instanceof Error ? e.message : e,
      );
    }
    // Pre-fold the overwatch's OWN coord inbox (mirrors the Queen's brief) so it sees
    // replies / owner directives without a separate coord:inbox call. The owner is the
    // latest `overwatch · <slug>/…` session's coord_owner_id; the read is workspace-ALS
    // scoped (the coord log is workspace-keyed). Fail-soft: any error leaves inbox unset.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readInbox } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const { sql } = getOrgPg();
      const ownerRows = await sql<{ coord_owner_id: string }[]>`
        SELECT coord_owner_id FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND label LIKE ${'overwatch · ' + hiveSlug + '/%'}
           AND coord_owner_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`;
      const owner = ownerRows[0]?.coord_owner_id ?? null;
      if (owner) {
        const all = await runWithWorkspace(workspaceId, () => readInbox(owner, {}));
        const items = all
          .filter((e) => !e.category) // drop ambient (service-health / governor) like coord:inbox default
          .slice(-10)
          .reverse() // newest-first
          .map((e) => ({ kind: e.kind, from: e.from, summary: (e.summary ?? e.body ?? '').slice(0, 200) }));
        if (items.length > 0) brief.inbox = items;
      }
    } catch (e) {
      console.warn(
        `[overwatch-brief] could not fold the overwatch inbox for '${hiveSlug}':`,
        e instanceof Error ? e.message : e,
      );
    }
    return withAnomalies(brief);
  } catch (err) {
    console.warn(
      `[overwatch-brief] computeSystemHealth failed for hive '${hiveSlug}' — returning the neutral fail-soft brief:`,
      err instanceof Error ? err.message : err,
    );
    const fallback = emptyOverwatchBrief(hiveSlug);
    if (wokeBy) fallback.wokeBy = wokeBy;
    return fallback;
  }
}
