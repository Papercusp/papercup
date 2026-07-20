/**
 * Desktop-perf release gate (desktop-performance-suite-2026-07-20 P-011).
 *
 * The DESKTOP-UI sibling of perf-gate.ts. A PURE policy layer that turns the
 * latest persisted desktop-perf run (harness_shared.desktop_perf_runs, P-010)
 * into a green-checkpoint action: `pass`, `warn` (surface it, still advance the
 * green pin), or `block` (hold the deploy).
 *
 * Two load-bearing rules, mirrored from perf-gate.ts:
 *   - DEFAULT-WARN until the desktop budgets are trusted. A regressed run only
 *     `block`s when block-mode is armed; otherwise the worst it does is `warn`
 *     (log + broadcast) and let the green commit advance.
 *   - FLAG-GATED + FAIL-SOFT. This is the P-011 improvement over perf-gate.ts's
 *     env gate: the enable switch is a FLAGS entry (FLAGS.DESKTOP_PERF_GATE, a
 *     server getFlag read), NOT a process.env boolean. Disabled ⇒ a no-op `pass`
 *     that reads nothing; a missing / empty run (verdict `unknown`) never blocks.
 *
 * Block-mode is deliberately NOT shipped in V1 ("warn-not-block until trusted"):
 * `desktopPerfGatePolicyFromFlags` returns block:false. `evaluateDesktopPerfGate`
 * still honors a block:true policy (parity with perf-gate + a clean seam for the
 * future owner-armed step), but nothing sets it yet.
 *
 * Like perf-gate.ts, the green-checkpoint CALL SITE lives in green-checkpoint.ts
 * (CheckpointDeps.desktopPerfGate + realCheckpointDeps), not here — this file is
 * the buildable, framework-agnostic substrate.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  readDesktopPerfRuns,
  type DesktopPerfRun,
  type DesktopPerfMeasure,
} from '@papercusp/operator-core/lib/system-health/desktop-perf-runs';

/** What the gate tells the green-checkpoint to do with a candidate. */
export type DesktopPerfGateAction = 'pass' | 'warn' | 'block';
export type DesktopPerfVerdictStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface DesktopPerfGatePolicy {
  /** Master switch. When false the gate is a no-op (`pass`) and reads no run.
   *  Sourced from FLAGS.DESKTOP_PERF_GATE (default ON — warn-only is safe). */
  enabled: boolean;
  /** Owner-armed block-mode. When false a definitive regression (crit) only
   *  `warn`s and the deploy still advances; when true it `block`s. Default-OFF
   *  per "warn-not-block until trusted" — not armed by any shipped switch in V1. */
  block: boolean;
}

