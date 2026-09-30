/**
 * Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
 * D-006): the query is `title — <summary head>` (id fallback), one per
 * claimed item; the WHERE is the items' dominant harness; the block is built
 * through buildLaunchMemoryBlock with the claim budget + port 'claim'; and
 * EVERY failure / timeout / no-material path degrades to null so a claim is
 * never failed or materially delayed by recall.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildClaimRecallBlock,
  buildClaimRecallResult,
  claimRecallQueryOf,
  readClaimRecallOutcomeStats,
  _resetClaimRecallOutcomeStatsForTests,
  CLAIM_RECALL_BUDGET_CHARS,
} from './claim-port';
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';
import { getSessionUserOrDefault } from '../auth';

vi.mock('./launch-profile', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, buildLaunchMemoryBlock: vi.fn(async () => null) };
});
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
// WI-6933: the canonical-user resolver is a DB lookup (harness_shared.users) —
// mocked here the same way every other memory-recall dependency is, so these
// tests stay unit-scoped and never touch Postgres.
vi.mock('../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({
    id: 'canonical-default-user-id',
    username: 'default',
    display_name: 'User',
    has_password: false,
  })),
}));

beforeEach(() => {
  vi.mocked(buildLaunchMemoryBlock).mockReset();
  vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
  vi.mocked(getSessionUserOrDefault).mockReset();
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'canonical-default-user-id',
    username: 'default',
    display_name: 'User',
    has_password: false,
  });
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
        // 2 item queries + the plan ## Now filling the spare 3rd slot (D-005).
        queries: ['Wire prelude — prime', 'Epoch ledger — dedup', 'ship it'],
        harnessSlugs: ['papercusp'],
      }),
    });
  });

  it('keeps a merged recall block within the transport-safe claim budget', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(
      `## Claim recall\n\n- ${'x'.repeat(CLAIM_RECALL_BUDGET_CHARS)}\n- ${'y'.repeat(CLAIM_RECALL_BUDGET_CHARS)}`,
    );

    const out = await buildClaimRecallBlock({
      items: [{ title: 'A claim with a large recall', harness: 'papercusp' }],
    });

    expect(out).toBeTruthy();
    expect(out!.length).toBeLessThanOrEqual(CLAIM_RECALL_BUDGET_CHARS);
    expect(out).toContain('## Claim recall');
    expect(out).toContain('…');
  });

  // EI-18893248175645463: the 'user' pool was recorded on EVERY claim recall
  // with an unconditionally empty scope list (buildLaunchMemoryBlock never
  // received a userId), a guaranteed 100% zero-hit rather than "nothing
  // relevant".
  //
  // WI-6933 follow-up: the ORIGINAL fix for that (defaulting userId to
  // sessionId) was itself wrong — sessionId is the per-agent coord ownerId
  // (epoch-dedup identity), NOT the canonical harness_shared.users.id every
  // memory:remember write and every OTHER buildLaunchMemoryBlock caller
  // (compact-reprime, turn-start) scopes the 'user' pool by. That produced a
  // non-empty but PERMANENTLY WRONG scope — measured 1161/1161 (100%)
  // zero-hit on claim/create recalls asked WITH a real scope. The correct
  // default resolves the SAME canonical id turn-start uses.
  it('defaults userId to the canonical session-user id (getSessionUserOrDefault), NOT sessionId', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
    await buildClaimRecallBlock({
      sessionId: 'su-claimer-1', // the epoch-dedup identity — must NOT leak into userId
      workspaceId: 'ws-9',
      items: [{ id: 'WI-1', title: 'Wire prelude', harness: 'papercusp' }],
    });
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0];
    expect(arg?.userId).toBe('canonical-default-user-id');
    expect(arg?.userId).not.toBe('su-claimer-1');
    // sessionId still threads through unchanged for its OWN (epoch-dedup) purpose.
    expect(arg?.session).toEqual({ sessionId: 'su-claimer-1', port: 'claim' });
  });

  it('an explicit userId overrides the canonical-user default (and skips the lookup)', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
    await buildClaimRecallBlock({
      sessionId: 'sid-1',
      userId: 'distinct-user-id',
      workspaceId: 'ws-9',
      items: [{ id: 'WI-1', title: 'Wire prelude', harness: 'papercusp' }],
    });
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0];
    expect(arg?.userId).toBe('distinct-user-id');
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('canonical-user lookup failure degrades to no userId, never fails or falls back to sessionId', async () => {
    vi.mocked(getSessionUserOrDefault).mockRejectedValue(new Error('pg down'));
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
    await buildClaimRecallBlock({
      sessionId: 'su-claimer-1',
      workspaceId: 'ws-9',
      items: [{ id: 'WI-1', title: 'Wire prelude', harness: 'papercusp' }],
    });
    const arg = vi.mocked(buildLaunchMemoryBlock).mock.calls[0]?.[0];
    expect(arg?.userId).toBeNull();
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

/**
 * WI-10004121: never-throws must not mean never-tells. Each null path carries a
 * distinct typed reason, so a deadline expiry, a thrown recall chain and an
 * empty admission can be told apart after the fact (they were indistinguishable
 * when the P-013 benchmark's positive control failed on a null recall).
 */
