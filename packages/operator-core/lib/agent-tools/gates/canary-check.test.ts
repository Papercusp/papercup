/**
 * canary-check.test.ts — gates:canary-check tool envelope
 * (fleet-reliability-verification-2026-07-10 P-011).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-canary', ownerLabel: 'c', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-x' }));
const isRegisteredHiveMock = vi.fn(async () => true);
vi.mock('../../harness-registry', () => ({ isRegisteredHive: (...a: unknown[]) => isRegisteredHiveMock(...a) }));
const insertProbeMock = vi.fn(async () => ({}));
vi.mock('../../sync/pot-git/federation-probe-store', () => ({ insertProbe: (...a: unknown[]) => insertProbeMock(...a) }));

import canaryCheck from './canary-check';

const call = async (args: Record<string, unknown>, ctx: Record<string, unknown> = { harnessSlug: 'my-hive' }) => {
  const res = (await canaryCheck.handler(args as never, ctx as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  isRegisteredHiveMock.mockResolvedValue(true);
  insertProbeMock.mockResolvedValue({});
});

describe('gates:canary-check', () => {
  it('a federated harness reads healthy-apparatus: canaryOk true, alarm none (no systemGreen wired)', async () => {
    const out = await call({});
    expect(out.ok).toBe(true);
    expect(out.canaryOk).toBe(true);
    expect(out.alarm).toBe('none');
    expect(out.verdict).toBe('unknown'); // no systemGreen signal supplied on-demand
    expect(insertProbeMock).toHaveBeenCalledTimes(1);
  });

  it('an unfederated harness reads gate-broken (the cause-#10 class)', async () => {
    isRegisteredHiveMock.mockResolvedValue(false);
    const out = await call({});
    expect(out.canaryOk).toBe(false);
    expect(out.verdict).toBe('gate-broken');
    expect(out.alarm).toBe('gate');
  });

  it('args.harnessSlug overrides ctx.harnessSlug', async () => {
    await call({ harnessSlug: 'explicit-hive' }, { harnessSlug: 'ctx-hive' });
    expect(isRegisteredHiveMock).toHaveBeenCalledWith('ws-x', 'explicit-hive');
  });

  it('no harness at all (no arg, no ctx) is canary-INDETERMINATE, never gate-broken', async () => {
    const out = await call({}, {});
    expect(out.canaryOk).toBe(null);
    expect(out.verdict).toBe('unknown');
    expect(out.verdict).not.toBe('gate-broken');
    // never probe garbage — the fed-probe apparatus is not touched
    expect(isRegisteredHiveMock).not.toHaveBeenCalled();
    expect(insertProbeMock).not.toHaveBeenCalled();
  });

  // EI-11574 regression: an argless canary in a workspace-scoped (superuser)
  // session resolves ctx.harnessSlug to the literal '*' scope selector. That
  // must NOT reach the fed-probe apparatus (which rejects '*' as
  // invalid_harness_slug) and must NOT be mislabeled the critical 'gate-broken'
  // verdict on a healthy gate — it is canary-indeterminate (verdict 'unknown').
  it("argless canary with ctx.harnessSlug '*' does not emit a false gate-broken (EI-11574)", async () => {
    const out = await call({}, { harnessSlug: '*' });
    expect(out.verdict).toBe('unknown');
    expect(out.verdict).not.toBe('gate-broken');
    expect(out.alarm).not.toBe('gate');
    expect(out.canaryOk).toBe(null);
    // '*' is never passed downstream as a concrete harness
    expect(isRegisteredHiveMock).not.toHaveBeenCalled();
    expect(insertProbeMock).not.toHaveBeenCalled();
  });

  it("an explicit args.harnessSlug of '*' is also treated as indeterminate, not gate-broken", async () => {
    const out = await call({ harnessSlug: '*' }, { harnessSlug: 'my-hive' });
    expect(out.verdict).toBe('unknown');
    expect(out.verdict).not.toBe('gate-broken');
    expect(isRegisteredHiveMock).not.toHaveBeenCalled();
    expect(insertProbeMock).not.toHaveBeenCalled();
  });
});
