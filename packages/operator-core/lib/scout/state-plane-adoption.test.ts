import { describe, expect, it } from 'vitest';

import {
  ACT_WINDOW_MS,
  POLL_TURN_THRESHOLD,
  type PlaneCallRow,
  computeStatePlaneAdoption,
} from './state-plane-adoption';

const T0 = 1_700_000_000_000;

function row(spawnId: string, toolName: string, offsetMs: number, ownerId = 'su-a'): PlaneCallRow {
  return { ownerId, spawnId, toolName, atMs: T0 + offsetMs };
}

describe('state-plane-adoption — D-003: an empty denominator is null, never 0', () => {
  it('reports rate null and unmeasurable for a window with no activity', () => {
    const out = computeStatePlaneAdoption([], 7);
    expect(out.actQuote.opportunities).toBe(0);
    expect(out.actQuote.rate).toBeNull();
    expect(out.wait.rate).toBeNull();
    expect(out.unmeasurable).toBe(true);
  });

  it('does NOT report unmeasurable once a real opportunity exists', () => {
    // The live case this guards: measured 2026-08-08 the fleet fell to 12 calls/day, and
    // an idle window reported as "0% adoption" reads as a regression that never happened.
    const out = computeStatePlaneAdoption(
      [row('s1', 'dev:pipeline_position', 0), row('s1', 'coord:send', 1_000)],
      7,
    );
    expect(out.unmeasurable).toBe(false);
    expect(out.actQuote.rate).toBe(0);
  });
});

