/**
 * EI-22986772569543659 — a generic "do not ... until ..." gate is a
 * carry-surface lint warning, not evidence that the OWNER gave the directive.
 * facts:assert must preserve caller-supplied sourceRef/confidence for that
 * shape while continuing to downgrade explicit owner-attribution prose.
 *
 * The store and transaction are mocked so these assertions prove the handler's
 * write payload, rather than relying on a live database or a failed write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput } from '../../agent-facts/store';

const h = vi.hoisted(() => {
  const boundedTx = { query: vi.fn(), marker: 'bounded-org-txn' };
  return {
    assertFact: vi.fn<(input: AssertFactInput, tx?: unknown) => Promise<AgentFact>>(),
    boundedTx,
    boundedOrgTxn: vi.fn(async (fn: (tx: typeof boundedTx) => Promise<AgentFact>) => fn(boundedTx)),
  };
});

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  return { ...actual, assertFact: h.assertFact };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
// The provenance stamp's transcript IO (verifyTurnRefs + resolveCurrentTurnStamp) runs
// under a 3000ms bounded timeout that warns on expiry. Under gate load the real IO
// crossed it and vitest-fail-on-console failed the test (WI-10004913, gate b8eb76cc).
// This test asserts the handler's write payload, not transcript lookup, so stub the IO
// seam: the test is then independent of the timeout budget and of host load.
vi.mock('../../turn-provenance/turn-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../turn-provenance/turn-ref')>()),
  verifyTurnRefs: vi.fn(async () => []),
  resolveCurrentTurnStamp: vi.fn(async () => null),
}));

import assertTool from './assert';

const ctx = { isSuperuser: true, uiClientId: 'su-test-owner-attribution-enforcement' } as never;

function storedFact(input: AssertFactInput): AgentFact {
  return {
    scope: input.scope,
    scopeRef: input.scopeRef ?? null,
    key: input.key,
    body: input.body,
    sourceRef: input.sourceRef ?? null,
    audienceScope: input.audienceScope ?? null,
    sourceProvenance: input.sourceProvenance ?? null,
    confidence: input.confidence ?? null,
    measurement: null,
    kind: input.kind ?? null,
    dependsOn: [...(input.dependsOn ?? [])],
    claim: input.claim ?? null,
    enforcement: input.enforcement ?? null,
    settledBy: input.settledBy ?? null,
    createdBy: input.createdBy,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  } as AgentFact;
}

describe('facts:assert owner-attribution enforcement (EI-22986772569543659)', () => {
  beforeEach(() => {
    h.assertFact.mockReset();
    h.assertFact.mockImplementation(async (input) => storedFact(input));
    h.boundedOrgTxn.mockReset();
    h.boundedOrgTxn.mockImplementation(async (fn) => fn(h.boundedTx));
  });

  it('keeps a bare gate imperative from becoming an owner-turn fact', async () => {
    const result = await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'bare-gate',
        body: 'Do NOT resolve WI-3532 until the UI pass is done.',
        sourceRef: undefined,
        confidence: 'verified',
      } as never,
      ctx,
    );

    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact.mock.calls[0][0]).toMatchObject({
      sourceRef: null,
      confidence: 'verified',
    });
    // The warning remains visible to the caller; only the persistence
    // classification changes.
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(payload.provenanceLint.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'bare-gate-imperative' })]),
    );
    expect(payload.ok).toBe(true);
  });

  it('still downgrades explicit owner-attribution prose', async () => {
    await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'owner-attribution',
        body: 'The owner said to hold off on deploying until Friday.',
        confidence: 'verified',
      } as never,
      ctx,
    );

    expect(h.assertFact.mock.calls[0][0]).toMatchObject({
      sourceRef: 'owner-turn',
      confidence: 'suspected',
      sourceProvenance: {
        kind: 'owner-turn',
        verified: false,
        error: 'owner_attribution_unverified',
      },
    });
  });
});
