import { describe, expect, it } from 'vitest';
import { gateClaimCarryLint } from './gate-claim-carry-lint';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['a/failing.test.ts'],
  updatedAtMs: 1,
};

describe('gateClaimCarryLint (P-007)', () => {
  it('flags a gate-progress claim written into a carry note while frozen', () => {
    const lint = gateClaimCarryLint('## Did\nFixed 7 gate reds and verified them green.', { marker });
    expect(lint?.flagged).toBe(true);
    expect(lint?.judgedSha).toBe(marker.repairHead);
    expect(lint?.matches[0]).toContain('Fixed 7 gate reds');
  });

  it('points at the offending LINE, not the whole note', () => {
    const lint = gateClaimCarryLint(
      ['## Did', 'Refactored the sync resolver.', 'The gate is green now.', 'Ran the tests.'].join('\n'),
      { marker },
    );
    expect(lint?.matches).toEqual(['The gate is green now.']);
  });

  it('is SILENT when nothing is frozen — an ordinary commit IS the judged lineage', () => {
    expect(gateClaimCarryLint('Fixed 7 gate reds', { marker: null })).toBeUndefined();
  });

  it('is silent on a carry note that makes no gate claim', () => {
    expect(
      gateClaimCarryLint('## Did\nRefactored the resolver and added tests.', { marker }),
    ).toBeUndefined();
  });

  it('is silent on red-state observations, identifiers, and quoted explanations', () => {
    const text = [
      'P-005 still blocked: positions.deployed FALSE; Gate red 94.',
      'The check id `gate-reds-mostly-unowned` is data, not a gate claim.',
      'The detector says "Gate red 94" matches like "greened the gate".',
    ].join('\n');
    expect(gateClaimCarryLint(text, { marker })).toBeUndefined();
  });

  it('is silent on the original RED/conditional false-positive examples', () => {
    const text = [
      'WI-212675 is OPEN; remedy lifts itself when the gate greens. Gate ownership is held-live.',
      'Do not re-send the owner report before 18:44Z; await escalation:resolved.',
      'Two items are deferred until the gate greens during a non-repair freeze. Gate ops NOT mine.',
      'Four filings remain open and all are deferred until the gate greens.',
    ].join('\n');
    expect(gateClaimCarryLint(text, { marker })).toBeUndefined();
  });

  it('reports the mutable admitted repairHead separately from the immutable candidate', () => {
    const admitted = { ...marker, repairHead: 'a'.repeat(40) };
    const lint = gateClaimCarryLint('Fixed 1 gate red', { marker: admitted });
    expect(lint).toMatchObject({
      candidate: marker.candidate,
      judgedSha: admitted.repairHead,
    });
    expect(lint?.judgedSha).not.toBe(lint?.candidate);
  });

  it('is silent on empty or blank text', () => {
    expect(gateClaimCarryLint('', { marker })).toBeUndefined();
    expect(gateClaimCarryLint('   \n  ', { marker })).toBeUndefined();
    expect(gateClaimCarryLint(null, { marker })).toBeUndefined();
    expect(gateClaimCarryLint(undefined, { marker })).toBeUndefined();
  });

  it('caps the reported matches so a long note cannot flood the response', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Fixed ${i} gate reds`).join('\n');
    expect(gateClaimCarryLint(text, { marker })?.matches.length).toBe(5);
  });

  it('names the judged sha and the sanctioned command in its note', () => {
    const lint = gateClaimCarryLint('the gate is green', { marker });
    expect(lint?.note).toContain("op:'admit'");
    expect(lint?.note).toContain('judged sha');
  });
});
