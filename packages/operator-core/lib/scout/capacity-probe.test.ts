import { describe, expect, it } from 'vitest';

import { readScoutPoolSnapshot } from './capacity-probe';

/**
 * The AUDIT probe's load-bearing property is the TRISTATE: a failed/unavailable probe is
 * `undefined` — never a fabricated pool state. Collapsing probe-failure into "available"
 * (the ROUTING helper's deliberate fail-open) would let the scheduler's record-time
 * discrimination contradict genuine capacity walls on a dead gateway (WI-5391 Part B).
 */
describe('readScoutPoolSnapshot — tristate gateway pool probe', () => {
  const fetchFor = (stats: unknown, config: unknown, status = 200) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/stats') ? stats : config;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('returns the raw pool numbers when both probes respond', async () => {
    const snapshot = await readScoutPoolSnapshot(
      fetchFor(
        { healthyAccounts: 4, codexHealthyAccounts: 1 },
        { providers: { codex: { configured: true, cliAccountCount: 2 } } },
      ),
    );
    expect(snapshot).toMatchObject({
      healthyAccounts: 4,
      codexHealthyAccounts: 1,
      codexConfigured: true,
      codexCliAccountCount: 2,
    });
    expect(typeof snapshot?.probedAtMs).toBe('number');
  });

  it('omits numeric fields the gateway did not report, instead of fabricating zeros as evidence', async () => {
    const snapshot = await readScoutPoolSnapshot(fetchFor({}, {}));
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty('healthyAccounts');
    expect(snapshot?.codexConfigured).toBe(false);
  });

  it('returns undefined (UNKNOWN) on a non-OK response — never a guessed pool state', async () => {
    await expect(readScoutPoolSnapshot(fetchFor({}, {}, 500))).resolves.toBeUndefined();
  });

  it('returns undefined (UNKNOWN) when the gateway is unreachable', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(readScoutPoolSnapshot(failing)).resolves.toBeUndefined();
  });
});
