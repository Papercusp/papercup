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
import type { Anomaly, OverwatchBrief } from './brief-types';

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
