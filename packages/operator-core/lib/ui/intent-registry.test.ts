/**
 * Tests for the browser-side UI intent registry.
 * Run with: cd packages/operator-core && npx vitest run lib/ui/intent-registry.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerIntent, lookupIntent, listIntents } from './intent-registry';

// The registry is a module singleton; collect unregister fns and run them.
const cleanups: Array<() => void> = [];
const track = (off: () => void): (() => void) => {
  cleanups.push(off);
  return off;
};
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('registerIntent / lookupIntent', () => {
  it('registers a handler and looks it up', () => {
    const handler = () => 'ok';
    track(registerIntent('feat:do', handler));
    expect(lookupIntent('feat:do')?.handler).toBe(handler);
  });

  it('defaults builtIn to false; honors opts.builtIn', () => {
    track(registerIntent('feat:a', () => 0));
    track(registerIntent('feat:b', () => 0, { builtIn: true }));
    expect(lookupIntent('feat:a')?.builtIn).toBe(false);
    expect(lookupIntent('feat:b')?.builtIn).toBe(true);
  });

  it('returns undefined for an unknown intent', () => {
    expect(lookupIntent('nope:missing')).toBeUndefined();
  });

  it('listIntents reports every entry with its builtIn flag', () => {
    track(registerIntent('feat:x', () => 0, { builtIn: true }));
    track(registerIntent('feat:y', () => 0));
    const list = listIntents();
    expect(list).toEqual(
      expect.arrayContaining([
        { name: 'feat:x', builtIn: true },
        { name: 'feat:y', builtIn: false },
      ]),
    );
  });
});

describe('unregister (returned disposer)', () => {
  it('removes the entry it registered', () => {
    const off = registerIntent('feat:temp', () => 0);
    expect(lookupIntent('feat:temp')).toBeDefined();
    off();
    expect(lookupIntent('feat:temp')).toBeUndefined();
  });

  it('does NOT remove a newer handler registered under the same name (StrictMode/HMR guard)', () => {
    const h1 = () => 1;
    const off1 = registerIntent('feat:dup', h1);
    const h2 = () => 2;
    track(registerIntent('feat:dup', h2)); // newer handler replaces h1
    off1(); // stale disposer must be a no-op now
    expect(lookupIntent('feat:dup')?.handler).toBe(h2);
  });
});
