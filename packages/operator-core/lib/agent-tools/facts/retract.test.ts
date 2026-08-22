import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retractFactM, findFactKeyMatchesM, findFactKeyElsewhereM, findFactKeyStateM } = vi.hoisted(() => ({
  retractFactM: vi.fn(),
  findFactKeyMatchesM: vi.fn(),
  findFactKeyElsewhereM: vi.fn(),
  findFactKeyStateM: vi.fn(),
}));
vi.mock('../../agent-facts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-facts/store')>()),
  retractFact: retractFactM,
  findFactKeyMatches: findFactKeyMatchesM,
  findFactKeyElsewhere: findFactKeyElsewhereM,
  findFactKeyState: findFactKeyStateM,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-retractor' }),
}));

import tool from './retract';

describe('facts:retract audit metadata', () => {
  beforeEach(() => {
    retractFactM.mockReset().mockResolvedValue(true);
    findFactKeyMatchesM.mockReset().mockResolvedValue([]);
    findFactKeyElsewhereM.mockReset().mockResolvedValue([]);
    findFactKeyStateM.mockReset().mockResolvedValue('not-found');
  });

  it('requires and forwards the retraction reason with the caller identity', async () => {
    const out = await tool.handler(
      { scope: 'workspace', key: 'stale', reason: 'new evidence disproved it' },
      {} as never,
    );
    expect(out).toMatchObject({ data: { ok: true, retracted: true } });
    expect(retractFactM).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeRef: null,
      key: 'stale',
      retractedBy: 'su-retractor',
      reason: 'new evidence disproved it',
    });
  });

  it('accepts a key-only identity when exactly one current fact matches', async () => {
    findFactKeyMatchesM.mockResolvedValueOnce([
      { id: 17, scope: 'owner', scopeRef: 'su-owner', expiresAt: '2026-09-01T00:00:00.000Z' },
    ]);

    const parsed = tool.args.parse({ key: 'release-trace-c89b17b1-20260812', reason: 'release trace is stale' });
    const out = await tool.handler(parsed, {} as never);

    expect(out).toMatchObject({ data: { ok: true, retracted: true } });
    expect(retractFactM).toHaveBeenCalledWith({
      scope: 'owner',
      scopeRef: 'su-owner',
      key: 'release-trace-c89b17b1-20260812',
      retractedBy: 'su-retractor',
      reason: 'release trace is stale',
    });
  });

  it('refuses a key-only identity when the key is ambiguous, without retracting either fact', async () => {
    findFactKeyMatchesM.mockResolvedValueOnce([
      { id: 18, scope: 'owner', scopeRef: 'su-owner', expiresAt: '2026-09-01T00:00:00.000Z' },
      { id: 19, scope: 'harness', scopeRef: 'papercusp', expiresAt: '2026-09-02T00:00:00.000Z' },
    ]);

    const out = await tool.handler(
      { key: 'shared-key', reason: 'new evidence disproved it' },
      {} as never,
    );

    expect(out).toMatchObject({ data: { ok: false, retracted: false, error: 'ambiguous_key' } });
    expect(retractFactM).not.toHaveBeenCalled();
  });

  it('keeps the audit reason required even when scope is resolved from a unique key', () => {
    expect(tool.args.safeParse({ key: 'stale' }).success).toBe(false);
    expect(tool.args.safeParse({ key: 'stale', reason: 'it is no longer true' }).success).toBe(true);
  });

  it.each([
    ['already-retracted', 'a prior retract already removed this fact'],
    ['already-superseded', 'a newer assertion superseded this fact'],
    ['not-found', 'the key was never asserted here'],
  ] as const)('diagnoses a retract miss as %s', async (reason, auditReason) => {
    retractFactM.mockResolvedValueOnce(false);
    findFactKeyStateM.mockResolvedValueOnce(reason);
    const out = await tool.handler(
      { scope: 'workspace', key: 'stale', reason: auditReason },
      {} as never,
    );
    expect(out).toMatchObject({ data: { ok: true, retracted: false, reason } });
  });
});
