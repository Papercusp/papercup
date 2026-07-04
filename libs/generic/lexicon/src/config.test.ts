import { afterEach, describe, expect, it } from 'vitest';
import {
  activePackId,
  configureLexicon,
  isLexiconConfigured,
  term,
} from './config';

// The host lives on a process-global symbol; reset between tests so order
// doesn't matter.
const HOST_KEY = Symbol.for('@papercusp/lexicon:host');
function reset(): void {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
}
afterEach(reset);

describe('configureLexicon / ambient resolution', () => {
  it('defaults to classic when unconfigured (never throws)', () => {
    reset();
    expect(isLexiconConfigured()).toBe(false);
    expect(activePackId()).toBe('classic');
    expect(term('pot')).toBe('Pot');
  });

  it('resolves against the wired pack', () => {
    configureLexicon({ activePackId: () => 'the-hive' });
    expect(isLexiconConfigured()).toBe(true);
    expect(activePackId()).toBe('the-hive');
    expect(term('pot')).toBe('Hive');
    expect(term('fleet', { plural: true })).toBe('Colonies');
  });

  it('reflects a live selector change (flag flip)', () => {
    let on = false;
    configureLexicon({ activePackId: () => (on ? 'the-hive' : 'classic') });
    // classic/public = the Papercup cup-character cast (restore-pot-lexicon D-006)
    expect(term('operator')).toBe('Papercup');
    expect(term('brain')).toBe('Mug');
    expect(term('overwatch')).toBe('Kettle');
    expect(term('scout')).toBe('Blender');
    on = true;
    // the-hive keeps the bee-theme role names
    expect(term('operator')).toBe('Sentinel'); // renamed from "Sentinel Bee" (hive-agent-tabs P-003)
    expect(term('brain')).toBe('Queen');
    expect(term('overwatch')).toBe('Overwatch');
    expect(term('scout')).toBe('Scout');
    expect(term('human', { plural: true })).toBe('Keepers');
  });

  it('falls back to classic if the selector throws', () => {
    configureLexicon({
      activePackId: () => {
        throw new Error('boom');
      },
    });
    expect(activePackId()).toBe('classic');
    expect(term('pot')).toBe('Pot');
  });
});
