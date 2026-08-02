/**
 * P-006 / D-046 — the recall query's human tail.
 *
 * Scope note (context-injection-audit-2026-07-28 method rule, D-041): these are
 * FIXTURE tests, and that is admissible here because every assertion below is
 * about SELECTION and COMPOSITION — which turns are admitted, in what order,
 * under what cap — never about retrieval relevance. The relevance claim for
 * P-006 is measured against the live corpus, not asserted here.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_TAIL_ENTRY_CHARS,
  composeRecallQuery,
  isHumanTurn,
  selectHumanTail,
} from './human-turn-tail';

/** A real cold-wake note's head — the 8,000-char class that motivated D-046's care. */
const coldWake = (nonce: string) =>
  `⟦turn-origin:loop-fire nonce:${nonce}⟧\n` +
  '❄️ COLD LOOP WAKE (fire #64) — your context was just reset to your carry-note. ' +
  'Your prior transcript is GONE; the note below IS your continuity — treat it as ' +
  'your working state and continue from its "Next action".\n' +
  'x'.repeat(8_000);

describe('isHumanTurn', () => {
  it('rejects every papercusp injection origin, however human the speaker column says it is', () => {
    for (const origin of [
      'loop-fire',
      'wake-pump',
      'self-compaction',
      'fleet-kickoff',
      'session-port',
      'watchdog',
      'cli-schedule-wakeup',
      'coord-inject:su-be34c423',
    ]) {
      expect(isHumanTurn(`⟦turn-origin:${origin} nonce:cf0b4ea65a3cd1de⟧\nkeep going`)).toBe(false);
    }
  });

  it('rejects the unenveloped skill-loader preamble the CLI injects', () => {
    expect(isHumanTurn(`Base directory for this skill: ${homedir()}/.papercusp/x`)).toBe(false);
  });

  it('accepts a human turn that merely LOOKS structured — a pasted markdown heading', () => {
    // The discriminator is provenance, not formatting. A `# ` heuristic here
    // would silently eat real owner words.
    expect(isHumanTurn('# my notes\n\nwhy is the agents dropdown slow?')).toBe(true);
  });

  it('does not treat a mid-text envelope as provenance (quoted/relayed content)', () => {
    expect(isHumanTurn('did you see ⟦turn-origin:loop-fire nonce:cf0b4ea65a3cd1de⟧ in the log?')).toBe(
      true,
    );
  });

  it('rejects blank turns', () => {
    expect(isHumanTurn('   \n ')).toBe(false);
  });
});

describe('selectHumanTail', () => {
  it('THE REGRESSION D-046 WARNS ABOUT: wake notes never crowd out the human turns', () => {
    // Newest-first, exactly the shape measured on a live loop-driven session:
    // three 8,000-char cold-wake notes interleaved with short real turns.
    const rows = [
      coldWake('aaaaaaaaaaaaaaaa'),
      'why is it fucking sllwo',
      coldWake('bbbbbbbbbbbbbbbb'),
      'session history loading slow in the agents dropdown',
      coldWake('cccccccccccccccc'),
      'can you look at the operator UI perf',
    ];
    const tail = selectHumanTail(rows);
    expect(tail).toEqual([
      'why is it fucking sllwo',
      'session history loading slow in the agents dropdown',
      'can you look at the operator UI perf',
    ]);
    // The whole point: not one byte of the 24,000 chars of wake chrome got in.
    expect(tail.join('\n')).not.toContain('COLD LOOP WAKE');
  });

  it('returns turns newest-first and stops at the count', () => {
    expect(selectHumanTail(['d', 'c', 'b', 'a'], 3)).toEqual(['d', 'c', 'b']);
  });

  it('caps each entry, so a misclassified or pasted monster cannot dominate', () => {
    const huge = 'z'.repeat(50_000);
    const [entry] = selectHumanTail([huge], 1);
    expect(entry).toHaveLength(HUMAN_TAIL_ENTRY_CHARS);
  });

  it('excludes the current prompt, which the ~1min ingest lag can already have landed', () => {
    const rows = ['why is it fucking sllwo', 'the agents dropdown is slow'];
    expect(selectHumanTail(rows, 3, 'why is it fucking sllwo')).toEqual([
      'the agents dropdown is slow',
    ]);
  });

  it('de-duplicates a repeated prompt rather than spending two slots on it', () => {
    expect(selectHumanTail(['continue', 'continue', 'fix the dropdown'], 3)).toEqual([
      'continue',
      'fix the dropdown',
    ]);
  });

  it('returns empty for a session with no human turns at all, rather than admitting chrome', () => {
    expect(selectHumanTail([coldWake('aaaaaaaaaaaaaaaa'), coldWake('bbbbbbbbbbbbbbbb')])).toEqual([]);
  });

  it('strips relayed chrome out of a turn that survives the provenance filter', () => {
    const relayed = '🧪 CARRIED CHECKS — claims + their probes: ' + 'q'.repeat(5_000);
    const [entry] = selectHumanTail([`please fix the dropdown\n${relayed}`], 1);
    expect(entry).toBe('please fix the dropdown');
  });
});

describe('composeRecallQuery', () => {
  it('never returns less of the current prompt than the prompt-only query it replaced', () => {
    const current = 'p'.repeat(1_500);
    const out = composeRecallQuery({ current, tail: ['tail one', 'tail two'], clamp: 1_000 });
    expect(out).toBe('p'.repeat(1_000));
  });

  it('puts the current signal first, then the tail newest-first', () => {
    const out = composeRecallQuery({
      current: 'why is it fucking sllwo',
      tail: ['the agents dropdown is slow', 'look at operator perf'],
      clamp: 1_000,
    });
    expect(out).toBe(
      'why is it fucking sllwo\nthe agents dropdown is slow\nlook at operator perf',
    );
  });

  it('skips an entry that does not fit and keeps trying smaller ones — overflow continues, never breaks', () => {
    const out = composeRecallQuery({
      current: 'head',
      tail: ['A'.repeat(40), 'B'],
      clamp: 20,
    });
    // The oversized entry is truncated into the remaining room; the loop must
    // not abandon the rest of the tail on the first entry that overflows.
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.startsWith('head\n')).toBe(true);
  });

  it('returns the current signal alone when there is no tail', () => {
    expect(composeRecallQuery({ current: 'just this', tail: [], clamp: 1_000 })).toBe('just this');
  });

  it('returns empty for an empty current signal, so recall stays disabled for a blank prompt', () => {
    expect(composeRecallQuery({ current: '   ', tail: ['x'], clamp: 1_000 })).toBe('');
  });
});
