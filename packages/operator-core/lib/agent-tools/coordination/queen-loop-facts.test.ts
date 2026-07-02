/**
 * Unit tests for queen-loop-facts — withholding queen-loop steering from
 * OWNER-DIRECTED (responsive) orients (queen-fleet-authority-boundary P-002 / D-001).
 */
import { describe, it, expect } from 'vitest';
import {
  isQueenLoopControlText,
  withholdQueenLoopControl,
  QUEEN_LOOP_FACT_KEY_PREFIX,
} from './queen-loop-facts';

describe('isQueenLoopControlText (P-002)', () => {
  it('matches the reserved queen-loop: key namespace regardless of body', () => {
    expect(isQueenLoopControlText({ key: `${QUEEN_LOOP_FACT_KEY_PREFIX}pause`, body: 'anything' })).toBe(true);
    expect(isQueenLoopControlText({ key: 'queen-loop:maxbees', body: '' })).toBe(true);
  });

  it('matches the steering vocabulary in a body (the ad-hoc harness-fact leak)', () => {
    for (const body of [
      'Owner steering flipped: pauseNewWork=true, maxBees=3. Place NO new bees while it holds.',
      'maxBees=3 in effect',
      'the hive is paused until 22:00',
      'pausedUntil set by owner',
      'pausing the hive; drive existing placements to terminal',
      'new-work paused (scopeFilter)',
    ]) {
      expect(isQueenLoopControlText({ body })).toBe(true);
    }
  });

  it('does NOT match ordinary work facts (no false positives)', () => {
    for (const body of [
      'WI-1439 is owner-residue, exclude it from the frontier',
      'prefers nuqs over useState for user-meaningful state',
      'the release checkpoint FFs main hourly',
      'bee count looks healthy',
    ]) {
      expect(isQueenLoopControlText({ body })).toBe(false);
    }
    expect(isQueenLoopControlText({ key: 'plan:P-001', body: 'ship the guard' })).toBe(false);
    expect(isQueenLoopControlText({})).toBe(false);
  });
});

describe('withholdQueenLoopControl (P-002 / D-001)', () => {
  const facts = [
    { key: 'wi-residue', body: 'WI-1439 is residue' },
    { key: 'steer', body: 'pauseNewWork=true, maxBees=3' },
    { key: 'queen-loop:pause', body: 'hive paused' },
  ];
  const read = (f: { key: string; body: string }) => ({ key: f.key, body: f.body });

  it('a responsive caller has queen-loop control items withheld (both key + vocab)', () => {
    const { kept, withheld } = withholdQueenLoopControl(facts, 'responsive', read);
    expect(kept.map((f) => f.key)).toEqual(['wi-residue']);
    expect(withheld.map((f) => f.key)).toEqual(['steer', 'queen-loop:pause']);
  });

  it('an AUTO caller (the queen-bee loop) keeps every fact — steering governs it', () => {
    const { kept, withheld } = withholdQueenLoopControl(facts, 'auto', read);
    expect(kept).toHaveLength(3);
    expect(withheld).toHaveLength(0);
  });

  it('an unknown/undefined drive mode withholds nothing (safe non-withholding default)', () => {
    expect(withholdQueenLoopControl(facts, undefined, read).withheld).toHaveLength(0);
  });
});
