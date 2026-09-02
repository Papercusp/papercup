/**
 * P-017 (coordination-spec-adoption-2026-08-03) — the capture tick's contract.
 *
 * The measurement layer's own maths is covered by `tool-rejection-rate.test.ts`;
 * what is tested HERE is the part that can silently stop working without any test
 * going red: that a breaching verb actually reaches `captureImprovement`, under a
 * key stable enough that a weekly re-tick does not re-file it, filed against the
 * TOOL rather than its callers, and without ever escalating.
 *
 * Every case injects the rollup, so none of this touches PG.
 */
import { describe, it, expect, vi } from 'vitest';
import { runToolRejectionMinerTick } from './tool-rejection-miner';
import { describeToolRejection, type ToolRejectionRollup, type ToolRejectionRow } from '../../tool-rejection-rate';
import type { CaptureImprovementInput, CaptureImprovementResult } from './capture-core';

function row(toolName: string, over: Partial<ToolRejectionRow> = {}): ToolRejectionRow {
  return {
    toolName,
    calls: 500,
    rejects: 150,
    schemaRejectPct: 30,
    breachDays: 5,
    eligibleDays: 7,
    peakDistinctOwners: 12,
    lastErrorMessage: 'premises: Expected array, received object',
    ...over,
  };
}

function rollup(breaching: ToolRejectionRow[]): ToolRejectionRollup {
  return {
    windowDays: 7,
    breaching,
    toolsSeen: 240,
    totalCalls: 235252,
    totalRejects: 1165,
    aggregatePct: 0.5,
  };
}

/** A capture spy that records inputs and reports every filing as newly created. */
function captureSpy(over: Partial<CaptureImprovementResult> = {}) {
  const calls: CaptureImprovementInput[] = [];
  const fn = vi.fn(async (input: CaptureImprovementInput): Promise<CaptureImprovementResult> => {
    calls.push(input);
    return { created: true, issue: { id: `EI-${calls.length}` }, ...over } as CaptureImprovementResult;
  });
  return { calls, fn: fn as unknown as typeof import('./capture-core').captureImprovement };
}

describe('runToolRejectionMinerTick — filing', () => {
  it('files one improvement per breaching verb, with describeToolRejection wording', async () => {
    const spy = captureSpy();
    const roll = rollup([row('coord:send'), row('operator:converse', { schemaRejectPct: 100, rejects: 56, calls: 56 })]);

    const result = await runToolRejectionMinerTick('ws', {}, { rollup: roll, capture: spy.fn });

    expect(result.breaching).toBe(2);
    expect(result.captured).toEqual(['EI-1', 'EI-2']);
    expect(result.declined).toBe(0);
    expect(result.failed).toBe(0);
    expect(spy.calls.map((c) => c.title)).toEqual([
      describeToolRejection(roll.breaching[0]!, roll).title,
      describeToolRejection(roll.breaching[1]!, roll).title,
    ]);
  });

  it('files under a stable per-tool key so a weekly re-tick dedups instead of re-filing', async () => {
    const spy = captureSpy();
    const roll = rollup([row('coord:send')]);

    await runToolRejectionMinerTick('ws', {}, { rollup: roll, capture: spy.fn });

    const input = spy.calls[0]!;
    // The key must not embed the RATE — the rate moves every week, and a key that
    // moved with it would file a fresh item on every tick for one unfixed verb.
    expect(input.watchdogKey).toBe('tool-rejection-rate:coord:send');
    expect(input.findingClass).toBe(input.watchdogKey);
    expect(input.dedupScope).toBe('open');
    expect(input.watchdogKey).not.toMatch(/\d/);
  });

  it('files against the TOOL and carries the aggregate that hid it', async () => {
    const spy = captureSpy();
    await runToolRejectionMinerTick('ws', {}, { rollup: rollup([row('coord:send')]), capture: spy.fn });

    const body = spy.calls[0]!.body ?? '';
    expect(body).toMatch(/filed against the TOOL, not its callers/i);
    // The aggregate is half the finding: without it a reader dismisses the verb's
    // rate by checking fleet health, which is exactly how this went unfiled.
    expect(body).toContain('0.5%');
    expect(spy.calls[0]!.subTopic).toBe('tool-rejection-rate');
  });

  it('never escalates — a schema-rejection rate is a design defect, not an outage', async () => {
    const spy = captureSpy();
    await runToolRejectionMinerTick(
      'ws',
      {},
      { rollup: rollup([row('operator:converse', { schemaRejectPct: 100 })]), capture: spy.fn },
    );

    // Even at a 100% rejection rate: kind=change, severity=minor. Paging on this
    // would re-teach the reflex P-017 exists to correct.
    expect(spy.calls[0]!.kind).toBe('change');
    expect(spy.calls[0]!.severity).toBe('minor');
  });
});

describe('runToolRejectionMinerTick — bounds and failure isolation', () => {
  it('caps filings at maxPerTick, drip-feeding a real backlog', async () => {
    const spy = captureSpy();
    const roll = rollup(['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6', 'g:7'].map((t) => row(t)));

    const result = await runToolRejectionMinerTick('ws', { maxPerTick: 3 }, { rollup: roll, capture: spy.fn });

    // `breaching` reports the TRUE backlog; only the filings are capped.
    expect(result.breaching).toBe(7);
    expect(result.captured).toHaveLength(3);
    expect(spy.calls.map((c) => c.title.split(' ')[0])).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('excludes the improvement loop’s own verbs from filing, not from the reading', async () => {
    const spy = captureSpy();
    const roll = rollup([row('improvements:capture'), row('system:improvement-watchdog'), row('coord:send')]);

    const result = await runToolRejectionMinerTick('ws', {}, { rollup: roll, capture: spy.fn });

    expect(result.skippedSelf).toBe(2);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.title).toContain('coord:send');
    // The aggregate still reflects every verb — the exclusion is about self-feeding,
    // not about making the fleet number look better.
    expect(result.breaching).toBe(3);
    expect(result.aggregatePct).toBe(0.5);
  });

  it('counts a declined duplicate separately from a capture', async () => {
    const spy = captureSpy({ created: false });
    const result = await runToolRejectionMinerTick(
      'ws',
      {},
      { rollup: rollup([row('coord:send')]), capture: spy.fn },
    );

    expect(result.captured).toEqual([]);
    expect(result.declined).toBe(1);
  });

  it('one failing capture never aborts the rest of the tick', async () => {
    const seen: string[] = [];
    const capture = vi.fn(async (input: CaptureImprovementInput) => {
      seen.push(input.title);
      if (seen.length === 1) throw new Error('pg down');
      return { created: true, issue: { id: 'EI-9' } } as CaptureImprovementResult;
    }) as unknown as typeof import('./capture-core').captureImprovement;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runToolRejectionMinerTick(
      'ws',
      {},
      { rollup: rollup([row('a:1'), row('b:2')]), capture },
    );

    expect(result.failed).toBe(1);
    expect(result.captured).toEqual(['EI-9']);
    expect(seen).toHaveLength(2);
    warn.mockRestore();
  });

  it('a clean window files nothing but still reports the aggregate it measured', async () => {
    const spy = captureSpy();
    const result = await runToolRejectionMinerTick('ws', {}, { rollup: rollup([]), capture: spy.fn });

    expect(spy.calls).toEqual([]);
    expect(result.breaching).toBe(0);
    // Distinguishes "measured, nothing breached" from "the tick never ran" — the
    // self-measurement the routine's log line depends on.
    expect(result.toolsSeen).toBe(240);
    expect(result.totalCalls).toBe(235252);
  });
});
