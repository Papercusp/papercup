import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluatePrimaryCount,
  countBackgroundPrimaries,
  runSinglePrimaryCheck,
  _resetSinglePrimaryDebounce,
} from './single-primary-check';

describe('evaluatePrimaryCount (pure)', () => {
  it('exactly one → healthy', () => {
    expect(evaluatePrimaryCount(1)).toMatchObject({ ok: true, key: null });
  });
  it('zero → blocker (silent routine-engine death)', () => {
    expect(evaluatePrimaryCount(0)).toMatchObject({ ok: false, severity: 'blocker', key: 'no-primary' });
  });
  it('two → blocker (split-brain catastrophe)', () => {
    const v = evaluatePrimaryCount(2);
    expect(v).toMatchObject({ ok: false, severity: 'blocker', key: 'split-brain-primary' });
    expect(v.summary).toContain('split-brain');
  });
  it('three → still split-brain', () => {
    expect(evaluatePrimaryCount(3).key).toBe('split-brain-primary');
  });
});

describe('countBackgroundPrimaries', () => {
  it('reads the DISTINCT dbos-executor count from the injected sql', async () => {
    const sql = (async () => [{ n: 2 }]) as never;
    expect(await countBackgroundPrimaries(sql)).toBe(2);
  });
  it('defaults to 0 when the query returns nothing', async () => {
    const sql = (async () => []) as never;
    expect(await countBackgroundPrimaries(sql)).toBe(0);
  });
});

describe('runSinglePrimaryCheck (debounced)', () => {
  beforeEach(() => _resetSinglePrimaryDebounce());

  it('escalates once on 0 primaries, then debounces within the window', async () => {
    const calls: Array<{ severity: string; summary: string }> = [];
    const escalate = async (input: { severity: string; summary: string }) => { calls.push(input); };
    let now = 100 * 60_000;
    const deps = { count: async () => 0, escalate, now: () => now, debounceMs: 30 * 60_000 };

    const a = await runSinglePrimaryCheck('ws', deps);
    expect(a.fired).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].summary).toContain('[single-primary]');

    now += 5 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    expect(b.fired).toBe(false);
    expect(calls.length).toBe(1);

    now += 30 * 60_000;
    const c = await runSinglePrimaryCheck('ws', deps);
    expect(c.fired).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('does NOT escalate when exactly one primary is live', async () => {
    const calls: unknown[] = [];
    const r = await runSinglePrimaryCheck('ws', { count: async () => 1, escalate: async (i) => { calls.push(i); }, now: () => 1 });
    expect(r.fired).toBe(false);
    expect(r.verdict.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('escalates on split-brain (>1)', async () => {
    const calls: Array<{ summary: string }> = [];
    const r = await runSinglePrimaryCheck('ws', { count: async () => 2, escalate: async (i) => { calls.push(i); }, now: () => 1 });
    expect(r.fired).toBe(true);
    expect(calls[0].summary).toContain('split-brain');
  });
});