describe('state-plane-adoption — METRIC A (act/quote)', () => {
  it('counts a door-then-write as an unadopted opportunity', () => {
    const out = computeStatePlaneAdoption(
      [row('s1', 'dev:pipeline_position', 0), row('s1', 'coord:send', 5_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(0);
    expect(out.actQuote.rate).toBe(0);
  });

  it('counts a door-then-state:read-then-write as ADOPTED', () => {
    const out = computeStatePlaneAdoption(
      [
        row('s1', 'dev:pipeline_position', 0),
        row('s1', 'state:read', 3_000),
        row('s1', 'coord:send', 5_000),
      ],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(1);
    expect(out.actQuote.rate).toBe(1);
  });

  it('does NOT credit a state:read that precedes the door read (ordering is the point)', () => {
    // A re-read before the value exists re-reads nothing. Without this the metric could be
    // satisfied by reading in the wrong order, which is not the behaviour being measured.
    const out = computeStatePlaneAdoption(
      [
        row('s1', 'state:read', 0),
        row('s1', 'dev:pipeline_position', 3_000),
        row('s1', 'coord:send', 5_000),
      ],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(0);
  });

  it('does not count a write with no door value in hand as an opportunity', () => {
    const out = computeStatePlaneAdoption([row('s1', 'coord:send', 0)], 7);
    expect(out.actQuote.opportunities).toBe(0);
  });

  it('does not count a write once the door value has gone stale', () => {
    const out = computeStatePlaneAdoption(
      [row('s1', 'dev:pipeline_position', 0), row('s1', 'coord:send', ACT_WINDOW_MS + 1_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(0);
  });

  it('does not join a door read in one spawn to a write in another', () => {
    const out = computeStatePlaneAdoption(
      [row('s1', 'dev:pipeline_position', 0), row('s2', 'coord:send', 1_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(0);
  });
});

describe('state-plane-adoption — METRIC B (wait/poll)', () => {
  const pollRows = (spawn: string) => [
    row(spawn, 'dev:pipeline_position', 0),
    row(spawn, 'dev:pipeline_position', 60_000),
    row(spawn, 'dev:pipeline_position', 120_000),
  ];

  it('counts a multi-turn door poll as an unadopted opportunity', () => {
    const out = computeStatePlaneAdoption(pollRows('s1'), 7);
    expect(out.wait.opportunities).toBe(1);
    expect(out.wait.adopted).toBe(0);
  });

  it('counts a poll that also used state:subscribe as ADOPTED', () => {
    const out = computeStatePlaneAdoption(
      [...pollRows('s1'), row('s1', 'state:subscribe', 130_000)],
      7,
    );
    expect(out.wait.opportunities).toBe(1);
    expect(out.wait.adopted).toBe(1);
    expect(out.wait.rate).toBe(1);
  });

  it('does NOT treat calls batched into ONE inference turn as a poll loop', () => {
    // TURNS, not raw calls — the code-run-adoption P-012 lesson. Three calls dispatched
    // from one response block cost a single round-trip; counting them as a poll loop
    // would inflate the denominator with sessions that were already optimal.
    const out = computeStatePlaneAdoption(
      [
        row('s1', 'dev:pipeline_position', 0),
        row('s1', 'dev:pipeline_position', 50),
        row('s1', 'dev:pipeline_position', 100),
      ],
      7,
    );
    expect(out.wait.opportunities).toBe(0);
  });

  it('counts ONE opportunity per spawn however many times it polled', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row('s1', 'dev:pipeline_position', i * 30_000),
    );
    const out = computeStatePlaneAdoption(many, 7);
    expect(out.wait.opportunities).toBe(1);
  });

  it('needs at least POLL_TURN_THRESHOLD turns before it is a poll loop', () => {
    const out = computeStatePlaneAdoption(
      [row('s1', 'dev:pipeline_position', 0), row('s1', 'dev:pipeline_position', 60_000)],
      7,
    );
    expect(POLL_TURN_THRESHOLD).toBe(3);
    expect(out.wait.opportunities).toBe(0);
  });
});

describe('state-plane-adoption — P-006: the ratio can actually reach 100%', () => {
  it('reaches 1.0 on both axes when every opportunity is taken', () => {
    // This is the whole reason P-006 exists. The Phase-1 metric ("plane share of pipeline
    // reads") could not reach 1.0 by construction, because CLAUDE.md prescribes the DOOR
    // as the first read — so perfect behaviour still emitted door calls and scored as a
    // miss. Perfect behaviour here scores 1.0, DESPITE the door calls being present.
    const rows: PlaneCallRow[] = [
      row('s1', 'dev:pipeline_position', 0),
      row('s1', 'state:read', 1_000),
      row('s1', 'coord:send', 2_000),

      row('s2', 'dev:pipeline_position', 0),
      row('s2', 'dev:pipeline_position', 60_000),
      row('s2', 'dev:pipeline_position', 120_000),
      row('s2', 'state:subscribe', 130_000),
    ];
    const out = computeStatePlaneAdoption(rows, 7);
    expect(out.actQuote.rate).toBe(1);
    expect(out.wait.rate).toBe(1);
    expect(out.unmeasurable).toBe(false);
  });

  it('tracks BREADTH separately from depth (Phase 1 found breadth the weak axis)', () => {
    const rows: PlaneCallRow[] = [
      // su-a adopts, repeatedly.
      row('s1', 'dev:pipeline_position', 0, 'su-a'),
      row('s1', 'state:read', 1_000, 'su-a'),
      row('s1', 'coord:send', 2_000, 'su-a'),
      row('s1', 'dev:pipeline_position', 3_000, 'su-a'),
      row('s1', 'state:read', 4_000, 'su-a'),
      row('s1', 'coord:send', 5_000, 'su-a'),
      // su-b never does.
      row('s2', 'dev:pipeline_position', 0, 'su-b'),
      row('s2', 'coord:send', 2_000, 'su-b'),
    ];
    const out = computeStatePlaneAdoption(rows, 7);
    expect(out.actQuote.agentsWithOpportunity).toBe(2);
    expect(out.actQuote.agentsAdopting).toBe(1);
    // Depth looks healthy (2 of 3) while breadth is half — the distinction Phase 1 needed.
    expect(out.actQuote.adopted).toBe(2);
    expect(out.actQuote.opportunities).toBe(3);
  });
});
