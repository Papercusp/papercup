/**
 * facts:assert { dryRun } — the eviction cap's look-before-you-leap surface
 * (EI-20515478467800187).
 *
 * The STORE-level guards in agent-facts/store.integration.test.ts prove the
 * forecast is CORRECT (it predicts the row the real sweep then destroys). This
 * file proves the WIRING, which is a different claim and the one that can
 * regress silently: that `dryRun:true` short-circuits BEFORE the write.
 *
 * Why it needs its own test rather than trusting a read of the handler: the
 * dryRun branch sits a few lines above `assertFact`, and any later edit that
 * moves, reorders, or wraps that block would leave a tool whose response still
 * SAYS `wrote:false` while having written. A response field asserting its own
 * innocence is exactly the thing that must be checked against behaviour instead
 * of trusted — so the load-bearing assertion here is on the assertFact SPY, not
 * on the payload.
 *
 * ⚠ The store is mocked, so this file says nothing about whether the forecast
 * is right. Do not read a green here as "dryRun works" — read it as "dryRun
 * does not write".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput, FactCapPreview } from '../../agent-facts/store';

const assertFactSpy = vi.hoisted(() => vi.fn<(input: AssertFactInput) => Promise<AgentFact>>());
const previewSpy = vi.hoisted(() => vi.fn<(input: AssertFactInput) => Promise<FactCapPreview>>());
const resolveFactFederationSlugSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const boundedTxnHarness = vi.hoisted(() => {
  const boundedTx = { query: vi.fn(), marker: 'bounded-org-txn' };
  return {
    boundedTx,
    boundedOrgTxn: vi.fn(async (fn: (tx: typeof boundedTx) => Promise<unknown>) => fn(boundedTx)),
  };
});

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  // Spread the real module — the tool imports clampFactBody / resolveFactScopeRef
  // / FACT_SCOPES and the cap constants from here too. Only the two IO paths are
  // replaced, so the handler's own branching runs for real.
  return {
    ...actual,
    assertFact: assertFactSpy,
    previewFactCapImpact: previewSpy,
    resolveFactFederationSlug: resolveFactFederationSlugSpy,
  };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: boundedTxnHarness.boundedOrgTxn }));

import assertTool from './assert';

const ctx = { isSuperuser: true, uiClientId: 'su-test-dry-run' } as never;

function payloadOf(result: Awaited<ReturnType<typeof assertTool.handler>>): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

const PREVIEW: FactCapPreview = {
  scope: 'owner',
  scopeRef: 'su-test-dry-run',
  populationSize: 200,
  cap: 200,
  atCap: true,
  replacesExistingKey: false,
  exempt: false,
  wouldEvict: [
    {
      key: 'a-peers-finding',
      confidence: 'verified',
      expiresAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'su-somebody-else',
    },
  ],
  survival: { rank: 200, liveCount: 200, nextVictim: true, survivingFractionFloor: 0.9 },
  raceCaveat: 'FORECAST, NOT A RESERVATION',
};

describe('facts:assert { dryRun } — forecasts the cap cost without writing', () => {
  beforeEach(() => {
    assertFactSpy.mockReset();
    assertFactSpy.mockRejectedValue(
      // A dryRun that reaches the write is the defect this file exists to catch,
      // so make that path fail LOUDLY and specifically rather than quietly
      // returning a plausible row that the payload assertions would accept.
      new Error('assertFact must NOT be called on a dryRun'),
    );
    previewSpy.mockReset();
    previewSpy.mockResolvedValue(PREVIEW);
    resolveFactFederationSlugSpy.mockReset();
    resolveFactFederationSlugSpy.mockResolvedValue(null);
    boundedTxnHarness.boundedOrgTxn.mockReset();
    boundedTxnHarness.boundedOrgTxn.mockImplementation(async (fn) => fn(boundedTxnHarness.boundedTx));
  });

  it('does NOT write, and returns the victim the write would have destroyed', async () => {
    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: 'k', body: 'b', dryRun: true } as never,
      ctx,
    );

    // ── THE LOAD-BEARING ASSERTION ─────────────────────────────────────────
    // Behaviour, not self-report: the write path was never entered.
    expect(assertFactSpy).not.toHaveBeenCalled();
    expect(previewSpy).toHaveBeenCalledTimes(1);

    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.wrote).toBe(false);
    // The actionable half: WHOSE fact, and how strong — "am I about to cost a
    // peer a verified finding?" is the decision this surface informs.
    expect(payload.wouldEvict).toEqual(PREVIEW.wouldEvict);
    expect(payload.survival).toEqual(PREVIEW.survival);
    // The honesty field must reach the caller — a forecast presented as a
    // reservation is worse than no forecast.
    expect(String(payload.raceCaveat)).toContain('NOT A RESERVATION');
  });

  it('the preview is scoped to the SAME resolved fact the write would have used', async () => {
    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: '  spaced-key  ', body: 'b', dryRun: true } as never,
      ctx,
    );

    // Forecasting a DIFFERENT key than the write would use is a silent wrong
    // answer, so pin that the handler passes its fully-resolved input through
    // (the key is trimmed by the same path the write uses).
    const passed = previewSpy.mock.calls[0][0];
    expect(passed.key.trim()).toBe('spaced-key');
    expect(passed.scope).toBe('owner');
    expect(passed.scopeRef).toBe('su-test-dry-run');
  });

  it('WITHOUT dryRun the write still happens — the branch is opt-in, not a new default', async () => {
    // The control. Without it, "dryRun does not write" would also pass for a
    // handler that had stopped writing altogether.
    assertFactSpy.mockReset();
    assertFactSpy.mockImplementation(
      async (input) =>
        ({
          scope: input.scope,
          scopeRef: input.scopeRef ?? null,
          key: input.key,
          body: input.body,
          confidence: null,
          measurement: null,
          kind: null,
          dependsOn: [],
          claim: null,
          enforcement: null,
          sourceRef: null,
          audienceScope: null,
          sourceProvenance: null,
          createdBy: input.createdBy,
          updatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-08T00:00:00.000Z',
        }) as unknown as AgentFact,
    );

    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: 'k', body: 'b' } as never,
      ctx,
    );

    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(previewSpy).not.toHaveBeenCalled();
  });
});
