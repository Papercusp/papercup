import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput } from '../../agent-facts/store';

const assertFactSpy = vi.hoisted(() =>
  vi.fn<(input: AssertFactInput, inject?: unknown) => Promise<AgentFact>>(),
);

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  return { ...actual, assertFact: assertFactSpy };
});

import assertTool from './assert';

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

describe('facts:assert — reuse the authenticated workspace transaction', () => {
  beforeEach(() => {
    assertFactSpy.mockReset();
    assertFactSpy.mockImplementation(async (input) => storedFact(input));
  });

  it('passes ctx.tx to the store instead of opening a second pool client', async () => {
    const tx = { query: vi.fn() };

    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'tx-reuse', body: 'keep this conclusion' } as never,
      { isSuperuser: true, uiClientId: 'su-test-tx-reuse', tx } as never,
    );

    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][1]).toBe(tx);
  });
});
