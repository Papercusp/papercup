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

  /**
   * WI-38225 — THE REGRESSION THAT MATTERED, and the reason the suite above did not catch it.
   *
   * The live gateway returns `providers` as an ARRAY of `{ id, … }` entries. The probe used to
   * read `config.providers?.codex`, which on a list is `undefined`, so `codexConfigured` was
   * false on EVERY real probe — and because `codexAvailable = codexConfigured && …`, Scout
   * could never select its codex fallback and died whenever the claude pool emptied, with a
   * healthy configured codex account sitting unused.
   *
   * Note the test DIRECTLY ABOVE passes a keyed OBJECT and has always passed. That is precisely
   * how this survived: the fixture encoded a shape the gateway does not emit, so a green suite
   * certified a code path that was broken in production. This case pins the SHAPE THE GATEWAY
   * ACTUALLY RETURNS (captured live 2026-08-12 from /admin/config).
   */
  it('reads codex from the ARRAY shape the gateway actually returns (WI-38225)', async () => {
    const snapshot = await readScoutPoolSnapshot(
      fetchFor(
        { healthyAccounts: 0, codexHealthyAccounts: 1 },
        {
          providers: [
            { id: 'claude', label: 'Claude / Anthropic', configured: true, cliAccountCount: 0 },
            { id: 'codex', label: 'Codex / OpenAI-compatible', configured: true, cliAccountCount: 1 },
            { id: 'omp', label: 'OMP (via Claude / Anthropic)', configured: true, cliAccountCount: 0 },
          ],
        },
      ),
    );
    expect(snapshot).toMatchObject({
      healthyAccounts: 0,
      codexHealthyAccounts: 1,
      codexConfigured: true,
      codexCliAccountCount: 1,
    });
  });

  it('reports codex unconfigured when the ARRAY carries no codex entry — absence is not availability', async () => {
    const snapshot = await readScoutPoolSnapshot(
      fetchFor({ healthyAccounts: 2 }, { providers: [{ id: 'claude', configured: true }] }),
    );
    expect(snapshot?.codexConfigured).toBe(false);
    expect(snapshot).not.toHaveProperty('codexCliAccountCount');
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
