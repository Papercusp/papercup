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

describe('runSinglePrimaryCheck (hysteresis + debounce + self-clear)', () => {
  beforeEach(() => _resetSinglePrimaryDebounce());

  it('escalates only after a SUSTAINED 0 (hysteresis), then debounces within the window', async () => {
    const calls: Array<{ severity: string; summary: string }> = [];
    const escalate = async (input: { severity: string; summary: string }) => { calls.push(input); return { msg_id: 'esc-1' }; };
    let now = 100 * 60_000;
    const deps = { count: async () => 0, escalate, now: () => now, debounceMs: 30 * 60_000 };

    // 1st tick: streak 1 < 2 → no fire (a single transient blip is suppressed).
    const a = await runSinglePrimaryCheck('ws', deps);
    expect(a.fired).toBe(false);
    expect(calls.length).toBe(0);

    // 2nd consecutive tick: streak 2 → fire.
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    expect(b.fired).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].summary).toContain('[single-primary]');

    // within the debounce window → no re-fire.
    now += 5 * 60_000;
    const c = await runSinglePrimaryCheck('ws', deps);
    expect(c.fired).toBe(false);
    expect(calls.length).toBe(1);

    // after the debounce window → fire again.
    now += 30 * 60_000;
    const d = await runSinglePrimaryCheck('ws', deps);
    expect(d.fired).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('a single transient 0 then recovery NEVER reaches the owner (the false-positive class)', async () => {
    const calls: unknown[] = [];
    const escalate = async (i: unknown) => { calls.push(i); return { msg_id: 'x' }; };
    // one 0 sample (a bg-host reconnect/restart blip)…
    const a = await runSinglePrimaryCheck('ws', { count: async () => 0, escalate, now: () => 1 });
    expect(a.fired).toBe(false);
    // …then the next check is healthy again.
    const b = await runSinglePrimaryCheck('ws', { count: async () => 1, escalate, now: () => 2 });
    expect(b.fired).toBe(false);
    expect(calls.length).toBe(0); // the blip was absorbed by hysteresis
  });

  it('does NOT escalate when exactly one primary is live', async () => {
    const calls: unknown[] = [];
    const r = await runSinglePrimaryCheck('ws', { count: async () => 1, escalate: async (i) => { calls.push(i); }, now: () => 1 });
    expect(r.fired).toBe(false);
    expect(r.verdict.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('escalates on a SUSTAINED split-brain (>1)', async () => {
    const calls: Array<{ summary: string }> = [];
    const escalate = async (i: { summary: string }) => { calls.push(i); return { msg_id: 'sb-1' }; };
    let now = 0;
    const deps = { count: async () => 2, escalate, now: () => now };
    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false); // streak 1
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    expect(b.fired).toBe(true);
    expect(calls[0].summary).toContain('split-brain');
  });

  it('SELF-CLEARS its own escalation when the count returns to 1', async () => {
    const escalations: unknown[] = [];
    const resolves: Array<{ msg_id: string; choice: string }> = [];
    let now = 0;
    const base = {
      escalate: async (i: unknown) => { escalations.push(i); return { msg_id: 'esc-99' }; },
      resolve: async (i: { msg_id: string; choice: string }) => { resolves.push(i); },
      now: () => now,
      sustainTicks: 1, // fire immediately for the self-clear assertion
    };

    // fire on 0…
    const a = await runSinglePrimaryCheck('ws', { ...base, count: async () => 0 });
    expect(a.fired).toBe(true);
    expect(escalations.length).toBe(1);
    expect(resolves.length).toBe(0);

    // …recover to 1 → the open escalation auto-resolves.
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', { ...base, count: async () => 1 });
    expect(b.fired).toBe(false);
    expect(b.selfCleared).toBe(true);
    expect(resolves.length).toBe(1);
    expect(resolves[0].msg_id).toBe('esc-99');
    expect(resolves[0].choice).toBe('auto-resolved-recovered');

    // a second healthy tick does NOT re-resolve (the alarm is already cleared).
    const c = await runSinglePrimaryCheck('ws', { ...base, count: async () => 1 });
    expect(c.selfCleared).toBe(false);
    expect(resolves.length).toBe(1);
  });
});
