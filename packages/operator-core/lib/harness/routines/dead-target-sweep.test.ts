/**
 * Unit tests for the dead-target sweep's decision-shaped exports
 * (dead-target-routine-reaper-2026-08-30 P-003 / P-004).
 *
 * The sweep's DB half is covered by the integration test (P-006); what is tested here is the
 * logic that is easy to get subtly wrong and impossible to notice in production: the kill
 * switch's parsing, and which stored permanence record wins when an install's routines
 * disagree. That second rule exists for a specific race — a routine seeded mid-run carries no
 * record, and a naive "read the first row" would let its absence reset a run that is one
 * sighting away from parking, so a genuinely dead pot could never accumulate two confirmations
 * and would fire forever. That is the original bug, re-entering through the back door.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { priorRecord, reaperEnabled, type RoutineRow } from './dead-target-sweep';
import type { PermanenceRecord } from './dead-target-routine-reaper';

const ENV = 'PAPERCUSP_DEAD_TARGET_REAPER';
const original = process.env[ENV];
afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

function row(name: string, rec: PermanenceRecord | null): RoutineRow {
  return { id: `id-${name}`, install_slug: 'some-pot', name, rec };
}
function rec(confirmations: number, state: PermanenceRecord['state'] = 'root-missing'): PermanenceRecord {
  return { state, firstSeenAtMs: 1000, lastSeenAtMs: 2000, confirmations };
}

describe('reaperEnabled — the kill switch', () => {
  it('is ON by default and when the var is empty', () => {
    delete process.env[ENV];
    expect(reaperEnabled()).toBe(true);
    process.env[ENV] = '';
    expect(reaperEnabled()).toBe(true);
  });

  it('is OFF for every falsy spelling an operator might reach for', () => {
    for (const v of ['0', 'false', 'FALSE', 'off', 'no', ' 0 ']) {
      process.env[ENV] = v;
      expect(reaperEnabled(), `expected ${JSON.stringify(v)} to disable the sweep`).toBe(false);
    }
  });

  it('stays ON for affirmative values', () => {
    for (const v of ['1', 'true', 'on', 'yes']) {
      process.env[ENV] = v;
      expect(reaperEnabled()).toBe(true);
    }
  });
});

describe('priorRecord — the most-confirmed row wins', () => {
  it('returns null when no routine carries a record', () => {
    expect(priorRecord([row('git-sync', null), row('scout-cycle', null)])).toBeNull();
  });

  it('returns null for an empty group', () => {
    expect(priorRecord([])).toBeNull();
  });

  it('does NOT let a freshly-seeded routine reset a run in progress', () => {
    // The race this rule exists for: without it, a new routine's missing record could reset
    // the count every sweep and a dead pot would never reach its second confirmation.
    const group = [row('newly-seeded', null), row('git-sync', rec(1))];
    expect(priorRecord(group)?.confirmations).toBe(1);
  });

  it('picks the highest confirmation count regardless of row order', () => {
    expect(priorRecord([row('a', rec(1)), row('b', rec(3)), row('c', rec(2))])?.confirmations).toBe(3);
    expect(priorRecord([row('b', rec(3)), row('a', rec(1))])?.confirmations).toBe(3);
  });

  it('ignores a malformed record rather than trusting its shape', () => {
    // metadata is free-form jsonb: anything could be sitting under health.dead_target, and a
    // record whose confirmations is not a number must not be read as a confirmation.
    const junk = [
      row('x', { state: 'root-missing', firstSeenAtMs: 1, lastSeenAtMs: 2 } as unknown as PermanenceRecord),
      row('y', { confirmations: 'two' } as unknown as PermanenceRecord),
    ];
    expect(priorRecord(junk)).toBeNull();
    // ...but a well-formed sibling still wins through.
    expect(priorRecord([...junk, row('z', rec(2))])?.confirmations).toBe(2);
  });
});
