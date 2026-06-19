/**
 * F2 (round-4 Lane F / P-031): the perf-regression DEPLOY-GATE decision.
 *
 * A PURE policy layer that turns F1's per-thread perf verdict (perf-budgets.ts
 * `evaluatePerfSignals`, plan P-030) into a green-checkpoint action: `pass`,
 * `warn` (surface it, still advance the green pin), or `block` (hold the deploy).
 *
 * Two load-bearing rules from the plan (infra-perf-reliability-audit-round4-2026-06-19):
 *   - DEFAULT-WARN until the budgets are trusted. A perf wedge only `block`s the deploy
 *     when the OWNER has explicitly armed block-mode; otherwise the worst it does is
 *     `warn` (broadcast/escalate) and let the green commit advance. This keeps the gate
 *     from ever silently stranding `main` on a perf signal that turns out noisy.
 *   - FLAG-GATED + FAIL-SOFT. Disabled by default (a no-op `pass`); a stale / missing /
 *     unparseable signal capture (verdict `unknown`) never blocks — missing perf data
 *     must not hold a green deploy.
 *
 * Kept as a STANDALONE, framework-agnostic decision (`evaluatePerfGate`) so it composes
 * either as a bespoke green-checkpoint pre-advance hook OR as one check inside a shared
 * fail-fast preflight framework (the deploy-gate ABI preflight, A1/A2 of
 * infra-fail-fast-build-integrity-2026-06-19), whichever the deploy-gate owner lands.
 * The only step that touches the contested `green-checkpoint.ts` gate file — adding an
 * optional `CheckpointDeps.perfGate` and the post-runGreen/pre-advance call site — is
 * intentionally NOT in this module; it is the owner-arming + anti-collision-gated last
 * mile. This file is the buildable substrate, dead-code-until-wired (like perf-budgets.ts
 * before its panel wiring).
 */

import {
  evaluatePerfSignals,
  readLatestPerfSignals,
  PERF_BUDGETS,
  type PerfVerdict,
  type PerfSignalsV1,
  type PerfBudgets,
} from '@papercusp/operator-core/lib/system-health/perf-budgets';

/** What the gate tells the green-checkpoint to do with a candidate. */
export type PerfGateAction = 'pass' | 'warn' | 'block';

export interface PerfGatePolicy {
  /** Master switch. When false the gate is a no-op (`pass`) and reads no signals.
   *  Default-OFF — perf gating is opt-in until the budgets are trusted. */
  enabled: boolean;
  /** Owner-armed block-mode. When false a definitive wedge (crit) only `warn`s and the
   *  deploy still advances; when true a crit `block`s it. Default-OFF per the plan's
   *  "default = FLAG (warn), not block". A non-crit (warn) verdict NEVER blocks even when
   *  armed — block is reserved for the definitive per-thread-wedge crits. */
  block: boolean;
}

export interface PerfGateDecision {
  action: PerfGateAction;
  /** The verdict's human reasons (the alarm copy) for the worst tier reached. */
  reasons: string[];
  /** One-line, deploy-context summary for the broadcast / escalation. */
  summary: string;
  /** The underlying perf verdict tier (ok | warn | crit | unknown) for logging. */
  verdictStatus: PerfVerdict['status'];
}

/** Read the gate policy from the environment.
 *  - `PAPERCUSP_PERF_GATE=1`        → enable the gate (default off).
 *  - `PAPERCUSP_PERF_GATE_BLOCK=1`  → arm block-mode (default warn-only). Owner-set. */
export function perfGatePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PerfGatePolicy {
  return {
    enabled: env.PAPERCUSP_PERF_GATE === '1',
    block: env.PAPERCUSP_PERF_GATE_BLOCK === '1',
  };
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

/**
 * PURE: map a perf verdict + policy to a deploy-gate action. No IO.
 *
 * Decision table (action by verdict tier):
 *   disabled                      → pass   (no-op; the gate is opt-in)
 *   ok | unknown(stale/no-data)   → pass   (fail-soft: never block on missing/benign data)
 *   warn (hot-but-not-fatal)      → warn   (surface, never block — even when armed)
 *   crit (definitive wedge)       → block IFF policy.block else warn
 */
export function evaluatePerfGate(
  verdict: PerfVerdict,
  policy: PerfGatePolicy,
  candidateSha?: string,
): PerfGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return {
      action: 'pass',
      reasons: [],
      summary: `perf-gate disabled — ${sha} not perf-checked`,
      verdictStatus: verdict.status,
    };
  }

  if (verdict.status === 'ok' || verdict.status === 'unknown') {
    const why = verdict.status === 'unknown' ? 'no fresh perf signal (fail-soft)' : 'operator perf ok';
    return {
      action: 'pass',
      reasons: [],
      summary: `perf-gate: ${why} — ${sha} clears`,
      verdictStatus: verdict.status,
    };
  }

  if (verdict.status === 'crit') {
    const action: PerfGateAction = policy.block ? 'block' : 'warn';
    const verb = action === 'block' ? 'BLOCKED (block-mode armed)' : 'flagged (warn — block-mode not armed)';
    return {
      action,
      reasons: verdict.reasons,
      summary: `🟥 perf-gate: operator DEGRADED — deploy of ${sha} ${verb}: ${verdict.reasons.join('; ')}`,
      verdictStatus: 'crit',
    };
  }

  // 'warn' — hot but not a definitive wedge: surface only, never block.
  return {
    action: 'warn',
    reasons: verdict.reasons,
    summary: `🟧 perf-gate: operator hot — deploy of ${sha} flagged: ${verdict.reasons.join('; ')}`,
    verdictStatus: 'warn',
  };
}

/** IO seam for `runPerfGate` (injected as fakes in tests). */
export interface PerfGateIO {
  readSignals: () => Promise<PerfSignalsV1 | null>;
  now: () => number;
}

const defaultPerfGateIO: PerfGateIO = {
  readSignals: () => readLatestPerfSignals(),
  now: () => Date.now(),
};

/**
 * Read the latest perf-signals-v1 capture, evaluate it against the budgets, and apply the
 * gate policy → a {@link PerfGateDecision}. Fail-soft end-to-end: when disabled it reads
 * NOTHING and passes; a read error / missing capture degrades to `unknown` → `pass`. The
 * green-checkpoint wiring calls this post-`runGreen`/pre-`advance` and, on `block`, holds
 * the advance; on `warn`/`block` it broadcasts/escalates `decision.summary`.
 */
export async function runPerfGate(
  policy: PerfGatePolicy,
  candidateSha?: string,
  io: PerfGateIO = defaultPerfGateIO,
  budgets: PerfBudgets = PERF_BUDGETS,
): Promise<PerfGateDecision> {
  if (!policy.enabled) {
    // Skip IO entirely when off — the decision is `pass` regardless of any signal.
    return evaluatePerfGate(evaluatePerfSignals(null, io.now(), budgets), policy, candidateSha);
  }
  const signals = await io.readSignals().catch(() => null);
  const verdict = evaluatePerfSignals(signals, io.now(), budgets);
  return evaluatePerfGate(verdict, policy, candidateSha);
}
