/**
 * Recurrence guard: EVERY perf scenario that judges readers must judge them
 * against a DECLARED, SHARED deadline — and must record HOW LONG they took.
 *
 * THE DEFECT THIS EXISTS FOR (found 2026-08-17, WI-39359). Two earlier fixes —
 * the shared convergence deadline (EI-20581532536662596, plan `#D-014`) and the
 * budget/goalpost record (`#D-015`) — were applied to `scenarios/replication.ts`
 * and to the shared helpers, but NOT to `scenarios/churn.ts`, which kept the
 * pre-fix shape in three places:
 *
 *   for (const r of readers) await r.waitFor('caught-up', budget)   // serial
 *
 * `waitFor` resolves immediately for an already-fired event, so under that loop
 * a reader's deadline is a function of its POSITION IN THE ARRAY (budget, PLUS
 * all the time already spent on the readers ahead of it) rather than of the run.
 * And with no `convergenceBudget()` / `readerConverged()` call, churn's artifacts
 * carried `budgetMs: null` + `convergedMs: null` — a bare converged/not boolean
 * with no goalpost and no times.
 *
 * That is not a cosmetic gap. Those artifacts are the input to
 * `baselines/tier1.json`, the ONE p2p-perf surface that survives on a committed
 * path (`test-results/` is gitignored — see RELEASE-READINESS.md §2.1). The
 * baseline promoted at sha `b68598d386f6a7eb` therefore recorded
 * `churn.reconnect-storm 8/8 converged` with no deadline and no timing, which
 * cannot distinguish a 300ms rejoin from one that took the whole budget.
 *
 * WHY A SOURCE AUDIT AND NOT A BEHAVIOURAL TEST: the property is "no scenario
 * OPEN-CODES the wait" — a statement about the call sites, not about one run.
 * A behavioural test of the helper already exists (`await-all-child-event.test.ts`
 * proves the shared deadline is enforced); what it cannot see is a scenario that
 * never calls it. The two are complements: that file guards the mechanism, this
 * one guards its adoption.
 *
 * FALSIFIABILITY: the auditor is a pure function over source text, exercised
 * against permanent in-file CONTROLS — a deliberately-wrong pre-fix fixture that
 * must report all three violations, and a correct fixture that must report none.
 * No tree file is ever mutated (CLAUDE.md tier 1). A CALIBRATION case pins the
 * other direction: a scenario that forms no mesh must NOT be flagged, or the
 * rule would "pass" by firing on everything.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCENARIO_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));

export interface ScenarioAudit {
  file: string;
  /** The scenario judges readers, so the convergence rules apply to it. */
  declaresReaders: boolean;
  violations: string[];
}

/**
 * Audit ONE scenario source. Pure — takes text, returns findings — so the
 * controls below can feed it fixtures instead of mutating the tree.
 */
export function auditScenarioSource(file: string, src: string): ScenarioAudit {
  const declaresReaders = /\.expectReaders\s*\(/.test(src);
  const violations: string[] = [];
  if (declaresReaders) {
    if (!/\.convergenceBudget\s*\(/.test(src)) {
      violations.push(
        'declares expectReaders() but never convergenceBudget() — the artifact will carry ' +
          'budgetMs:null, a converged/not verdict with no goalpost',
      );
    }
    if (!/\.readerConverged\s*\(/.test(src)) {
      violations.push(
        'declares expectReaders() but never readerConverged() — the artifact will carry ' +
          'convergedMs:null, so a run that barely cleared the budget is indistinguishable ' +
          'from one that cleared it by 100x',
      );
    }
    if (/\.waitFor\s*\(\s*['"`]caught-up['"`]/.test(src)) {
      violations.push(
        "open-codes .waitFor('caught-up', …) instead of routing through awaitAllChildEvent() — " +
          "a per-reader budget makes the deadline a function of iteration order (EI-20581532536662596)",
      );
    }
  }
  return { file, declaresReaders, violations };
}

function auditTree(): ScenarioAudit[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => auditScenarioSource(f, readFileSync(join(SCENARIO_DIR, f), 'utf8')));
}

/** The pre-fix churn.ts shape, kept verbatim in spirit as a permanent control. */
const BROKEN_SERIAL_FIXTURE = `
  const budget = catchUpBudgetMs(size);
  meter.expectReaders(mesh.readers.length);
  for (const r of mesh.readers) {
    const ok = await r.waitFor('caught-up', budget);
    if (!ok) meter.readerDidNotConverge(r.cfg.peerIndex, 'never caught up');
  }
`;

/** The fixed shape: shared deadline, declared goalpost, recorded times. */
const FIXED_FIXTURE = `
  const budget = catchUpBudgetMs(size);
  meter.expectReaders(mesh.readers.length);
  meter.convergenceBudget(budget);
  for (const { reader, event, elapsedMs } of await awaitAllChildEvent(mesh.readers, 'caught-up', budget)) {
    if (event) meter.readerConverged(reader.cfg.peerIndex, elapsedMs);
    else meter.readerDidNotConverge(reader.cfg.peerIndex, 'never caught up');
  }
`;

/** A scenario that forms no mesh at all — the rules must NOT fire on it. */
const NO_MESH_FIXTURE = `
  const meter = new ScenarioMeter({ scenario: 'merge.idle-tick', tier: 1, params: {} });
  const tick = meter.metric('idleTickMs', 'ms');
  for (let i = 0; i < ticks; i++) tick.push(timeIt(() => merge(state)));
`;

describe('perf scenarios — convergence instrumentation', () => {
  it('CONTROL: the pre-fix serial shape is reported on all three counts', () => {
    const a = auditScenarioSource('control-broken.ts', BROKEN_SERIAL_FIXTURE);
    expect(a.declaresReaders).toBe(true);
    expect(a.violations).toHaveLength(3);
    expect(a.violations.join('\n')).toMatch(/convergenceBudget/);
    expect(a.violations.join('\n')).toMatch(/readerConverged/);
    expect(a.violations.join('\n')).toMatch(/awaitAllChildEvent/);
  });

  it('CONTROL: the fixed shape is reported clean', () => {
    expect(auditScenarioSource('control-fixed.ts', FIXED_FIXTURE)).toMatchObject({
      declaresReaders: true,
      violations: [],
    });
  });

  it('CALIBRATION: a scenario that forms no mesh is out of scope, not a violation', () => {
    const a = auditScenarioSource('control-no-mesh.ts', NO_MESH_FIXTURE);
    expect(a.declaresReaders).toBe(false);
    expect(a.violations).toEqual([]);
  });

  it('POSITIVE CONTROL: the audit actually reaches the scenario sources', () => {
    const audits = auditTree();
    // An empty or mis-globbed directory would make "no violations" vacuous.
    expect(audits.map((a) => a.file).sort()).toEqual(
      expect.arrayContaining(['churn.ts', 'replication.ts']),
    );
    expect(audits.filter((a) => a.declaresReaders).length).toBeGreaterThanOrEqual(2);
  });

  it('every reader-judging scenario declares a budget, records times, and shares one deadline', () => {
    const offenders = auditTree().filter((a) => a.violations.length > 0);
    expect(
      offenders.map((o) => `${o.file}:\n  - ${o.violations.join('\n  - ')}`).join('\n'),
    ).toBe('');
  });
});
