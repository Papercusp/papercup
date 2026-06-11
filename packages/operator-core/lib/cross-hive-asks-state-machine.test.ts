/**
 * cross-hive-asks-state-machine.test.ts — the pure ask-ledger state machine
 * (hive-network-surface-2026-06-11 P-002, contract C-1). Proves the legal-edge
 * predicate matches the contract exactly: queued -> sent -> answered | declined;
 * queued | sent -> expired; answered / declined / expired terminal.
 */
import { describe, expect, it } from 'vitest';
import {
  CROSS_HIVE_ASK_STATES,
  CROSS_HIVE_ASK_TRANSITIONS,
  TERMINAL_CROSS_HIVE_ASK_STATES,
  isLegalCrossHiveAskTransition,
  type CrossHiveAskState,
} from './cross-hive-asks-pg';

const LEGAL: ReadonlyArray<[CrossHiveAskState, CrossHiveAskState]> = [
  ['queued', 'sent'],
  ['queued', 'expired'],
  ['sent', 'answered'],
  ['sent', 'declined'],
  ['sent', 'expired'],
];

describe('cross_hive_asks state machine', () => {
  it('accepts exactly the contract edges', () => {
    for (const [from, to] of LEGAL) {
      expect(isLegalCrossHiveAskTransition(from, to)).toBe(true);
    }
  });

  it('rejects every non-contract edge (incl. same-state)', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of CROSS_HIVE_ASK_STATES) {
      for (const to of CROSS_HIVE_ASK_STATES) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(isLegalCrossHiveAskTransition(from, to)).toBe(expected);
      }
    }
  });

  it('forbids skipping sent (queued cannot go straight to answered/declined)', () => {
    expect(isLegalCrossHiveAskTransition('queued', 'answered')).toBe(false);
    expect(isLegalCrossHiveAskTransition('queued', 'declined')).toBe(false);
  });

  it('treats answered / declined / expired as terminal (no outgoing edges)', () => {
    for (const term of TERMINAL_CROSS_HIVE_ASK_STATES) {
      expect(CROSS_HIVE_ASK_TRANSITIONS[term]).toEqual([]);
      for (const to of CROSS_HIVE_ASK_STATES) {
        expect(isLegalCrossHiveAskTransition(term, to)).toBe(false);
      }
    }
  });

  it('same-state is never a forward edge (idempotency is the store layer, not the predicate)', () => {
    for (const s of CROSS_HIVE_ASK_STATES) {
      expect(isLegalCrossHiveAskTransition(s, s)).toBe(false);
    }
  });
});
