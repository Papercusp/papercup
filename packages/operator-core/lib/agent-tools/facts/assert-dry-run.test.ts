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
import type { AgentFact, AssertFactInput, AssertFactResult, FactCapPreview } from '../../agent-facts/store';

const assertFactSpy = vi.hoisted(() => vi.fn<(input: AssertFactInput) => Promise<AssertFactResult>>());
const factVersionsSpy = vi.hoisted(() => vi.fn());
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
    factVersions: factVersionsSpy,
    previewFactCapImpact: previewSpy,
    resolveFactFederationSlug: resolveFactFederationSlugSpy,
  };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: boundedTxnHarness.boundedOrgTxn }));

import assertTool, { OVERWROTE_AUTHOR_EXCERPT_CHARS } from './assert';

const ctx = { isSuperuser: true, uiClientId: 'su-test-dry-run' } as never;

function payloadOf(result: Awaited<ReturnType<typeof assertTool.handler>>): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

// P-002 / D-003: an EVICTING preview is now specifically a VOLATILE-partition
// one — the ordinary partition refuses at its ceiling and destroys nothing, so
// `wouldEvict` there is always empty (see PREVIEW_REFUSED below). This fixture
// keeps exercising the eviction-reporting pass-through, which remains live for
// volatile writes.
const PREVIEW: FactCapPreview = {
  scope: 'owner',
  scopeRef: 'su-test-dry-run',
  populationSize: 200,
  cap: 200,
  atCap: true,
  replacesExistingKey: false,
  exempt: false,
  wouldRefuse: false,
  wouldEvict: [
    {
      key: 'a-peers-finding',
      confidence: 'verified',
      expiresAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'su-somebody-else',
      // EI-21393210182770949: the preview carries the same bounded body excerpt
      // the real eviction reports, so a caller can judge what a write would cost
      // before making it — not just which keys it would name.
      bodyExcerpt: 'a peer measured this and it is not yet acted on',
      bodyTruncated: false,
    },
  ],
  survival: { rank: 200, liveCount: 200, nextVictim: true, survivingFractionFloor: 0.9 },
  raceCaveat: 'FORECAST, NOT A RESERVATION',
};

/**
 * P-002 / D-003: what an ORDINARY at-ceiling preview looks like now — the write
 * is refused, so there is no victim and no survival rank. Note `wouldEvict: []`
 * and `survival: null` are not omissions here; they are the answer.
 */
const PREVIEW_REFUSED: FactCapPreview = {
  scope: 'owner',
  scopeRef: 'su-test-dry-run',
  populationSize: 5000,
  cap: 5000,
  atCap: true,
  replacesExistingKey: false,
  exempt: false,
  wouldRefuse: true,
  wouldEvict: [],
  survival: null,
  raceCaveat: 'FORECAST, NOT A RESERVATION',
};

const writtenFact = (overrides: Partial<AgentFact> = {}): AgentFact => ({
  scope: 'owner',
  scopeRef: 'su-test-dry-run',
  key: 'k',
  body: 'new body',
  confidence: null,
  measurement: null,
  kind: null,
  dependsOn: [],
  claim: null,
  enforcement: null,
  sourceRef: null,
  audienceScope: null,
  sourceProvenance: null,
  createdBy: 'su-test-dry-run',
  updatedAt: '2026-01-02T00:00:00.000Z',
  expiresAt: '2026-01-09T00:00:00.000Z',
  ...overrides,
});

