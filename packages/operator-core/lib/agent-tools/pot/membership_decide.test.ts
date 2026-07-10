/**
 * membership_decide.test.ts — pot:membership_decide HANDLER, bulk keyed-array
 * contract (bulk-endpoint-standardization-2026-06-21 P-006). The owner gate
 * (isCanonicalPotOwner — WI-2000: the canonical-ownership check, not merely
 * "holds ANY key"), the local-identity resolve, and the admission store
 * (approve/denyPendingJoin) are mocked. Pins the inline n=1 form, the items:[…]
 * many form (per-item results keyed by githubUserId, heterogeneous
 * decision/reason), the owner gate firing ONCE for the batch, and a
 * no_pending item failing only itself.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pot/membership_decide.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isCanonicalPotOwner: vi.fn(),
  resolveIdentity: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'default',
}));
// hive-identity.ts / hive-membership-admission.ts are OUT OF SCOPE for the
// cup-lexicon rename (persisted-store modules) — mock the REAL module paths +
// export names.
vi.mock('../../hive-identity', () => ({ isCanonicalHiveOwner: h.isCanonicalPotOwner }));
vi.mock('../../identity/resolve-local-github-identity', () => ({ resolveLocalGithubIdentity: h.resolveIdentity }));
vi.mock('../../hive-membership-admission', () => ({ approvePendingJoin: h.approve, denyPendingJoin: h.deny }));

import tool from './membership_decide';

const CTX = { workspaceId: 'default' } as never;
type Out = { data?: any; content?: Array<{ text: string }> };
// The happy path returns the canonical { data: envelope }; the top-level owner
// gate still returns a raw { content } ToolResult — read whichever is present.
const env = async (args: unknown) => {
  const r = (await tool.handler(args as never, CTX)) as Out;
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.isCanonicalPotOwner.mockResolvedValue(true); // this Swarm owns the Pot
  h.resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 7, githubLogin: 'owner', token: 't' });
  h.approve.mockImplementation(async ({ githubUserId }: { githubUserId: number }) => ({ ok: true, status: 'approved', member: { githubUserId } }));
  h.deny.mockImplementation(async ({ githubUserId }: { githubUserId: number }) => ({ ok: true, status: 'denied', pending: { githubUserId } }));
});

describe('pot:membership_decide handler (bulk keyed-array, P-006)', () => {
  it('owner gate fails the WHOLE call when this Swarm does not hold the key', async () => {
    h.isCanonicalPotOwner.mockResolvedValue(false);
    const b = await env({ pot: 'sheets', githubUserId: 42, decision: 'approve' });
    expect(b).toMatchObject({ ok: false, code: 'not_owner' });
  });

  it('n=1 inline approve → one keyed result; admission store called', async () => {
    const b = await env({ pot: 'sheets', githubUserId: 42, decision: 'approve' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, githubUserId: 42, status: 'approved' });
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ potHomeSlug: 'sheets', githubUserId: 42, decidedByGithubUserId: 7 }));
  });

  it('items:[…] decides many heterogeneous (approve + deny), keyed by githubUserId; owner gate fires ONCE', async () => {
    const b = await env({
      pot: 'sheets',
      items: [
        { githubUserId: 42, decision: 'approve' },
        { githubUserId: 43, decision: 'deny', reason: 'spam' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => [r.githubUserId, r.status])).toEqual([
      [42, 'approved'],
      [43, 'denied'],
    ]);
    expect(h.isCanonicalPotOwner).toHaveBeenCalledTimes(1); // owner gate once for the batch
    expect(h.deny).toHaveBeenCalledWith(expect.objectContaining({ githubUserId: 43, reason: 'spam' }));
  });

  it('a no_pending result fails ONLY that joiner (batch ok:true)', async () => {
    h.approve.mockImplementation(async ({ githubUserId }: { githubUserId: number }) =>
      githubUserId === 99 ? { ok: false, code: 'no_pending' } : { ok: true, status: 'approved', member: { githubUserId } },
    );
    const b = await env({
      pot: 'sheets',
      items: [
        { githubUserId: 42, decision: 'approve' },
        { githubUserId: 99, decision: 'approve' },
      ],
    });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: true, githubUserId: 42 });
    expect(b.results[1]).toMatchObject({ ok: false, githubUserId: 99, code: 'no_pending' });
  });

  it('arg schema requires { githubUserId, decision } (one) or items[]', () => {
    expect(tool.args.safeParse({ pot: 'sheets' }).success).toBe(false);
    expect(tool.args.safeParse({ pot: 'sheets', githubUserId: 1, decision: 'approve' }).success).toBe(true);
    expect(tool.args.safeParse({ pot: 'sheets', items: [{ githubUserId: 1, decision: 'deny' }] }).success).toBe(true);
  });
});