describe('buildClaimRecallResult — typed null reasons (WI-10004121)', () => {
  beforeEach(() => _resetClaimRecallOutcomeStatsForTests());

  it('no-queries: nothing to query with, no recall call', async () => {
    const r = await buildClaimRecallResult({ items: [{ summary: 'no title' }] });
    expect(r.block).toBeNull();
    expect(r.outcome.reason).toBe('no-queries');
    expect(buildLaunchMemoryBlock).not.toHaveBeenCalled();
  });

  it('no-hits: the admission pipeline settled with no block', async () => {
    const r = await buildClaimRecallResult({ items: [{ title: 't' }], deadlineMs: 1000 });
    expect(r.block).toBeNull();
    expect(r.outcome.reason).toBe('no-hits');
    expect(r.outcome.errorClass).toBeUndefined();
  });

  it('ok: a block was returned', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- a fact');
    const r = await buildClaimRecallResult({ items: [{ title: 't' }], port: 'create' });
    expect(r.block).toContain('- a fact');
    expect(r.outcome).toMatchObject({ reason: 'ok', port: 'create' });
  });

  it('deadline: a recall that has not settled by the deadline is reported as deadline, not no-hits', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    );
    const r = await buildClaimRecallResult({ items: [{ title: 't' }], deadlineMs: 30 });
    expect(r.block).toBeNull();
    expect(r.outcome.reason).toBe('deadline');
    expect(r.outcome.deadlineMs).toBe(30);
    expect(r.outcome.elapsedMs).toBeGreaterThanOrEqual(25);
    expect(r.outcome.elapsedMs).toBeLessThan(2000);
    expect(readClaimRecallOutcomeStats().lastFailure).toMatchObject({ reason: 'deadline' });
  });

  it('error: a thrown recall chain is reported with its class and message', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(
      new SyntaxError("The requested module './self-describing-store' does not provide an export named 'papercuspPath'"),
    );
    const r = await buildClaimRecallResult({ items: [{ title: 't' }] });
    expect(r.block).toBeNull();
    expect(r.outcome.reason).toBe('error');
    expect(r.outcome.errorClass).toBe('SyntaxError');
    expect(r.outcome.errorMessage).toContain('papercuspPath');
  });

  it('counts every outcome by reason', async () => {
    await buildClaimRecallResult({ items: [{ summary: 'x' }] });
    await buildClaimRecallResult({ items: [{ title: 't' }] });
    vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(new Error('embed down'));
    await buildClaimRecallResult({ items: [{ title: 't' }] });
    await buildClaimRecallBlock({ items: [{ title: 't' }] });
    const { counts, lastFailure } = readClaimRecallOutcomeStats();
    expect(counts).toEqual({ ok: 0, 'no-queries': 1, 'no-hits': 1, deadline: 0, error: 2 });
    expect(lastFailure).toMatchObject({ reason: 'error', errorClass: 'Error', errorMessage: 'embed down' });
  });

  it('warns once per window on deadline/error, never on no-hits (opted in)', async () => {
    _resetClaimRecallOutcomeStatsForTests({ optInToWarn: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await buildClaimRecallResult({ items: [{ title: 't' }] }); // no-hits
      expect(warn).not.toHaveBeenCalled();
      vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(new TypeError('boom'));
      await buildClaimRecallResult({ items: [{ title: 't' }] });
      await buildClaimRecallResult({ items: [{ title: 't' }] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/reason=error .*class=TypeError/);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent under the test runner unless a suite opts in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(new Error('embed down'));
      await buildClaimRecallResult({ items: [{ title: 't' }] });
      expect(warn).not.toHaveBeenCalled();
      expect(readClaimRecallOutcomeStats().counts.error).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
