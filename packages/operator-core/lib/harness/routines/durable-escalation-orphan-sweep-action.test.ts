/**
 * WI-1741477 — the durable-escalation orphan detector's caller.
 *
 * Two distinct things are under test, and they fail in different ways:
 *  1. BEHAVIOUR — a scan that measured NOTHING must never be reported as clean.
 *  2. WIRING — the five-part registration. A system action is only alive if the handler is
 *     registered, imported, spend-classified, seeded, and covered by the seeds guard; the
 *     tree stays green with any one of those missing, which is exactly how the parent
 *     detector came to exist with no caller at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_ROLE_SPEND } from '../../automation/routine-classification';
import type { EmitterFinding, ScanReport } from '../../durable-escalation-orphan-scan';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';
import { getSystemAction, getSystemActionEntry } from './system-actions';
import {
  DURABLE_ESCALATION_ORPHAN_SWEEP,
  durableEscalationOrphanWatchdogKey,
  durableEscalationScanBlindWatchdogKey,
  makeDurableEscalationOrphanSweepAction,
  renderDurableEscalationOrphanBody,
} from './durable-escalation-orphan-sweep-action';

const HERE = dirname(fileURLToPath(import.meta.url));

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
};

function finding(over: Partial<EmitterFinding> = {}): EmitterFinding {
  return {
    emitter: 'system:resource-governor',
    verdict: 'orphan-suspect',
    closedCount: 87_897,
    openCount: 1_816,
    p95CloseHours: 0,
    thresholdHours: 1,
    anomalousOpen: [
      { id: 'WI-1446337', ageHours: 38.31 },
      { id: 'WI-1446338', ageHours: 12.5 },
    ],
    incoherentClosedCount: 0,
    why: 'closes essentially instantly 87,897 times, yet 1,816 rows stand open',
    ...over,
  };
}

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    findings: [finding()],
    emittersWithNoOpenRows: [],
    rowsScanned: 40_000,
    emittersScanned: 12,
    ...over,
  };
}

function harness(overrides: Parameters<typeof makeDurableEscalationOrphanSweepAction>[0] = {}) {
  const file = vi.fn(async () => ({ filed: true }));
  const fileScanBlind = vi.fn(async () => ({ filed: true }));
  const log = vi.fn();
  const action = makeDurableEscalationOrphanSweepAction({ file, fileScanBlind, log, ...overrides });
  return { action, file, fileScanBlind, log };
}

describe('durable-escalation orphan sweep action — a blind scan is not a clean one', () => {
  it('rowsScanned:0 files the BLIND report and never the findings report', async () => {
    const h = harness({ run: async () => report({ findings: [], rowsScanned: 0, emittersScanned: 0 }) });
    await h.action(ctx);
    expect(h.fileScanBlind).toHaveBeenCalledTimes(1);
    // The failure this guards: zero rows and zero findings look identical in `findings`
    // alone, so routing a blind scan into the ordinary path reports "nothing wrong".
    expect(h.file).not.toHaveBeenCalled();
    expect(h.log.mock.calls[0][0]).toMatch(/BLIND, not clean/);
  });

  it('CONTRAST: a real scan with nothing actionable files NOTHING and is not called blind', async () => {
    const h = harness({ run: async () => report({ findings: [], rowsScanned: 40_000 }) });
    await h.action(ctx);
    expect(h.fileScanBlind).not.toHaveBeenCalled();
    // `file` is still invoked; productionFile itself no-ops on an empty finding set.
    expect(h.file).toHaveBeenCalledTimes(1);
    expect(h.file.mock.calls[0][0].findings).toEqual([]);
  });

  it('passes actionable findings through, dropping within-own-norm', async () => {
    const h = harness({
      run: async () =>
        report({
          findings: [finding(), finding({ emitter: 'system:healthy', verdict: 'within-own-norm' })],
        }),
    });
    await h.action(ctx);
    const passed = h.file.mock.calls[0][0].findings;
    expect(passed).toHaveLength(1);
    expect(passed[0].emitter).toBe('system:resource-governor');
  });

  it('the two watchdog keys are distinct, so a blind scan can never dedup against a findings report', () => {
    expect(durableEscalationOrphanWatchdogKey('ws')).not.toBe(durableEscalationScanBlindWatchdogKey('ws'));
  });

  it('the rendered body states the undetermined verdicts and forbids blanket-closing', () => {
    const body = renderDurableEscalationOrphanBody(report(), [
      finding({ verdict: 'insufficient-close-sample' }),
    ]);
    expect(body).toMatch(/never read this as clean/i);
    expect(body).toMatch(/Do not blanket-close/i);
    // rowsScanned must appear: "scanned 40,000 and found nothing" vs "scanned nothing".
    expect(body).toMatch(/40000|40,000/);
  });

  it('⛔ exposes NO auto-close path — silence means recovered OR unobserved, and only one justifies closing', () => {
    const src = readFileSync(path.join(HERE, 'durable-escalation-orphan-sweep-action.ts'), 'utf8');
    // A close would have to reach one of these; none may appear outside prose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/work_items:complete|setState|closed_ts|UPDATE\s+harness_shared/i);
  });
});

describe('WI-1741477 wiring — all five parts, because four leave a silent instrument', () => {
  it('1. the handler is registered under its system: name', () => {
    expect(getSystemAction(DURABLE_ESCALATION_ORPHAN_SWEEP)).toBeTypeOf('function');
  });

  it("2. it is declared 'standing', so a missing routine row is REPORTED, not tolerated", () => {
    // 'on-demand' would exempt it from validateActiveRoutines' unscheduledSystemActions
    // check — i.e. it would be allowed to have no row and never fire, which is the defect.
    expect(getSystemActionEntry(DURABLE_ESCALATION_ORPHAN_SWEEP)?.scheduling).toBe('standing');
  });

  it('3. it is spend-classified (omitting this reds the fleet gate hours later)', () => {
    const entry = TARGET_ROLE_SPEND[`system:${DURABLE_ESCALATION_ORPHAN_SWEEP}`];
    expect(entry).toBeDefined();
    expect(entry.spend).toBe('none');
    expect(entry.why).toBeTruthy();
  });

  it('4+5. a seed script exists AND the seeds guard covers it', () => {
    const seed = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === DURABLE_ESCALATION_ORPHAN_SWEEP);
    expect(seed).toBeDefined();
    expect(seed!.seedScript).toBe('seed-durable-escalation-orphan-sweep-routine.ts');
    // The guard entry is worthless if it names a script that is not there.
    expect(() => readFileSync(path.join(HERE, seed!.seedScript), 'utf8')).not.toThrow();
  });

  it('the side-effect import is present in register-system-actions.ts', () => {
    const src = readFileSync(path.join(HERE, 'register-system-actions.ts'), 'utf8');
    expect(src).toMatch(/import '\.\/durable-escalation-orphan-sweep-action';/);
  });
});
