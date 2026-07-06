import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOperatorUrl, resolveOperatorBase, fetchResilient } from '../scripts/operator-discovery.mjs';

/** A deterministic fake clock: sleep() advances virtual time so budget/backoff
 *  logic is exercised without real timers. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const connErr = () => Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const okResp = (): Response => ({ ok: true, status: 200 }) as Response;

// The sidecar CLIs (onboard, tutorial-runner, ptool) must reach the PACKAGED
// desktop operator, which listens on a per-boot dynamic port recorded in
// ~/.papercusp/operator.json — a bare :3070 default only works on the dev box.
// Owner hit the regression live on the seeded mac install (WI-2903 thread):
// "can't reach papercusp server at 127.0.0.1:3070".

const tmpHomes: string[] = [];
function homeWithOperatorJson(content: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'opdisc-'));
  tmpHomes.push(home);
  if (content !== null) {
    mkdirSync(join(home, '.papercusp'), { recursive: true });
    writeFileSync(join(home, '.papercusp', 'operator.json'), content);
  }
  return home;
}

afterEach(() => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('discoverOperatorUrl', () => {
  it('returns httpUrl from operator.json (the packaged-desktop path)', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114', port: 20114 }));
    expect(discoverOperatorUrl({ home })).toBe('http://127.0.0.1:20114');
  });

  it('falls back to port when httpUrl is absent', () => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    expect(discoverOperatorUrl({ home })).toBe('http://127.0.0.1:20114');
  });

  it('returns null when operator.json is missing (the dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(discoverOperatorUrl({ home })).toBeNull();
  });

  it('returns null on unparseable operator.json', () => {
    const home = homeWithOperatorJson('not json');
    expect(discoverOperatorUrl({ home })).toBeNull();
  });
});

describe('resolveOperatorBase precedence', () => {
  it('explicit --operator-url arg wins over everything', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(
      resolveOperatorBase({ operatorUrl: 'http://x:1/' }, { PAPERCUSP_OPERATOR_URL: 'http://y:2' }, { home }),
    ).toBe('http://x:1');
  });

  it('env override beats operator.json discovery', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://y:2/' }, { home })).toBe('http://y:2');
  });

  it('operator.json discovery beats the :3070 dev fallback', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:20114');
  });

  it('lands on :3070 only when nothing else resolves (dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:3070');
  });
});

// WI-3141: the onboarding/tutorial launchers must ride THROUGH the operator's
// first-boot / recycle window (owner 2026-07-05: "3 attempts before the tutorial
// showed up") instead of hard-failing on the first connection-refused.
describe('fetchResilient', () => {
  it('returns immediately on success (no retry, no sleep)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    let slept = 0;
    const r = await fetchResilient('http://x', {}, {
      fetchImpl: async () => { calls++; return okResp(); },
      now,
      sleep: async (ms: number) => { slept++; await sleep(ms); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  it('rides through N connection failures then succeeds (the cold-start case)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    const onRetry = vi.fn();
    const r = await fetchResilient('http://x', {}, {
      fetchImpl: async () => { calls++; if (calls <= 3) throw connErr(); return okResp(); },
      now,
      sleep,
      onRetry,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(4); // 3 refused + 1 success
    expect(onRetry).toHaveBeenCalledTimes(1); // announced exactly once
  });

  it('throws once the connect budget is exhausted (genuine outage)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    await expect(
      fetchResilient('http://x', {}, {
        fetchImpl: async () => { calls++; throw connErr(); },
        now,
        sleep,
        connectBudgetMs: 5_000, // 2s backoff each → ~3 attempts then budget spent
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBeGreaterThan(1); // it retried before giving up
  });

  it('retries a timeout only timeoutRetries times, then throws', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    await expect(
      fetchResilient('http://x', {}, {
        fetchImpl: async () => { calls++; throw timeoutErr(); },
        now,
        sleep,
        timeoutRetries: 2,
      }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('does NOT retry when the caller-supplied signal aborted (owns the lifetime)', async () => {
    const { now, sleep } = fakeClock();
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      fetchResilient('http://x', { signal: ac.signal }, {
        fetchImpl: async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
        now,
        sleep,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // no retry — the caller's abort is final
  });
});
