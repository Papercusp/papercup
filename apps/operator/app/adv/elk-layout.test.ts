import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The point of this module is the CACHE: elkjs is a GWT-transpiled ~1MB bundle, and the
 * reason it was extracted out of DepGraphPanel (rather than copied into the Workflows
 * topology pane) is that one module-scoped promise keeps "instantiated once per session"
 * true ACROSS panes. A copy would have silently paid it twice.
 *
 * So these tests pin the two properties that make that true — the constructor runs once,
 * and the lazy import is not hoisted — because both are invisible in normal use: a second
 * ELK instance produces correct layouts, it just costs another megabyte nobody measures.
 */

const H = vi.hoisted(() => ({ ctorCalls: 0 }));

vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class FakeElk {
    constructor() {
      H.ctorCalls += 1;
    }
    async layout(graph: unknown) {
      return graph;
    }
  },
}));

afterEach(() => {
  vi.resetModules();
  H.ctorCalls = 0;
});

describe('elk-layout — the shared elkjs seam', () => {
  it('constructs ELK exactly once no matter how many panes ask for it', async () => {
    const { getElk } = await import('./elk-layout');
    const first = await getElk();
    const second = await getElk();
    const third = await getElk();
    expect(H.ctorCalls).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('shares one instance across concurrent callers rather than racing two in', async () => {
    // Two panes mounting in the same tick must not each win a construction.
    const { getElk } = await import('./elk-layout');
    const [a, b] = await Promise.all([getElk(), getElk()]);
    expect(H.ctorCalls).toBe(1);
    expect(a).toBe(b);
  });

  it('does not import elkjs until someone actually calls getElk', async () => {
    // D-005 requires elkjs stay out of the initial chunk. If the dynamic import were ever
    // hoisted to a static one, the constructor would run at module-eval time and this
    // would catch it.
    await import('./elk-layout');
    expect(H.ctorCalls).toBe(0);
  });

  it('exposes a left-to-right layered config, which is what the panes rely on', async () => {
    const { ELK_LAYERED_LR_OPTIONS } = await import('./elk-layout');
    expect(ELK_LAYERED_LR_OPTIONS['elk.algorithm']).toBe('layered');
    expect(ELK_LAYERED_LR_OPTIONS['elk.direction']).toBe('RIGHT');
  });

  it('returns an engine whose layout is callable', async () => {
    const { getElk } = await import('./elk-layout');
    const elk = await getElk();
    await expect(elk.layout({ id: 'root' })).resolves.toEqual({ id: 'root' });
  });
});
