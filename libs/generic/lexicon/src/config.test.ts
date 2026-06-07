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
    expect(term('fleet', { plural: true })).toBe('Swarms');
  });

  it('reflects a live selector change (flag flip)', () => {
    let on = false;
    configureLexicon({ activePackId: () => (on ? 'the-hive' : 'classic') });
    expect(term('operator')).toBe('Operator');
    on = true;
    expect(term('operator')).toBe('Sentinel Bee');
    expect(term('brain')).toBe('Queen');
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