export interface DesktopPerfGateDecision {
  action: DesktopPerfGateAction;
  /** Human reasons (the failing measures) for the broadcast / escalation. */
  reasons: string[];
  /** One-line, deploy-context summary. */
  summary: string;
  verdictStatus: DesktopPerfVerdictStatus;
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

function fmtMeasure(m: DesktopPerfMeasure): string {
  const v = m.unit === 'kb' ? `${Math.round(m.value / 1024)}MB` : m.unit === 'count' ? `${m.value}` : `${Math.round(m.value)}ms`;
  const b = m.budget === null ? '' : m.unit === 'kb' ? `${Math.round(m.budget / 1024)}MB` : m.unit === 'count' ? `${m.budget}` : `${Math.round(m.budget)}ms`;
  return `${m.key} ${v} > budget ${b}`;
}

/** The budgeted measures that missed their budget — the definitive regressions. */
export function failingMeasures(run: DesktopPerfRun): DesktopPerfMeasure[] {
  return run.measures.filter((m) => m.budget !== null && !m.ok);
}

/**
 * PURE: map the latest desktop-perf run + policy to a deploy-gate action. No IO.
 *
 * Decision table (action by verdict tier):
 *   disabled                         → pass  (no-op; the gate is opt-in via the flag)
 *   no run / no measures (unknown)   → pass  (fail-soft: never block on missing data)
 *   ok (all budgeted measures met)   → pass
 *   warn (suite warned, no breach)   → warn  (surface, never block — even when armed)
 *   crit (a budgeted measure breach) → block IFF policy.block else warn
 */
export function evaluateDesktopPerfGate(
  run: DesktopPerfRun | null,
  policy: DesktopPerfGatePolicy,
  candidateSha?: string,
): DesktopPerfGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return { action: 'pass', reasons: [], summary: `desktop-perf-gate disabled — ${sha} not perf-checked`, verdictStatus: 'unknown' };
  }

  if (!run || run.measures.length === 0) {
    return { action: 'pass', reasons: [], summary: `desktop-perf-gate: no fresh desktop-perf run (fail-soft) — ${sha} clears`, verdictStatus: 'unknown' };
  }

  const failing = failingMeasures(run);
  if (failing.length > 0) {
    const action: DesktopPerfGateAction = policy.block ? 'block' : 'warn';
    const verb = action === 'block' ? 'BLOCKED (block-mode armed)' : 'flagged (warn — block-mode not armed)';
    const reasons = failing.map(fmtMeasure);
    return {
      action,
      reasons,
      summary: `🟥 desktop-perf-gate: desktop interaction REGRESSED — deploy of ${sha} ${verb}: ${reasons.join('; ')}`,
      verdictStatus: 'crit',
    };
  }

  if (run.status === 'warn') {
    return {
      action: 'warn',
      reasons: ['desktop-perf suite reported a warning (no budgeted breach)'],
      summary: `🟧 desktop-perf-gate: desktop-perf run warned — deploy of ${sha} flagged`,
      verdictStatus: 'warn',
    };
  }

  return { action: 'pass', reasons: [], summary: `desktop-perf-gate: desktop-perf ok — ${sha} clears`, verdictStatus: 'ok' };
}

/** Read the gate policy from the FLAGS system (default ON, warn-only). */
export async function desktopPerfGatePolicyFromFlags(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.DESKTOP_PERF_GATE, 'system'),
): Promise<DesktopPerfGatePolicy> {
  return {
    enabled: await readFlag().catch(() => false),
    // V1: warn-not-block until trusted. Arming block-mode is a future owner-gated step.
    block: false,
  };
}

/** IO seam for {@link runDesktopPerfGate} (injected as fakes in tests). */
export interface DesktopPerfGateIO {
  readLatestRun: (workspaceId: string) => Promise<DesktopPerfRun | null>;
}

const defaultDesktopPerfGateIO: DesktopPerfGateIO = {
  readLatestRun: async (workspaceId) => (await readDesktopPerfRuns(workspaceId, 1))[0] ?? null,
};

/**
 * Read the latest persisted desktop-perf run for the workspace, evaluate it, and
 * apply the gate policy → a {@link DesktopPerfGateDecision}. Fail-soft end-to-end:
 * disabled ⇒ reads NOTHING and passes; a read error / missing run degrades to
 * `unknown` → `pass`. The green-checkpoint wiring calls this post-`runGreen` /
 * pre-`advance` and, on `block`, holds the advance; on `warn`/`block` it
 * broadcasts/escalates `decision.summary`.
 */
export async function runDesktopPerfGate(
  policy: DesktopPerfGatePolicy,
  opts: { workspaceId?: string; candidateSha?: string; io?: DesktopPerfGateIO } = {},
): Promise<DesktopPerfGateDecision> {
  const candidateSha = opts.candidateSha;
  if (!policy.enabled) {
    return evaluateDesktopPerfGate(null, policy, candidateSha);
  }
  const workspaceId = opts.workspaceId ?? process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
  const io = opts.io ?? defaultDesktopPerfGateIO;
  const run = await io.readLatestRun(workspaceId).catch(() => null);
  return evaluateDesktopPerfGate(run, policy, candidateSha);
}
