/**
 * directive-effect-read.test.ts — P-013 read half.
 *
 * As in directive-effect.test.ts, the fixture is the REAL envelope-row shape the SQL
 * selects (bigint `ts_ms` as a string, `effect` as raw jsonb), so a column rename
 * reds these tests instead of silently folding `undefined`.
 */
import { describe, it, expect } from 'vitest';
import {
  parseEffectStamp,
  envelopeRowsToSpecs,
  type DirectiveEffectEnvelopeRow,
} from './directive-effect-read';

const TS = Date.UTC(2026, 7, 1, 12, 0, 0);

function envRow(over: Partial<DirectiveEffectEnvelopeRow> = {}): DirectiveEffectEnvelopeRow {
  return {
    recipient: 'su-member',
    from_id: 'su-leader',
    msg_id: 'm-1',
    ts_ms: String(TS),
    effect: { kind: 'checkpoint', itemId: 'WI-100' },
    ...over,
  };
}

describe('parseEffectStamp', () => {
  it('parses a well-formed stamp', () => {
    expect(parseEffectStamp({ kind: 'checkpoint', itemId: 'WI-1' })).toEqual({
      kind: 'checkpoint',
      itemId: 'WI-1',
    });
  });

  it('carries the harness through when present', () => {
    expect(parseEffectStamp({ kind: 'terminal', itemId: 'WI-1', harness: 'papercusp' })).toEqual({
      kind: 'terminal',
      itemId: 'WI-1',
      harness: 'papercusp',
    });
  });

  it('SKIPS an unrecognised kind rather than guessing', () => {
    // The forward/backward-compat rail: a stamp from a different sender version must
    // produce no verdict at all, never a confident verdict about an undeclared effect.
    expect(parseEffectStamp({ kind: 'lock-taken', itemId: 'WI-1' })).toBeNull();
  });

  it('rejects a missing/blank itemId', () => {
    expect(parseEffectStamp({ kind: 'checkpoint' })).toBeNull();
    expect(parseEffectStamp({ kind: 'checkpoint', itemId: '   ' })).toBeNull();
  });

  it('rejects non-object shapes without throwing', () => {
    for (const bad of [null, undefined, 'checkpoint', 42, ['checkpoint'], true]) {
      expect(parseEffectStamp(bad)).toBeNull();
    }
  });
});

describe('envelopeRowsToSpecs', () => {
  it('groups by recipient and coerces the bigint timestamp', () => {
    const map = envelopeRowsToSpecs([
      envRow({ recipient: 'a', msg_id: 'm-1' }),
      envRow({ recipient: 'a', msg_id: 'm-2', effect: { kind: 'terminal', itemId: 'WI-9' } }),
      envRow({ recipient: 'b', msg_id: 'm-3' }),
    ]);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
    expect(map.get('a')).toHaveLength(2);
    expect(map.get('a')?.[0]).toMatchObject({ kind: 'checkpoint', itemId: 'WI-100', sentAtMs: TS, msgId: 'm-1' });
    expect(map.get('a')?.[1]).toMatchObject({ kind: 'terminal', itemId: 'WI-9' });
  });

  it('drops rows whose stamp does not parse', () => {
    const map = envelopeRowsToSpecs([envRow({ effect: { kind: 'nope', itemId: 'WI-1' } })]);
    expect(map.size).toBe(0);
  });

  it('drops rows with an unusable timestamp — an undatable directive has no baseline', () => {
    for (const ts of ['', 'not-a-number', '0', String(-1)]) {
      expect(envelopeRowsToSpecs([envRow({ ts_ms: ts })]).size).toBe(0);
    }
  });

  it('accepts an already-numeric timestamp too', () => {
    const map = envelopeRowsToSpecs([envRow({ ts_ms: TS })]);
    expect(map.get('su-member')?.[0]?.sentAtMs).toBe(TS);
  });
});
