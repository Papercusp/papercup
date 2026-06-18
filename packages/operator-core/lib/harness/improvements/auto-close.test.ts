import { describe, it, expect, afterEach } from 'vitest';
import {
  decideAutoClose,
  processAutoClose,
  type AutoCloseCandidate,
  type AutoCloseTickContext,
  type AutoCloseDeps,
} from './auto-close';
import type { EngineerIssue } from '../../issues-engineer';

// P-009 (watchdog-and-exposed-systems-improvement-2026-06-18): the auto-close sweep
// retires a watchdog-sourced EI once its signal stops firing. Auto-closing real items
// is dangerous, so every guard in the pure decision is pinned here, plus the
// DEFAULT-OFF flag gate (inert until the owner enables it).

const NOW = 1_700_000_000_000;
const THREE_H_AGO = NOW - 3 * 60 * 60 * 1000;

const baseCandidate: AutoCloseCandidate = {
  issueId: 'EI-1',
  watchdogKey: 'red-test:packages/x/foo.test.ts',
  state: 'open',
  assignee: null,
  createdAtMs: THREE_H_AGO,
  signalOrigin: 'organic',
  inFlightDispatch: false,
};
const baseCtx: AutoCloseTickContext = { seenKeys: new Set<string>(), ranTickCount: 6, nowMs: NOW };

describe('decideAutoClose — guards (the safety-critical decision)', () => {
  it('CLOSES the happy path: open, organic, unassigned, eligible source, old enough, absent, enough history', () => {
    const d = decideAutoClose(baseCandidate, baseCtx);
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/evidence cleared/);
  });

  it('refuses each guard with a distinct reason', () => {
    expect(decideAutoClose({ ...baseCandidate, state: 'resolved' }, baseCtx)).toMatchObject({ close: false, reason: 'not-open' });
    expect(decideAutoClose({ ...baseCandidate, watchdogKey: '' }, baseCtx)).toMatchObject({ close: false, reason: 'no-watchdog-key' });
    expect(decideAutoClose({ ...baseCandidate, signalOrigin: 'drill' }, baseCtx)).toMatchObject({ close: false, reason: 'non-organic' });
    // service-down is a live-state source, deliberately NOT in the eligible allowlist.
    expect(decideAutoClose({ ...baseCandidate, watchdogKey: 'service-down:operator' }, baseCtx)).toMatchObject({ close: false, reason: 'ineligible-source' });
    expect(decideAutoClose({ ...baseCandidate, assignee: 'su-abc' }, baseCtx)).toMatchObject({ close: false, reason: 'assigned' });
    expect(decideAutoClose({ ...baseCandidate, inFlightDispatch: true }, baseCtx)).toMatchObject({ close: false, reason: 'in-flight-dispatch' });
    expect(decideAutoClose(baseCandidate, { ...baseCtx, ranTickCount: 5 })).toMatchObject({ close: false, reason: 'insufficient-tick-history' });
    expect(decideAutoClose({ ...baseCandidate, createdAtMs: NOW - 10 * 60_000 }, baseCtx)).toMatchObject({ close: false, reason: 'too-new' });
    expect(decideAutoClose(baseCandidate, { ...baseCtx, seenKeys: new Set([baseCandidate.watchdogKey]) })).toMatchObject({ close: false, reason: 'still-firing' });
  });

  it('honors a custom minAbsentTicks / minIssueAgeMs', () => {
    // With minAbsentTicks 10, a 6-tick window is insufficient.
    expect(decideAutoClose(baseCandidate, baseCtx, { minAbsentTicks: 10 })).toMatchObject({ close: false, reason: 'insufficient-tick-history' });
    // With a 5h min age, a 3h-old item is too new.
    expect(decideAutoClose(baseCandidate, baseCtx, { minIssueAgeMs: 5 * 60 * 60 * 1000 })).toMatchObject({ close: false, reason: 'too-new' });
  });

  it('accepts every eligible source and rejects an unlisted one', () => {
    for (const src of ['red-test', 'repeated-tool-error', 'stalled-feature', 'unresolved-escalation', 'failed-spawn', 'smoke-fail', 'escalation-spike', 'fire-circuit-open', 'governor-starvation', 'orphaned-spawn', 'stuck-plan', 'ship-link-stuck']) {
      expect(decideAutoClose({ ...baseCandidate, watchdogKey: `${src}:k` }, baseCtx).close).toBe(true);
    }
    for (const src of ['service-down', 'migration-drift', 'orphaned-dispatch', 'insight-staleness']) {
      expect(decideAutoClose({ ...baseCandidate, watchdogKey: `${src}:k` }, baseCtx).close).toBe(false);
    }
  });
});

// ── processAutoClose IO (flag gate + orchestration) ──────────────────────────
const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_WATCHDOG_AUTO_CLOSE';
afterEach(() => { delete process.env[FLAG_ENV]; });

const mkIssue = (over: Partial<EngineerIssue> & { watchdogKey?: string }): EngineerIssue => {
  const { watchdogKey, ...rest } = over;
  return {
    id: 'EI-x',
    state: 'open',
    assignee: null,
    createdAt: new Date(THREE_H_AGO).toISOString(),
    signalOrigin: 'organic',
    payload: watchdogKey ? { watchdogKey } : {},
    ...rest,
  } as unknown as EngineerIssue;
};

describe('processAutoClose — flag gate + orchestration', () => {
  it('is INERT when the flag is off (default): never reads deps, closes nothing', async () => {
    let touched = false;
    const deps: AutoCloseDeps = {
      listOpen: async () => { touched = true; return []; },
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async () => { touched = true; },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(out).toEqual([]);
    expect(touched).toBe(false); // gate short-circuits before any read
  });

  it('with the flag ON, closes ONLY the eligible candidate (skips assigned / in-flight / still-firing / too-new / ineligible)', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const issues = [
      mkIssue({ id: 'EI-close', watchdogKey: 'red-test:gone.test.ts' }), // → closes
      mkIssue({ id: 'EI-firing', watchdogKey: 'repeated-tool-error:hot:structural' }), // still firing
      mkIssue({ id: 'EI-assigned', watchdogKey: 'red-test:owned.test.ts', assignee: 'su-z' }), // assigned
      mkIssue({ id: 'EI-inflight', watchdogKey: 'stalled-feature:papercup' }), // in-flight dispatch
      mkIssue({ id: 'EI-new', watchdogKey: 'red-test:fresh.test.ts', createdAt: new Date(NOW - 5 * 60_000).toISOString() }), // too new
      mkIssue({ id: 'EI-ineligible', watchdogKey: 'service-down:operator' }), // ineligible source
      mkIssue({ id: 'EI-nokey' }), // no watchdogKey → pre-filtered out
    ];
    const deps: AutoCloseDeps = {
      listOpen: async () => issues,
      recentRanTickKeys: async () => ({ seenKeys: new Set(['repeated-tool-error:hot:structural']), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(['EI-inflight']),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(closed).toEqual(['EI-close']);
    expect(out.map((o) => o.issueId)).toEqual(['EI-close']);
  });

  it('does nothing when tick history is insufficient (fresh watchdog)', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const deps: AutoCloseDeps = {
      listOpen: async () => [mkIssue({ id: 'EI-close', watchdogKey: 'red-test:gone.test.ts' })],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 2 }), // < 6
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(out).toEqual([]);
    expect(closed).toEqual([]);
  });
});