describe('facts:assert { dryRun } — forecasts the cap cost without writing', () => {
  beforeEach(() => {
    assertFactSpy.mockReset();
    assertFactSpy.mockRejectedValue(
      // A dryRun that reaches the write is the defect this file exists to catch,
      // so make that path fail LOUDLY and specifically rather than quietly
      // returning a plausible row that the payload assertions would accept.
      new Error('assertFact must NOT be called on a dryRun'),
    );
    factVersionsSpy.mockReset();
    factVersionsSpy.mockResolvedValue([]);
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

  it('reports an ORDINARY ceiling as a REFUSAL, naming no victim (P-002 / D-003)', async () => {
    // The whole point of D-003 is that an ordinary at-cap write costs the WRITER
    // a refusal instead of costing a stranger their fact. That inversion is only
    // actionable if it survives the trip to the caller: a preview that still
    // said "you would destroy these" would send a caller looking for a peer to
    // coordinate with over a write that simply will not land.
    previewSpy.mockResolvedValue(PREVIEW_REFUSED);

    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: 'k', body: 'b', dryRun: true } as never,
      ctx,
    );

    expect(assertFactSpy).not.toHaveBeenCalled();
    const payload = payloadOf(result);
    expect(payload.wrote).toBe(false);
    expect(payload.wouldRefuse).toBe(true);
    // Nothing dies. Asserted as the concrete empty/null rather than "falsy", so
    // dropping the field entirely from the payload cannot pass this.
    expect(payload.wouldEvict).toEqual([]);
    expect(payload.survival).toBeNull();
    expect(payload.atCap).toBe(true);
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

  it('rejects a malformed scope ref before dryRun can return a false green', async () => {
    await expect(
      assertTool.handler(
        {
          scope: 'owner',
          scopeRef: 'EI-23119165509578289',
          key: 'k',
          body: 'b',
          dryRun: true,
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/cannot be a 'owner' reference/);

    expect(previewSpy).not.toHaveBeenCalled();
    expect(assertFactSpy).not.toHaveBeenCalled();
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

  it('returns a loud, bounded receipt when the write replaces another author\'s version', async () => {
    const prior = writtenFact({
      id: 1,
      createdBy: 'su-peer',
      updatedAt: '2026-01-01T00:00:00.000Z',
      body: `Correct owner-gated diagnosis ${'x'.repeat(400)}`,
    });
    const current = writtenFact({ id: 2, supersedesId: 1 });
    assertFactSpy.mockResolvedValue(current);
    factVersionsSpy.mockResolvedValue([current, prior]);

    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: 'k', body: 'replacement' } as never,
      ctx,
    );

    expect(factVersionsSpy).toHaveBeenCalledWith({
      scope: 'owner',
      scopeRef: 'su-test-dry-run',
      key: 'k',
      limit: 8,
    });
    const payload = payloadOf(result);
    expect(payload.overwroteAuthor).toMatchObject({
      ownerId: 'su-peer',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const disclosure = payload.overwroteAuthor as { bodyExcerpt: string; note: string };
    expect(disclosure.bodyExcerpt.length).toBeLessThanOrEqual(OVERWROTE_AUTHOR_EXCERPT_CHARS);
    expect(disclosure.bodyExcerpt).toContain('Correct owner-gated diagnosis');
    expect(disclosure.note).toMatch(/CROSS-AUTHOR OVERWRITE/);
  });

  it('does not warn when a writer re-asserts its own predecessor', async () => {
    const prior = writtenFact({ id: 1 });
    const current = writtenFact({ id: 2, supersedesId: 1 });
    assertFactSpy.mockResolvedValue(current);
    factVersionsSpy.mockResolvedValue([current, prior]);

    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test-dry-run', key: 'k', body: 'replacement' } as never,
      ctx,
    );

    expect(payloadOf(result).overwroteAuthor).toBeUndefined();
  });

  it('passes supersedes to the store and keeps the actual retired keys in the write receipt, not the fact', async () => {
    assertFactSpy.mockResolvedValue({
      ...writtenFact({ key: 'incident-settled' }),
      retiredKeys: ['incident-a', 'incident-b'],
    });

    const result = await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test-dry-run',
        key: 'incident-settled',
        body: 'one corrected incident conclusion',
        supersedes: ['incident-b', 'incident-a'],
      } as never,
      ctx,
    );

    expect(assertFactSpy.mock.calls[0][0].supersedes).toEqual(['incident-b', 'incident-a']);
    const payload = payloadOf(result) as {
      fact: Record<string, unknown>;
      retired: { keys: string[]; note: string };
    };
    expect(payload.retired.keys).toEqual(['incident-a', 'incident-b']);
    expect(payload.retired.note).toContain('same transaction');
    expect(payload.retired.note).toContain('superseded by incident-settled');
    expect(payload.fact.retiredKeys).toBeUndefined();
  });
});
