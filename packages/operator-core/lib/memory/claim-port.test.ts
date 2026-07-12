/**
 * Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
 * D-006): the query is `title — <summary head>` (id fallback), one per
 * claimed item; the WHERE is the items' dominant harness; the block is built
 * through buildLaunchMemoryBlock with the claim budget + port 'claim'; and
 * EVERY failure / timeout / no-material path degrades to null so a claim is
 * never failed or materially delayed by recall.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildClaimRecallBlock, claimRecallQueryOf, CLAIM_RECALL_BUDGET_CHARS } from './claim-port';
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';

vi.mock('./launch-profile', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, buildLaunchMemoryBlock: vi.fn(async () => null) };
});
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

beforeEach(() => {
  vi.mocked(buildLaunchMemoryBlock).mockReset();
  vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
});

describe('claimRecallQueryOf', () => {
  it('renders `title — <summary head>`', () => {
    expect(claimRecallQueryOf({ title: 'Wire the prelude', summary: 'session-start memory prime' })).toBe(
      'Wire the prelude — session-start memory prime',
    );
  });
  it('falls back to the id for a blank title', () => {
    expect(claimRecallQueryOf({ id: 'WI-9', title: '', summary: 'x' })).toBe('WI-9 — x');
  });
  it('title only when no summary', () => {
    expect(claimRecallQueryOf({ title: 'Just a title' })).toBe('Just a title');
  });
  it('empty when neither title nor id', () => {
    expect(claimRecallQueryOf({ summary: 'orphan' })).toBe('');
  });
});

describe('buildClaimRecallBlock', () => {
  it('no material (no items with a title/id) → null, no recall call', async () => {
    expect(await buildClaimRecallBlock({ items: [{ summary: 'no title' }] })).toBeNull();
    expect(buildLaunchMemoryBlock).not.toHaveBeenCalled();
  });

  it('builds one query per claimed item over the dominant harness, budget + port claim', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## Claim recall\n\n- [h] fact (id=abc)');
    const out = await buildClaimRecallBlock({
      sessionId: 'sid-1',
      workspaceId: 'ws-9',
      items: [
        { id: 'WI-1', title: 'Wire prelude', summary: 'prime', harness: 'papercusp' },
        { id: 'WI-2', title: 'Epoch ledger', summary: 'dedup', harness: 'papercusp' },
      ],
      planNow: 'ship it',
    });
    expect(out).toBe('## Claim recall\n\n- [h] fact (id=abc)');
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      workspaceId: 'ws-9',
      budgetChars: CLAIM_RECALL_BUDGET_CHARS,
      session: { sessionId: 'sid-1', port: 'claim' },
      profile: expect.objectContaining({
        rung: 'plan',
        queries: ['Wire prelude — prime', 'Epoch ledger — dedup'],
        harnessSlugs: ['papercusp'],
      }),
    });
  });

  it('un-stamped (no sessionId) still recalls, without a session block', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## Claim recall\n\n- x');
    await buildClaimRecallBlock({ items: [{ title: 't', harness: 'h' }] });
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.session).toBeUndefined();
    expect(arg.workspaceId).toBe('ws-active'); // active-workspace fallback
  });

  it('never throws: a recall failure degrades to null', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(new Error('embed down'));
    expect(await buildClaimRecallBlock({ items: [{ title: 't' }] })).toBeNull();
  });

  it('deadline: a slow recall resolves to null within the deadline', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    );
    const out = await buildClaimRecallBlock({ items: [{ title: 't' }], deadlineMs: 30 });
    expect(out).toBeNull();
  });

  it('port override (create) threads through to the session stamp', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- y');
    await buildClaimRecallBlock({ sessionId: 'sid', items: [{ title: 't' }], port: 'create' });
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0] as { session?: { port?: string } };
    expect(arg.session?.port).toBe('create');
  });

  // resolveLaunchProfile stays REAL through the partial mock — assert the wiring
  // produced a real plan-rung profile (not a hand-built stub).
  it('uses the REAL resolver (plan rung for claimed titles)', () => {
    const p = resolveLaunchProfile({ harnessSlug: 'h', claimedItemTitles: ['a — b'] });
    expect(p.rung).toBe('plan');
  });
});
