/**
 * agent-state-stamp.test.ts — P-009's per-owner declaration cache
 * (unified-agent-state-plane-2026-07-27).
 *
 * The contract under test is narrow but load-bearing: this cache is read on
 * EVERY tool call (~238,866/day), so it must never throw, never block, and never
 * hand back a pointer that names something other than what it named when it was
 * written.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteIntentDeclared,
  noteAssumptionAsserted,
  noteGoalClaimed,
  readAgentStateStamp,
  resetAgentStateStamps,
  agentStateStampSize,
} from './agent-state-stamp';

const OWNER = 'su-8d9a671c';
const OTHER = 'su-2846407f';

beforeEach(() => resetAgentStateStamps());

describe('readAgentStateStamp — the hot-path read', () => {
  it('returns all-nulls for an owner that never declared anything', () => {
    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
  });

  it('returns all-nulls (never throws) for an unattributable caller', () => {
    // buildTelemetryRow passes `coordOwnerId`, which is null whenever
    // resolveAgentIdentity throws. Telemetry is best-effort: a missing identity
    // must degrade to three NULL columns, never to an exception on the dispatch
    // path.
    expect(readAgentStateStamp(null)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
    expect(readAgentStateStamp(undefined)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
    expect(readAgentStateStamp('')).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
  });

  it('exposes EXACTLY the three stamp keys — no internal bookkeeping leaks out', () => {
    // Regression: the cache first carried an LRU `seq` counter on the stored
    // object, so every reader got a fourth field it never asked for. Harmless
    // for buildTelemetryRow (it reads three named fields) but a real leak for
    // anything that serialises or compares the stamp — and the recency order the
    // counter duplicated is already carried by the Map's insertion order.
    noteIntentDeclared(OWNER, 101);
    noteAssumptionAsserted(OWNER, 3368);
    noteGoalClaimed(OWNER, 'WI-6393');
    expect(Object.keys(readAgentStateStamp(OWNER)).sort()).toEqual([
      'assumptionSetId',
      'goalRef',
      'intentEventId',
    ]);
  });

  it('keeps owners isolated — one agent cannot read another agent state', () => {
    noteIntentDeclared(OWNER, 101);
    noteGoalClaimed(OTHER, 'WI-6393');
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(101);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
    expect(readAgentStateStamp(OTHER).goalRef).toBe('WI-6393');
    expect(readAgentStateStamp(OTHER).intentEventId).toBeNull();
  });
});

describe('the three declarations have INDEPENDENT lifetimes (D-011)', () => {
  it('re-declaring intent does not clear the goal or the assumptions', () => {
    // This is the case that actually happens every wake: coord:orient
    // re-declares intent while the agent holds the same claim throughout. A
    // whole-state reset here would blank the goal on every wake — the same bug
    // class as EI-18776963284535761 (declare-intent wiping current_files).
    noteGoalClaimed(OWNER, 'WI-6393');
    noteAssumptionAsserted(OWNER, 3368);
    noteIntentDeclared(OWNER, 101);
    noteIntentDeclared(OWNER, 202);

    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 202,
      assumptionSetId: 3368,
      goalRef: 'WI-6393',
    });
  });
});

describe('noteAssumptionAsserted — the watermark', () => {
  it('advances to the newest fact version id', () => {
    noteAssumptionAsserted(OWNER, 3368);
    noteAssumptionAsserted(OWNER, 3400);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });

  it('NEVER moves backwards, even if a lower id arrives later', () => {
    // Ids come from a sequence, so two racing asserts can settle out of order.
    // A watermark that regressed would silently NARROW the set every subsequent
    // call claims to have been made under — it would drop assumptions the agent
    // demonstrably already held.
    noteAssumptionAsserted(OWNER, 3400);
    noteAssumptionAsserted(OWNER, 3368);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });

  it('ignores a null/non-finite id rather than poisoning the pointer', () => {
    noteAssumptionAsserted(OWNER, 3400);
    noteAssumptionAsserted(OWNER, null);
    noteAssumptionAsserted(OWNER, Number.NaN);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });
});

describe('noteIntentDeclared', () => {
  it('ignores a null id — an append with no sequence number is not a pointer', () => {
    // fs/memory-backed logs return null from appendLine by contract. Stamping
    // that as an id would produce a pointer at nothing.
    noteIntentDeclared(OWNER, null);
    expect(readAgentStateStamp(OWNER).intentEventId).toBeNull();
  });

  it('takes the LATEST intent, including a lower id (unlike the watermark)', () => {
    // Intent is "the most recent declaration", not a high-water mark: an agent
    // genuinely moves from one intent to another and the newest one wins.
    noteIntentDeclared(OWNER, 202);
    noteIntentDeclared(OWNER, 101);
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(101);
  });
});

describe('noteGoalClaimed', () => {
  it('records a claimed goal and clears it on release', () => {
    noteGoalClaimed(OWNER, 'WI-6393');
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6393');
    noteGoalClaimed(OWNER, null);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });

  it('normalises blank/whitespace refs to null rather than storing them', () => {
    noteGoalClaimed(OWNER, '   ');
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
    noteGoalClaimed(OWNER, '  WI-6393  ');
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6393');
  });

  it('clearing the goal leaves intent and assumptions intact', () => {
    noteIntentDeclared(OWNER, 101);
    noteAssumptionAsserted(OWNER, 3368);
    noteGoalClaimed(OWNER, 'WI-6393');
    noteGoalClaimed(OWNER, null);
    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 101,
      assumptionSetId: 3368,
      goalRef: null,
    });
  });
});

describe('memory bound', () => {
  it('evicts least-recently-written owners past the cap instead of growing forever', () => {
    // A long-lived operator process sees thousands of distinct owners over
    // weeks (2,363 distinct intent writers in 8 weeks, measured 2026-07-27).
    // Unbounded growth would be a slow leak in the hottest shared process.
    for (let i = 0; i < 600; i++) noteIntentDeclared(`owner-${i}`, i + 1);
    expect(agentStateStampSize()).toBeLessThanOrEqual(512);
    // The most recent writers survive; the oldest are gone.
    expect(readAgentStateStamp('owner-599').intentEventId).toBe(600);
    expect(readAgentStateStamp('owner-0').intentEventId).toBeNull();
  });

  it('a re-written owner is kept fresh and is not evicted as stale', () => {
    noteIntentDeclared(OWNER, 1);
    for (let i = 0; i < 400; i++) noteIntentDeclared(`filler-${i}`, i + 1);
    // Touch the original again — it must now be among the most recent.
    noteIntentDeclared(OWNER, 2);
    for (let i = 400; i < 900; i++) noteIntentDeclared(`filler-${i}`, i + 1);
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(2);
  });
});
