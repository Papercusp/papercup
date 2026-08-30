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
 *
 * It also pins `recordFromStamp`, the bridge between the stamp this sweep WRITES (ISO
 * timestamps, for a human reading `routines:list`) and the epoch-ms record the decider READS.
 * That round trip was broken and invisible here until the integration test ran two real
 * sweeps against one real row, so the stored bytes are now asserted verbatim in this fast
 * suite too — a shape divergence should not need a Postgres container to surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { priorRecord, reaperEnabled, recordFromStamp, type RoutineRow } from './dead-target-sweep';
import type { PermanenceRecord } from './dead-target-routine-reaper';

const ENV = 'PAPERCUSP_DEAD_TARGET_REAPER';
const original = process.env[ENV];
afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

function row(name: string, rec: unknown): RoutineRow {
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

  it('reads back the shape the sweep ACTUALLY writes to metadata.health.dead_target', () => {
    // THE REGRESSION THIS EXISTS FOR. `stampHealth` persists a human-readable stamp (ISO
    // timestamps, snake_case) — not the decider's epoch-ms record. While every unit test fed
    // `priorRecord` a hand-built record, writer and reader disagreed silently: the confirming
    // sweep computed `nowMs - undefined` and threw on `new Date(undefined).toISOString()`, so
    // the reaper could never park anything and nothing in this file noticed. Feed it the real
    // stored bytes, verbatim, so the round trip cannot break again without turning red here.
    const stored = {
      state: 'root-missing',
      reason: 'some-pot [ws]: resolved root /tmp/some-pot is confirmed absent',
      path: '/tmp/some-pot',
      confirmations: 1,
      first_seen_at: '2026-08-30T12:00:00.000Z',
      last_seen_at: '2026-08-30T12:00:00.000Z',
      parked: false,
      parked_at: null,
      parked_by: null,
    };
    expect(recordFromStamp(stored)).toEqual({
      state: 'root-missing',
      firstSeenAtMs: Date.parse('2026-08-30T12:00:00.000Z'),
      lastSeenAtMs: Date.parse('2026-08-30T12:00:00.000Z'),
      confirmations: 1,
    });
    expect(priorRecord([row('git-sync', stored)])?.confirmations).toBe(1);
  });

  it('fails CLOSED on a stamp it cannot fully read', () => {
    // Each of these is one field short of usable. A park disables a live install, so an
    // unreadable record must restart the run, never continue one.
    const base = { state: 'root-missing', confirmations: 2, first_seen_at: '2026-08-30T12:00:00.000Z', last_seen_at: '2026-08-30T12:10:00.000Z' };
    expect(recordFromStamp({ ...base, first_seen_at: 'not a date' })).toBeNull();
    expect(recordFromStamp({ ...base, last_seen_at: null })).toBeNull();
    expect(recordFromStamp({ ...base, confirmations: Number.NaN })).toBeNull();
    // Only the two permanent states are ever persisted; anything else is not a run to continue.
    expect(recordFromStamp({ ...base, state: 'ok' })).toBeNull();
    expect(recordFromStamp({ ...base, state: 'unknown' })).toBeNull();
    expect(recordFromStamp(null)).toBeNull();
    expect(recordFromStamp('root-missing')).toBeNull();
    expect(recordFromStamp([base])).toBeNull();
    // ...and the well-formed control still parses, so the assertions above are about the
    // missing field and not about a parser that rejects everything.
    expect(recordFromStamp(base)).toMatchObject({ state: 'root-missing', confirmations: 2 });
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
