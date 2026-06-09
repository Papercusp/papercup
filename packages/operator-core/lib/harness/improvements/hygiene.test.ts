/**
 * hygiene tests — the backlog hygiene sweep
 * (learning-system-audit-improvements-2026-06-09 P-014).
 */

import { describe, it, expect, vi } from 'vitest';
import { planHygieneSweep, runHygieneSweep, type HygieneSweepDeps } from './hygiene';
import type { ImprovementCandidate } from './policy';

const NOW = Date.parse('2026-06-09T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string; title: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    state: 'open',
    severity: 'minor',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...p,
  };
}

describe('planHygieneSweep — dup-close', () => {
  it('keeps the highest-severity (then newest) member and closes the rest', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'red test harness smoke fails on boot', severity: 'minor', createdAt: daysAgo(3) }),
        cand({ id: 'b', title: 'red test harness smoke fails on boot', severity: 'major', createdAt: daysAgo(2) }),
        cand({ id: 'c', title: 'harness smoke fails on boot red test', severity: 'minor', createdAt: daysAgo(1) }),
      ],
      { nowMs: NOW },
    );
    const dupCloses = actions.filter((a) => a.kind === 'dup-close');
    expect(dupCloses.map((a) => a.id).sort()).toEqual(['a', 'c']);
    expect(dupCloses.every((a) => a.keptId === 'b')).toBe(true);
  });

  it('never dup-closes keyless near-dups whose signatures differ (the template-title false-positive, live 2026-06-09)', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'Test failing repeatedly: libs/papercusp/packages/orchestrator/src/invoke.test.ts' }),
        cand({ id: 'b', title: 'Test failing repeatedly: libs/papercusp/packages/orchestrator/src/state.test.ts' }),
        cand({ id: 'c', title: 'Tool plans:set-status erroring repeatedly' }),
        cand({ id: 'd', title: 'Tool plans:set-plan-status erroring repeatedly' }),
      ],
      { nowMs: NOW },
    );
    expect(actions.filter((a) => a.kind === 'dup-close')).toHaveLength(0);
  });

  it('never merges across different watchdogKeys; merges within the same key', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'k1', title: 'Tool plans:set-status erroring repeatedly', watchdogKey: 'tool-error:plans:set-status' }),
        cand({ id: 'k2', title: 'Tool plans:set-plan-status erroring repeatedly', watchdogKey: 'tool-error:plans:set-plan-status' }),
        cand({ id: 's1', title: 'service down: papercup-staging-api', watchdogKey: 'service:papercup-staging-api' }),
        cand({ id: 's2', title: 'service down papercup staging api again', watchdogKey: 'service:papercup-staging-api' }),
      ],
      { nowMs: NOW },
    );
    const dup = actions.filter((a) => a.kind === 'dup-close');
    expect(dup.every((a) => a.id !== 'k1' && a.id !== 'k2')).toBe(true);
    expect(dup).toHaveLength(1);
    expect(['s1', 's2']).toContain(dup[0].id);
  });

  it('never closes a claimed member; singleton clusters are untouched', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'coord send flakes under load' }),
        cand({ id: 'b', title: 'coord send flakes under load', assignee: 'improvement-runner' }),
        cand({ id: 'solo', title: 'an entirely unrelated one-off friction' }),
      ],
      { nowMs: NOW },
    );
    // b is claimed → exempt. The cluster keeps one of {a,b}; only a is closeable
    // when it is not the kept member — with equal severity, newest wins, so the
    // keeper is whichever sorts first; the claimed b must never appear.
    expect(actions.every((a) => a.id !== 'b')).toBe(true);
    expect(actions.every((a) => a.id !== 'solo')).toBe(true);
  });
});

describe('planHygieneSweep — age-out', () => {
  it('ages out an unclaimed minor item past staleDays with a quiet signature', () => {
    const actions = planHygieneSweep(
      [cand({ id: 'old', title: 'docs page typo in lexicon overview', createdAt: daysAgo(45) })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('age-out');
    expect(actions[0].reason).toContain('45 days');
  });

  it('never ages out: young, major/critical, claimed, or recurring-signature items', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'young', title: 'fresh minor friction', createdAt: daysAgo(5) }),
        cand({ id: 'major', title: 'old but major friction', severity: 'major', createdAt: daysAgo(60) }),
        cand({ id: 'claimed', title: 'old claimed friction', assignee: 'x', createdAt: daysAgo(60) }),
        // recurring signature: two OPEN items share it
        cand({ id: 'rec1', title: 'memory search keeps timing out', createdAt: daysAgo(40) }),
        cand({ id: 'rec2', title: 'memory search keeps timing out', createdAt: daysAgo(35) }),
      ],
      { nowMs: NOW },
    );
    // rec1/rec2 form a dup CLUSTER (one may dup-close) but neither AGES out.
    expect(actions.filter((a) => a.kind === 'age-out')).toHaveLength(0);
  });

  it('respects maxActions across both action kinds', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      cand({ id: `s${i}`, title: `stale distinct friction number ${i} entirely unique words ${i}`, createdAt: daysAgo(50) }),
    );
    expect(planHygieneSweep(items, { nowMs: NOW, maxActions: 4 })).toHaveLength(4);
  });
});

describe('runHygieneSweep — persistence + dryRun', () => {
  const mkDeps = (items: ImprovementCandidate[]) => {
    const closed: string[] = [];
    const merged: Record<string, unknown>[] = [];
    const deps: HygieneSweepDeps = {
      readItems: vi.fn(async () => items),
      setIssueState: vi.fn(async (id) => {
        closed.push(id);
        return null;
      }),
      commentIssue: vi.fn(async () => null),
      mergeIssuePayload: vi.fn(async (_id, patch) => {
        merged.push(patch);
        return null;
      }),
    };
    return { deps, closed, merged };
  };

  it('dryRun plans without writing', async () => {
    const { deps, closed, merged } = mkDeps([
      cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) }),
    ]);
    const res = await runHygieneSweep({ nowMs: NOW, dryRun: true }, deps);
    expect(res.dryRun).toBe(true);
    expect(res.planned).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(merged).toHaveLength(0);
  });

  it('executes: closes with decidedReason + reject-route lifecycle', async () => {
    const { deps, closed, merged } = mkDeps([
      cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) }),
    ]);
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.agedOut).toBe(1);
    expect(closed).toEqual(['old']);
    expect(merged[0].decidedReason).toContain('aged out');
    const lc = merged[0].ideaLifecycle as Record<string, unknown>;
    expect(lc.state).toBe('triaged');
    expect(lc.triageDecision).toBe('reject');
  });
});
