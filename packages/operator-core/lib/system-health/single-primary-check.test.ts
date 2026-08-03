import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluatePrimaryCount,
  countBackgroundPrimaries,
  lastRoutineFireAgeSec,
  routinesDemonstrablyFiring,
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

// EI-19388269294151851 — the guard broadcast "routines, git-sync and the Mug wake-loop are
// all down" for ~3.6h while git-sync committed 66 times. The count was right; the
// consequence it hardcoded was not. These pin that a count-0 with LIVE routine activity
// can never again render that text or reach the owner as a blocker.
describe('evaluatePrimaryCount — count 0 checks its consequence against live evidence', () => {
  const FIRING = { lastRoutineFireAgeSec: 42 };
  const STALE = { lastRoutineFireAgeSec: 3600 };

  it('zero WITH routines still firing → advisory, NOT a blocker', () => {
    const v = evaluatePrimaryCount(0, FIRING);
    expect(v).toMatchObject({ ok: false, severity: 'advisory', key: 'no-dedicated-primary' });
  });

  it('zero WITH routines still firing NEVER claims background work has stopped', () => {
    const s = evaluatePrimaryCount(0, FIRING).summary;
    expect(s).not.toContain('all down');
    expect(s).toContain('NOT stopped');
    // Must EXPLICITLY disclaim the death class, not merely omit it — the blocker text is
    // what agents pattern-match on. (Asserting `not.toContain('routine-engine-death')`
    // would be wrong here: it appears inside that very negation.)
    expect(s).toContain('NOT the routine-engine-death class');
    expect(s).toContain('42s ago'); // the evidence travels with the claim
  });

  it('zero with STALE routines → the real blocker, text unchanged', () => {
    const v = evaluatePrimaryCount(0, STALE);
    expect(v).toMatchObject({ ok: false, severity: 'blocker', key: 'no-primary' });
    expect(v.summary).toContain('all down');
  });

  it('zero with UNKNOWN evidence falls back to the blocker — never invents a healthier read', () => {
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: null }).key).toBe('no-primary');
    expect(evaluatePrimaryCount(0).key).toBe('no-primary');
  });

  it('split-brain is unaffected by activity evidence (>1 is always a blocker)', () => {
    expect(evaluatePrimaryCount(2, FIRING)).toMatchObject({ severity: 'blocker', key: 'split-brain-primary' });
  });

  it('routinesDemonstrablyFiring: only a fresh, finite, non-negative age counts', () => {
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 0 })).toBe(true);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 600 })).toBe(true);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 601 })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: null })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: -5 })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: NaN })).toBe(false);
    expect(routinesDemonstrablyFiring(undefined)).toBe(false);
  });
});

describe('lastRoutineFireAgeSec', () => {
  it('returns the age reported by the injected sql', async () => {
    const sql = (async () => [{ age_sec: 12.5 }]) as never;
    expect(await lastRoutineFireAgeSec(sql)).toBe(12.5);
  });
  it('null when nothing has ever fired (fresh install) — reads as unknown', async () => {
    expect(await lastRoutineFireAgeSec((async () => [{ age_sec: null }]) as never)).toBeNull();
    expect(await lastRoutineFireAgeSec((async () => []) as never)).toBeNull();
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
    // routineFireAgeSec null = unknown ⇒ the count-only blocker path these assertions target.
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate,
      now: () => now,
      debounceMs: 30 * 60_000,
    };

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
    const a = await runSinglePrimaryCheck('ws', {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate,
      now: () => 1,
    });
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
    const deps = { count: async () => 2, routineFireAgeSec: async () => null, escalate, now: () => now };
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
    const a = await runSinglePrimaryCheck('ws', {
      ...base,
      count: async () => 0,
      routineFireAgeSec: async () => null,
    });
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

  // EI-19388269294151851: the 2026-08-03 incident, end to end. A sustained count of 0
  // while routines keep firing must be RECORDED but must never urgent-page the owner or
  // fire the "everything is down" fleet broadcast.
  it('sustained 0 WITH routines firing: records an advisory and NEVER pages', async () => {
    const escalated: Array<{ severity: string; summary: string }> = [];
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 42, // git-sync et al demonstrably alive
      escalate: async (i: { severity: string; summary: string }) => { escalated.push(i); return { msg_id: 'adv-1' }; },
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };

    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false); // streak 1, hysteresis
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);

    expect(b.fired).toBe(true);
    expect(b.verdict.key).toBe('no-dedicated-primary');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].severity).toBe('advisory');
    expect(escalated[0].summary).not.toContain('all down');
    expect(paged).toHaveLength(0); // the owner is NOT urgent-paged
  });

  it('sustained 0 with routines STALE still pages — the real outage is untouched', async () => {
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 4000, // nothing has fired in over an hour
      escalate: async () => ({ msg_id: 'blk-1' }),
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };
    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);

    expect(b.verdict.key).toBe('no-primary');
    expect(b.verdict.severity).toBe('blocker');
    expect(paged).toHaveLength(1);
  });

  it('a failing evidence query degrades to the blocker, never to silence', async () => {
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => { throw new Error('pg down'); },
      escalate: async () => ({ msg_id: 'blk-2' }),
      page: async () => {},
      now: () => now,
    };
    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    expect((await runSinglePrimaryCheck('ws', deps)).verdict.key).toBe('no-primary');
  });
});
