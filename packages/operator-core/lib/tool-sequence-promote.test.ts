import { describe, it, expect } from 'vitest';
import {
  promoteToolSequences,
  renderSequenceFiling,
  selectMaximalSequenceCandidates,
  sequenceWatchdogKey,
  SEQUENCE_PROMOTION_SOURCE,
  SEQUENCE_PROMOTION_KILL_ENV,
} from './tool-sequence-promote';
import type { PersistentToolSequenceCandidate } from './tool-sequence-patterns';
import type { CaptureImprovementInput, CaptureImprovementResult } from './harness/improvements/capture-core';

type Row = { agent: string; tool_name: string; spawn_id: string; invoked_at: string };
const row = (agent: string, tool: string, spawn: string, iso: string): Row => ({
  agent,
  tool_name: tool,
  spawn_id: spawn,
  invoked_at: iso,
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Build invocation rows placing each dance in the chosen day-windows. Same shape
 * the miner's own suite uses — `windowsBack` counts back from now, 0 being the
 * most recent window — so a graduation here means the same thing it means there.
 */
function rowsFor(
  spec: { tools: string[]; agents: string[]; windowsBack: number[]; repeats?: number }[],
  windows = 7,
): Row[] {
  const now = Date.now();
  const start = now - windows * DAY;
  const out: Row[] = [];
  let n = 0;
  spec.forEach((s, si) => {
    for (const wb of s.windowsBack) {
      const base = start + (windows - 1 - wb) * DAY + (4 + si * 4) * HOUR;
      for (const agent of s.agents) {
        for (let r = 0; r < (s.repeats ?? 1); r++) {
          const burstBase = base + r * 10 * 60_000;
          s.tools.forEach((t, i) => {
            out.push(row(agent, t, `sp-${n++}`, new Date(burstBase + i * 3_000).toISOString()));
          });
        }
      }
    }
  });
  return out;
}

const fakeSql = (rows: Row[]) => ((..._a: unknown[]) => Promise.resolve(rows)) as never;

const opts = {
  workspaceId: 'ws',
  harnessSlug: 'papercusp',
  windows: 7,
  windowHours: 24,
  minStreak: 3,
  minOccurrences: 4,
  minAgents: 3,
  minLift: 2,
};

/** Two graduating dances plus filler, so ranking and caps have something to act on. */
const TWO_GRADUATES: Row[] = rowsFor([
  { tools: ['alpha:one', 'alpha:two', 'alpha:three'], agents: ['a1', 'a2', 'a3'], windowsBack: [0, 1, 2, 3], repeats: 3 },
  { tools: ['beta:one', 'beta:two'], agents: ['b1', 'b2', 'b3'], windowsBack: [0, 1, 2, 3], repeats: 3 },
  { tools: ['noise:x', 'noise:y'], agents: ['a1', 'a2', 'a3', 'a4'], windowsBack: [0, 1, 2, 3, 4, 5, 6], repeats: 6 },
]);

/** A capture spy: records every filing and answers with a caller-chosen verdict. */
function captureSpy(answer: (input: CaptureImprovementInput) => Partial<CaptureImprovementResult> = () => ({ created: true })) {
  const calls: CaptureImprovementInput[] = [];
  const capture = async (input: CaptureImprovementInput): Promise<CaptureImprovementResult> => {
    calls.push(input);
    return { ok: true, possibleDuplicates: [], created: true, ...answer(input) } as CaptureImprovementResult;
  };
  return { calls, capture };
}

const candidate = (over: Partial<PersistentToolSequenceCandidate> = {}): PersistentToolSequenceCandidate => ({
  id: 'seq-abc123',
  toolsUsed: ['coord:orient', 'pot:get-steering'],
  label: 'coord:orient → pot:get-steering',
  occurrences: 42,
  distinctAgents: 17,
  agentSample: ['a1', 'a2', 'a3'],
  bursts: 30,
  lift: 1200.5,
  strength: 3.08,
  windowStreak: 5,
  windowsSeen: 6,
  windowsExamined: 7,
  graduated: true,
  ...over,
});

describe('renderSequenceFiling — the body an AGENT has to act on', () => {
  it('states the evidence, the sequence, and the concrete act', () => {
    const { title, body } = renderSequenceFiling(candidate());
    expect(title).toContain('17 agents');
    expect(title).toContain('coord:orient → pot:get-steering');
    // The numbered sequence is the reproduction — without it the item is a claim.
    expect(body).toContain('1. coord:orient');
    expect(body).toContain('2. pot:get-steering');
    // The evidence bars, both of them.
    expect(body).toContain('17 distinct agents');
    expect(body).toContain('5 consecutive windows');
    // And the act. A body that only says "this is frequent" is not claimable.
    expect(body).toMatch(/collapse into ONE call/);
    expect(body).toContain(SEQUENCE_PROMOTION_SOURCE);
    expect(body).toContain('seq-abc123');
  });

  it('names the resolve-with-a-reason path, so a NO is a real answer', () => {
    // Without this the same dance is re-proposed forever: persistence is exactly
    // what the miner selects for, so a declined pattern keeps re-graduating.
    expect(renderSequenceFiling(candidate()).body).toMatch(/should NOT collapse, resolve with the reason/);
  });
});

describe('sequenceWatchdogKey — the coalesce identity', () => {
  it('is stable for the same sequence and distinct across sequences', () => {
    expect(sequenceWatchdogKey(candidate())).toBe(sequenceWatchdogKey(candidate({ occurrences: 999, windowStreak: 1 })));
    expect(sequenceWatchdogKey(candidate({ id: 'seq-other' }))).not.toBe(sequenceWatchdogKey(candidate()));
  });
});

describe('selectMaximalSequenceCandidates — the nested-prefix recurrence guard', () => {
  it('keeps the broadest graduated prefix and suppresses shorter ladder entries', () => {
    const short = candidate({
      id: 'code-run--code-run',
      toolsUsed: ['code:run', 'code:run'],
      label: 'code:run → code:run',
    });
    const medium = candidate({
      id: 'code-run--code-run--code-run',
      toolsUsed: ['code:run', 'code:run', 'code:run'],
      label: 'code:run → code:run → code:run',
    });
    const broad = candidate({
      id: 'code-run--code-run--code-run--code-run',
      toolsUsed: ['code:run', 'code:run', 'code:run', 'code:run'],
      label: 'code:run → code:run → code:run → code:run',
    });

    const result = selectMaximalSequenceCandidates([short, medium, broad]);

    expect(result.kept.map((c) => c.id)).toEqual([broad.id]);
    expect(result.suppressed.map((c) => c.id)).toEqual([short.id, medium.id]);
  });

  it('does not suppress a sequence that only shares an interior or suffix run', () => {
    const prefix = candidate({
      id: 'a--b',
      toolsUsed: ['a', 'b'],
      label: 'a → b',
    });
    const extension = candidate({
      id: 'a--b--c',
      toolsUsed: ['a', 'b', 'c'],
      label: 'a → b → c',
    });
    const interior = candidate({
      id: 'x--a--b--y',
      toolsUsed: ['x', 'a', 'b', 'y'],
      label: 'x → a → b → y',
    });

    const result = selectMaximalSequenceCandidates([prefix, extension, interior]);

    expect(result.kept.map((c) => c.id)).toEqual([extension.id, interior.id]);
    expect(result.suppressed.map((c) => c.id)).toEqual([prefix.id]);
  });
});

describe('promoteToolSequences — filing without a human in the loop', () => {
  it('files one work-item per graduated candidate', async () => {
    const spy = captureSpy();
    const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: spy.capture });

    expect(res.disabled).toBe(false);
    expect(res.graduated.length).toBeGreaterThanOrEqual(2);
    expect(spy.calls.length).toBe(res.graduated.length);
    expect(res.filed.length).toBe(spy.calls.length);
    expect(res.coalesced).toEqual([]);
    const labels = res.graduated.map((c) => c.label);
    expect(labels).toContain('alpha:one → alpha:two → alpha:three');
    expect(labels).toContain('beta:one → beta:two');
  });

  it('files with the stable watchdogKey and open-scoped dedup — the idempotence contract', async () => {
    const spy = captureSpy();
    await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: spy.capture });

    for (const call of spy.calls) {
      expect(call.watchdogKey).toMatch(new RegExp(`^${SEQUENCE_PROMOTION_SOURCE}:`));
      // 'open' and not 'all': a dance still being performed AFTER someone resolved
      // the item is a regression worth re-raising, not a duplicate to swallow.
      expect(call.dedupScope).toBe('open');
      expect(call.kind).toBe('change');
      expect(call.foundDuring).toBe(SEQUENCE_PROMOTION_SOURCE);
      expect(call.scope).toBe('harness:papercusp');
    }
    // Each graduated sequence gets its OWN key, or a sweep collapses them into one.
    expect(new Set(spy.calls.map((c) => c.watchdogKey)).size).toBe(spy.calls.length);
  });

  it('a second sweep over the same data files the SAME keys — so the capture path can coalesce', async () => {
    // The sweep is scheduled and the miner selects for persistence, so every row
    // it files WILL recur. Without a key stable across sweeps this is a duplicate
    // generator by construction.
    const first = captureSpy();
    await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: first.capture });
    const second = captureSpy();
    await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: second.capture });

    expect(second.calls.map((c) => c.watchdogKey).sort()).toEqual(first.calls.map((c) => c.watchdogKey).sort());
  });

  it('counts a declined duplicate as COALESCED, not filed', async () => {
    const spy = captureSpy(() => ({ created: false, reason: 'likely-duplicate' }));
    const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: spy.capture });

    expect(res.filed).toEqual([]);
    expect(res.coalesced.length).toBe(res.graduated.length);
  });

  it('files NOTHING for candidates still accruing evidence', async () => {
    // A one-window spike: strong, many agents, and deliberately not promotable.
    const spike = rowsFor([
      { tools: ['spike:one', 'spike:two', 'spike:three'], agents: ['a1', 'a2', 'a3', 'a4', 'a5'], windowsBack: [0], repeats: 6 },
      { tools: ['noise:x', 'noise:y'], agents: ['a1', 'a2', 'a3', 'a4'], windowsBack: [0, 1, 2, 3, 4, 5, 6], repeats: 6 },
    ]);
    const spy = captureSpy();
    const res = await promoteToolSequences(fakeSql(spike), opts, { capture: spy.capture });

    // The spike is mined — it is a real, strong pattern — but it has not persisted,
    // so nothing about it reaches the queue. (The filler dance runs in every window
    // and legitimately DOES graduate; asserting on the whole set would test the
    // fixture rather than the gate.)
    const spikeLabel = 'spike:one → spike:two → spike:three';
    expect(res.graduated.map((c) => c.label)).not.toContain(spikeLabel);
    expect(spy.calls.some((c) => c.title.includes('spike:one'))).toBe(false);
    expect(res.heldForEvidence).toBeGreaterThan(0);
  });

  it('caps filings per sweep so a tuning slip cannot flood the queue', async () => {
    const spy = captureSpy();
    const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), { ...opts, maxFilings: 1 }, { capture: spy.capture });

    expect(spy.calls).toHaveLength(1);
    expect(res.filed).toHaveLength(1);
    // The cap bounds FILING, not mining — the full graduated set is still reported,
    // or a caller cannot tell a quiet week from a capped one.
    expect(res.graduated.length).toBeGreaterThan(1);
    // The one that files is the strongest, since graduated is strength-ranked.
    expect(res.filed[0]).toBe(res.graduated[0]!.id);
  });

  it('dryRun reports what WOULD file and captures nothing', async () => {
    const spy = captureSpy();
    const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), { ...opts, dryRun: true }, { capture: spy.capture });

    expect(spy.calls).toEqual([]);
    expect(res.dryRun).toBe(true);
    expect(res.filed).toEqual(res.graduated.map((c) => c.id));
  });

  it('survives a capture that throws — a scheduled sweep must not be taken down by one filing', async () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const capture = async (input: CaptureImprovementInput): Promise<CaptureImprovementResult> => {
      seen.push(input.title);
      if (seen.length === 1) throw new Error('pg is down');
      return { ok: true, created: true, possibleDuplicates: [] } as CaptureImprovementResult;
    };
    const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture, log: (m) => logs.push(m) });

    // The failure is counted and logged, and the REST of the sweep still files.
    expect(seen.length).toBe(res.graduated.length);
    expect(res.filed.length).toBe(res.graduated.length - 1);
    expect(logs.join('\n')).toContain('pg is down');
  });

  it('the kill switch is OFF-by-request only — default runs', async () => {
    const prior = process.env[SEQUENCE_PROMOTION_KILL_ENV];
    try {
      process.env[SEQUENCE_PROMOTION_KILL_ENV] = 'off';
      const spy = captureSpy();
      const res = await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: spy.capture });
      expect(res.disabled).toBe(true);
      expect(spy.calls).toEqual([]);

      // Anything other than the literal 'off' runs: a flag left at '1', 'true' or
      // '' must not silently disable a default-ON surface.
      delete process.env[SEQUENCE_PROMOTION_KILL_ENV];
      const on = captureSpy();
      const ran = await promoteToolSequences(fakeSql(TWO_GRADUATES), opts, { capture: on.capture });
      expect(ran.disabled).toBe(false);
      expect(on.calls.length).toBeGreaterThan(0);
    } finally {
      if (prior === undefined) delete process.env[SEQUENCE_PROMOTION_KILL_ENV];
      else process.env[SEQUENCE_PROMOTION_KILL_ENV] = prior;
    }
  });
});
