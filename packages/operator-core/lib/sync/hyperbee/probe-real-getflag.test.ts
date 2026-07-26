// SCRATCH PROBE v3 — delete before commit.
// v2 established: getFlag does NOT hang (cold cache, 0ms); potHomeSlugForHarness DOES.
// v3 narrows inside potHomeSlugForHarness and tests the candidate general fix.
import { describe, it, expect, vi, afterEach } from 'vitest';

const PRISTINE_SET_TIMEOUT = globalThis.setTimeout;

const hatch = <T>(p: Promise<T>, ms: number, label: T) =>
  Promise.race([
    p,
    new Promise<T>((res) => {
      PRISTINE_SET_TIMEOUT(() => res(label), ms);
    }),
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe('narrowing + candidate fix', () => {
  it('E. fake timers: loadHarnessRegistry (the first await inside potHomeSlugForHarness)', async () => {
    const { loadHarnessRegistry } = await import('../../harness-registry');
    vi.useFakeTimers();
    const v = await hatch(
      loadHarnessRegistry('papercusp-workspace').then(
        (r) => `resolved:${r.projects.length} projects`,
        (e) => `rejected:${e instanceof Error ? e.message : String(e)}`,
      ),
      4000,
      'HUNG',
    );
    console.info('E. loadHarnessRegistry VERDICT:', v);
    expect(v).not.toBe('HUNG');
  });

  it('F. CANDIDATE FIX — useFakeTimers({ shouldAdvanceTime: true }): potHomeSlugForHarness', async () => {
    const { potHomeSlugForHarness } = await import('../../hive-federation');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const v = await hatch(
      potHomeSlugForHarness('papercusp-workspace', 'papercusp').then(
        (s) => `resolved:${String(s)}`,
        (e) => `rejected:${e instanceof Error ? e.message : String(e)}`,
      ),
      8000,
      'HUNG',
    );
    console.info('F. shouldAdvanceTime potHomeSlug VERDICT:', v);
    expect(v).not.toBe('HUNG');
  });

  it('G. CANDIDATE FIX — shouldAdvanceTime: full buildHiveRekeyBootDeps', async () => {
    const { buildHiveRekeyBootDeps } = await import('./hive-epoch-boot-deps');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const v = await hatch(
      buildHiveRekeyBootDeps({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' }).then(
        (d) => `resolved:${d == null ? 'null' : 'deps'}`,
        (e) => `rejected:${e instanceof Error ? e.message : String(e)}`,
      ),
      20000,
      'HUNG',
    );
    console.info('G. shouldAdvanceTime bootDeps VERDICT:', v);
    expect(v).not.toBe('HUNG');
  });

  it('H. does shouldAdvanceTime still let a test CONTROL time? (fix must not break the point of fake timers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fired: string[] = [];
    setTimeout(() => fired.push('t60s'), 60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    console.info('H. advanceTimersByTime with shouldAdvanceTime:', JSON.stringify(fired));
    expect(fired).toEqual(['t60s']);
  });
});
