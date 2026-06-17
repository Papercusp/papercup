/**
 * Unit tests for the autonomy trust sweep orchestration (B-16 / P-080-082).
 * Drives the whole sweep + graduation legs with fake deps.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AutonomyCategory } from '../categories';
import type { AutonomyCategoryPolicy } from '../policy';
import type { AutonomyCeiling } from '@papercusp/plan-parser';
import {
  runAutonomyTrustScan,
  runAutonomyTripwireSweep,
  runAutonomyGraduationLeg,
  armTripwireForDecision,
  DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS,
  type AutonomyTrustScanDeps,
  type NotifyInput,
} from './scan';
import type { TripwireSignalKind, TripwireWatchSignal } from './core';
import type { TripwireRow } from './store';
import type { AutonomyDecision } from '../decider';

const OPTS = DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS;
const HOUR = 3_600_000;

function row(over: Partial<TripwireRow> & { status: TripwireRow['status']; armedAtMs: number }): TripwireRow {
  return {
    id: `tw-${over.armedAtMs}`,
    workspaceId: 'default',
    category: 'implementation',
    findingClass: 'work_items:create',
    action: 'work_items:create',
    riskTier: 'low',
    reversibility: 'reversible',
    revertHandle: { kind: 'config-edit' },
    decision: null,
    decisionId: null,
    tripReason: null,
    windowUntilMs: over.armedAtMs + 24 * HOUR,
    resolvedAtMs: over.status === 'armed' ? null : over.armedAtMs + 24 * HOUR,
    revertedAtMs: null,
    resolvedBy: over.status === 'armed' ? null : 'sweep',
    ...over,
  };
}

function policy(over: Partial<AutonomyCategoryPolicy> & { category: AutonomyCategory }): AutonomyCategoryPolicy {
  return { ceiling: 'never-auto', locked: false, graduatedLevel: 'never-auto', thresholdOverrides: {}, ownerOverride: null, ...over };
}

interface FakeConfig {
  armed?: boolean;
  armedRows?: TripwireRow[];
  signals?: TripwireWatchSignal[];
  evidence?: TripwireRow[];
  policies?: Map<AutonomyCategory, AutonomyCategoryPolicy>;
  revertOk?: boolean;
  nowMs?: number;
}

function makeDeps(cfg: FakeConfig) {
  const calls = {
    cleared: [] as string[],
    tripped: [] as { id: string; reason: TripwireSignalKind }[],
    reverted: [] as string[],
    reverts: [] as string[],
    writes: [] as { cat: AutonomyCategory; level: AutonomyCeiling }[],
    notifies: [] as NotifyInput[],
  };
  const deps: AutonomyTrustScanDeps = {
    isArmed: async () => cfg.armed ?? true,
    listArmed: async () => cfg.armedRows ?? [],
    gatherSignals: async () => ({ signals: cfg.signals ?? [], legs: { gym: true, ekg: true, validator: false } }),
    executeRevert: async (r) => {
      calls.reverts.push(r.id);
      return { reverted: cfg.revertOk ?? false, note: 'test' };
    },
    markCleared: async (id) => void calls.cleared.push(id),
    markTripped: async (id, reason) => void calls.tripped.push({ id, reason }),
    markReverted: async (id) => void calls.reverted.push(id),
    readEvidence: async () => cfg.evidence ?? [],
    readPolicy: async (cat) => cfg.policies?.get(cat) ?? policy({ category: cat }),
    writeGraduatedLevel: async (cat, level) => void calls.writes.push({ cat, level }),
    notify: async (input) => {
      calls.notifies.push(input);
      return true;
    },
    nowMs: () => cfg.nowMs ?? 1e15,
  };
  return { deps, calls };
}

describe('runAutonomyTrustScan arming gate', () => {
  it('no-ops when not armed (P-092 / D-007 behavior-neutral)', async () => {
    const { deps } = makeDeps({ armed: false });
    const out = await runAutonomyTrustScan(deps, OPTS);
    expect(out).toEqual({ ran: false, skipReason: 'not-armed' });
  });

  it('runs both legs when armed', async () => {
    const { deps } = makeDeps({ armed: true });
    const out = await runAutonomyTrustScan(deps, OPTS);
    expect(out.ran).toBe(true);
    expect(out.sweep).toBeDefined();
    expect(out.graduation).toBeDefined();
  });
});

describe('runAutonomyTripwireSweep', () => {
  it('trips on an in-window signal: marks tripped, reverts, demotes, notifies', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const signals: TripwireWatchSignal[] = [{ kind: 'gym-regression', atMs: 1000 + 2 * HOUR, label: 'regressed', global: true }];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })]]);
    const { deps, calls } = makeDeps({ armedRows, signals, policies, revertOk: true });
    const res = await runAutonomyTripwireSweep(deps, OPTS);

    expect(res.tripped).toBe(1);
    expect(res.cleared).toBe(0);
    expect(res.reverted).toBe(1);
    expect(calls.tripped).toEqual([{ id: 'tw-1000', reason: 'gym-regression' }]);
    expect(calls.reverts).toEqual(['tw-1000']);
    expect(calls.reverted).toEqual(['tw-1000']);
    expect(calls.writes).toEqual([{ cat: 'implementation', level: 'trivial' }]); // low → trivial
    expect(calls.notifies[0]!.kind).toBe('tripped');
    expect(res.demotions[0]).toMatchObject({ category: 'implementation', from: 'low', to: 'trivial', reverted: true });
  });

  it('clears an armed row whose window closed clean (no demotion)', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const { deps, calls } = makeDeps({ armedRows, signals: [], nowMs: 1000 + 48 * HOUR });
    const res = await runAutonomyTripwireSweep(deps, OPTS);
    expect(res.cleared).toBe(1);
    expect(res.tripped).toBe(0);
    expect(calls.cleared).toEqual(['tw-1000']);
    expect(calls.writes).toEqual([]);
  });

  it('does not demote a locked category on a trip', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000, category: 'release-deploy', findingClass: 'deploy:run' })];
    const signals: TripwireWatchSignal[] = [{ kind: 'ekg-drift', atMs: 1000 + HOUR, label: 'x', global: true }];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([['release-deploy', policy({ category: 'release-deploy', ceiling: 'high', graduatedLevel: 'low', locked: true })]]);
    const { deps, calls } = makeDeps({ armedRows, signals, policies });
    await runAutonomyTripwireSweep(deps, OPTS);
    expect(calls.writes).toEqual([]); // locked → no demotion write
  });

  it('DOES demote a PINNED category on a trip — a ceiling pin freezes the raise, not the safety demote (EI-513 / D-003)', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const signals: TripwireWatchSignal[] = [{ kind: 'gym-regression', atMs: 1000 + HOUR, label: 'x', global: true }];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low', ownerOverride: { pinned: true } })],
    ]);
    const { deps, calls } = makeDeps({ armedRows, signals, policies, revertOk: true });
    const res = await runAutonomyTripwireSweep(deps, OPTS);
    expect(res.tripped).toBe(1);
    expect(calls.writes).toEqual([{ cat: 'implementation', level: 'trivial' }]); // pinned → safety demote STILL applied (low → trivial)
    expect(res.demotions[0]).toMatchObject({ category: 'implementation', from: 'low', to: 'trivial' });
    expect(calls.notifies[0]!.body).toMatch(/safety demote still applied/);
  });

  it('mineOnly mutates nothing', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const signals: TripwireWatchSignal[] = [{ kind: 'gym-regression', atMs: 1000 + HOUR, label: 'x', global: true }];
    const { deps, calls } = makeDeps({ armedRows, signals });
    const res = await runAutonomyTripwireSweep(deps, { ...OPTS, mineOnly: true });
    expect(res.tripped).toBe(1);
    expect(calls.tripped).toEqual([]);
    expect(calls.writes).toEqual([]);
    expect(calls.notifies).toEqual([]);
  });

  // Gap 6: a trip records + demotes + notifies EVEN WHEN the auto-revert fails or
  // is unwired. The revert is best-effort; the safety (demote + alert) must never
  // hinge on it (P-081 / D-006).
  it('still records + demotes + notifies when executeRevert THROWS (revert is best-effort)', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const signals: TripwireWatchSignal[] = [{ kind: 'gym-regression', atMs: 1000 + HOUR, label: 'boom', global: true }];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })],
    ]);
    const { deps, calls } = makeDeps({ armedRows, signals, policies });
    // Override executeRevert to THROW — the executor blew up. The sweep catches it
    // and console.warns; mock the warn out (expected) and assert it fired.
    deps.executeRevert = async () => {
      throw new Error('revert executor exploded');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runAutonomyTripwireSweep(deps, OPTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('revert FAILED'), expect.anything());
    warn.mockRestore();

    expect(res.tripped).toBe(1);
    expect(calls.tripped).toEqual([{ id: 'tw-1000', reason: 'gym-regression' }]); // markTripped DID fire
    expect(calls.writes).toEqual([{ cat: 'implementation', level: 'trivial' }]); // one-step demote STILL written (low → trivial)
    expect(res.reverted).toBe(0); // throw ⇒ never counted reverted
    expect(calls.reverted).toEqual([]); // markReverted never called
    expect(res.demotions[0]).toMatchObject({ category: 'implementation', from: 'low', to: 'trivial', reverted: false });
    expect(calls.notifies).toHaveLength(1);
    expect(calls.notifies[0]!.kind).toBe('tripped');
    expect(calls.notifies[0]!.body).toMatch(/NOT executed|manual revert/);
  });

  it('records + demotes + notifies when executeRevert returns { reverted:false } (no executor wired)', async () => {
    const armedRows = [row({ status: 'armed', armedAtMs: 1000 })];
    const signals: TripwireWatchSignal[] = [{ kind: 'ekg-drift', atMs: 1000 + HOUR, label: 'drift', global: true }];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })],
    ]);
    // revertOk defaults to false (the shared fake returns { reverted:false }).
    const { deps, calls } = makeDeps({ armedRows, signals, policies });
    const res = await runAutonomyTripwireSweep(deps, OPTS);

    expect(res.tripped).toBe(1);
    expect(calls.tripped).toEqual([{ id: 'tw-1000', reason: 'ekg-drift' }]);
    expect(calls.reverts).toEqual(['tw-1000']); // executor WAS invoked
    expect(res.reverted).toBe(0); // but reverted:false ⇒ no revert counted
    expect(calls.reverted).toEqual([]); // markReverted never called
    expect(calls.writes).toEqual([{ cat: 'implementation', level: 'trivial' }]); // demote still applied
    expect(res.demotions[0]).toMatchObject({ reverted: false });
    expect(calls.notifies[0]!.body).toMatch(/NOT executed|manual revert/);
  });

  // Gap 7: aggregation across MULTIPLE armed rows in ONE sweep — the for-loop's
  // cleared/tripped/reverted tallies + demotions[] are only single-row-tested.
  it('aggregates across 3 armed rows: one trips, one clears, one stays armed', async () => {
    const nowMs = 1_000_000;
    const tripRow = row({ id: 'tw-trip', status: 'armed', armedAtMs: nowMs - 4 * HOUR, category: 'implementation', findingClass: 'work_items:create' });
    // window already closed clean (no matching signal in window) → clears
    const clearRow = row({ id: 'tw-clear', status: 'armed', armedAtMs: nowMs - 48 * HOUR, category: 'review-merge', findingClass: 'review:approve' });
    clearRow.windowUntilMs = nowMs - 24 * HOUR; // closed before now
    // window still open, no signal → stays armed
    const openRow = row({ id: 'tw-open', status: 'armed', armedAtMs: nowMs - 1 * HOUR, category: 'inbox-triage', findingClass: 'inbox:tier' });
    openRow.windowUntilMs = nowMs + 24 * HOUR;

    // A single in-window signal scoped to the trip row only.
    const signals: TripwireWatchSignal[] = [
      { kind: 'gym-regression', atMs: nowMs - 3 * HOUR, label: 'regress', tripwireId: 'tw-trip' },
    ];
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })],
    ]);
    const { deps, calls } = makeDeps({ armedRows: [tripRow, clearRow, openRow], signals, policies, revertOk: true, nowMs });
    const res = await runAutonomyTripwireSweep(deps, OPTS);

    expect(res).toMatchObject({ armed: 3, tripped: 1, cleared: 1, reverted: 1 });
    expect(calls.cleared).toEqual(['tw-clear']);
    expect(calls.tripped).toEqual([{ id: 'tw-trip', reason: 'gym-regression' }]);
    expect(res.demotions).toHaveLength(1);
    expect(res.demotions[0]).toMatchObject({ category: 'implementation', from: 'low', to: 'trivial', reverted: true });
  });
});

describe('runAutonomyGraduationLeg', () => {
  it('raises graduated_level within the ceiling and files a report', async () => {
    const evidence = Array.from({ length: 10 }, (_, i) =>
      row({ id: `e-${i}`, status: 'cleared', armedAtMs: 1000 + i * 1000 }),
    );
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>([['implementation', policy({ category: 'implementation', ceiling: 'low' })]]);
    const { deps, calls } = makeDeps({ evidence, policies });
    const res = await runAutonomyGraduationLeg(deps, OPTS);
    expect(calls.writes).toEqual([{ cat: 'implementation', level: 'trivial' }]);
    expect(res.eligible).toEqual(['implementation::work_items:create']);
    expect(calls.notifies[0]!.kind).toBe('graduation-eligible');
    expect(res.filed).toHaveLength(1);
  });

  // Gap 5: the maxReportsPerTick cap on filed graduation reports. With 5 eligible
  // (category, class) standings and a cap of 2, exactly 2 reports are filed — the
  // eligible.slice(0, maxReportsPerTick) bound (scan.ts:277).
  it('caps filed graduation reports at maxReportsPerTick (5 eligible → 2 filed)', async () => {
    // 5 distinct non-protected (category, class) tiers, each with a 10-deep clean
    // streak (threshold=10) so every one is graduation-eligible. None of the
    // composite keys contain a never-graduate substring (deploy/auth/budget/flag/…).
    const tiers: { category: AutonomyCategory; findingClass: string }[] = [
      { category: 'inbox-triage', findingClass: 'inbox:tier' },
      { category: 'escalations', findingClass: 'escalations:resolve' },
      { category: 'work-prioritization', findingClass: 'work_items:set_priority' },
      { category: 'ideation-intake', findingClass: 'scout:grade-idea' },
      { category: 'review-merge', findingClass: 'review:approve' },
    ];
    const evidence: TripwireRow[] = [];
    for (const t of tiers) {
      for (let i = 0; i < 10; i++) {
        evidence.push(
          row({ id: `${t.category}-${i}`, status: 'cleared', armedAtMs: 1000 + i * 1000, category: t.category, findingClass: t.findingClass }),
        );
      }
    }
    // ceiling high so the raises are real writes (uncapped) — only REPORTS are capped.
    const policies = new Map<AutonomyCategory, AutonomyCategoryPolicy>(
      tiers.map((t) => [t.category, policy({ category: t.category, ceiling: 'high' })]),
    );
    const { deps, calls } = makeDeps({ evidence, policies });
    const res = await runAutonomyGraduationLeg(deps, { ...OPTS, maxReportsPerTick: 2 });

    expect(res.eligible).toHaveLength(5); // all 5 tiers eligible by streak
    expect(res.filed).toHaveLength(2); // but only 2 reports filed (the cap)
    const graduationNotifies = calls.notifies.filter((n) => n.kind === 'graduation-eligible');
    expect(graduationNotifies).toHaveLength(2); // notify called exactly twice
  });

  it('files no report and writes nothing when the ceiling is never-auto', async () => {
    const evidence = Array.from({ length: 30 }, (_, i) =>
      row({ id: `e-${i}`, status: 'cleared', armedAtMs: 1000 + i * 1000 }),
    );
    // ceiling never-auto → target never-auto → no write; class is still "eligible"
    // by streak but the write is the no-op (autonomy stays zero).
    const { deps, calls } = makeDeps({ evidence });
    await runAutonomyGraduationLeg(deps, OPTS);
    expect(calls.writes).toEqual([]);
  });
});

describe('armTripwireForDecision', () => {
  function decision(over: Partial<AutonomyDecision> = {}): AutonomyDecision {
    return {
      posture: 'auto',
      category: 'implementation',
      action: 'work_items:create',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'low',
      protected: false,
      armed: true,
      wouldAutoIfArmed: true,
      reasons: [],
      ...over,
    };
  }

  it('refuses without persisting when the decision is not an auto reversible one', async () => {
    const fakeSql = (() => {
      throw new Error('insert should not be called');
    }) as never;
    const res = await armTripwireForDecision(fakeSql, 'ws', { decision: decision({ posture: 'gated' }), revertHandle: { kind: 'x' } }, 1000);
    expect(res).toEqual({ armed: false, reason: expect.stringContaining('gated') });
  });
});
