import { describe, it, expect } from 'vitest';
import { TSC_HEAP_MB, withTscHeap, tscHeapEnv } from './tsc-heap';

/**
 * EI-20019651513530828. These pin the NODE_OPTIONS merge for a tsc child.
 *
 * The rule worth guarding is the third one: a SMALLER existing pin is RAISED, not
 * deferred to. Deferring is the intuitive reading ("whoever pinned it knows their
 * box") and it is wrong for this workload — it froze the fleet gate for ~10h across
 * 11 reds when a 4096 cap meant for a FORK POOL was inherited by a whole-program
 * compile that needs 8192 (WI-37450). Any "simplification" back to defer-to-any-pin
 * must fail here.
 */
describe('withTscHeap', () => {
  it('appends the pin when NODE_OPTIONS is empty or absent', () => {
    expect(withTscHeap(undefined)).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
    expect(withTscHeap('')).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
  });

  it('preserves unrelated NODE_OPTIONS flags rather than clobbering them', () => {
    const merged = withTscHeap('--enable-source-maps');
    expect(merged).toContain('--enable-source-maps');
    expect(merged).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
  });

  it('leaves a LARGER existing pin alone — an operator who asked for more wins', () => {
    const bigger = TSC_HEAP_MB * 2;
    expect(withTscHeap(`--max-old-space-size=${bigger}`)).toBe(`--max-old-space-size=${bigger}`);
  });

  it('RAISES a smaller existing pin instead of deferring to it (the WI-37450 correction)', () => {
    const smaller = Math.floor(TSC_HEAP_MB / 2);
    const merged = withTscHeap(`--enable-source-maps --max-old-space-size=${smaller}`);
    expect(merged).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
    // Rewritten IN PLACE — never a second copy, which would depend on last-wins.
    expect(merged.match(/--max-old-space-size/g)).toHaveLength(1);
    expect(merged).not.toContain(`--max-old-space-size=${smaller}`);
    expect(merged).toContain('--enable-source-maps');
  });

  it('accepts the space-separated spelling too', () => {
    const smaller = Math.floor(TSC_HEAP_MB / 2);
    expect(withTscHeap(`--max-old-space-size ${smaller}`)).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
  });

  it('is idempotent — re-merging its own output changes nothing', () => {
    const once = withTscHeap('');
    expect(withTscHeap(once)).toBe(once);
  });

  it('defaults to 8192, matching scripts/lib/tsc-baseline-gate.mjs', () => {
    // The two application points are separate modules by necessity (.mjs script vs
    // compiled TS) but must not disagree on the number. If you change one, change both.
    if (!process.env.PAPERCUSP_TSC_HEAP_MB) expect(TSC_HEAP_MB).toBe(8192);
  });

  it('tscHeapEnv returns just the NODE_OPTIONS overlay', () => {
    expect(tscHeapEnv('')).toEqual({ NODE_OPTIONS: `--max-old-space-size=${TSC_HEAP_MB}` });
  });
});
