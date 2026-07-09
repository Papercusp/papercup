/**
 * set_hive.test.ts — the discovery:set_pot MCP tool (p2p-hive-directory P-004 /
 * hive-from-github-url P-015).
 *
 * Two halves:
 *  1. ARGS validation (DISC-1) — invite genuinely REQUIRES inviteSecret. The
 *     sibling HTTP route (set-hive.ts) 400s on `invite` with no secret and
 *     `publishHiveToDirectory` throws without it; the MCP face must reject at
 *     the schema layer too (a `.refine`) rather than half-save then surface a
 *     generic announceError. So this pins: invite+no-secret rejects;
 *     invite+secret + public pass.
 *  2. HANDLER forwarding — the EXACT meta shape handed to the shared
 *     `setHiveListing` composition (inviteSecret present for invite, ABSENT for
 *     public) + the active workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setHiveListing = vi.fn();
vi.mock('../../hive-set-listing', () => ({
  setHiveListing: (...a: unknown[]) => setHiveListing(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import setHiveTool from './set_pot';

const argsSchema = setHiveTool.args as {
  safeParse: (v: unknown) => { success: boolean };
  parse: (v: unknown) => unknown;
};

async function call(args: Record<string, unknown>) {
  const parsed = argsSchema.parse(args) as never;
  const res = (await (
    setHiveTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(parsed, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  setHiveListing.mockReset();
  setHiveListing.mockResolvedValue({ ok: true, hiveId: 'h', visibility: 'public', saved: true, announced: true });
});

describe('discovery:set_pot args validation (DISC-1)', () => {
  it('REJECTS invite visibility with no inviteSecret (mirrors the HTTP 400 + publish throw)', () => {
    expect(argsSchema.safeParse({ hiveId: 'h', title: 'T', visibility: 'invite' }).success).toBe(false);
  });

  it('accepts invite visibility WITH inviteSecret', () => {
    expect(
      argsSchema.safeParse({ hiveId: 'h', title: 'T', visibility: 'invite', inviteSecret: 's' }).success,
    ).toBe(true);
  });

  it('accepts public visibility with no inviteSecret', () => {
    expect(argsSchema.safeParse({ hiveId: 'h', title: 'T', visibility: 'public' }).success).toBe(true);
  });

  it('accepts private visibility with no inviteSecret', () => {
    expect(argsSchema.safeParse({ hiveId: 'h', title: 'T', visibility: 'private' }).success).toBe(true);
  });

  it('defaults visibility to public (and so passes with no secret)', () => {
    const r = argsSchema.safeParse({ hiveId: 'h', title: 'T' });
    expect(r.success).toBe(true);
  });
});

describe('discovery:set_pot handler forwarding (P-015)', () => {
  it('forwards an invite listing carrying the inviteSecret + active workspace', async () => {
    setHiveListing.mockResolvedValue({ ok: true, hiveId: 'h', visibility: 'invite', saved: true, announced: true });
    await call({ hiveId: 'h', title: 'T', visibility: 'invite', inviteSecret: 'sekret' });
    expect(setHiveListing).toHaveBeenCalledTimes(1);
    expect(setHiveListing.mock.calls[0][0]).toMatchObject({
      hiveId: 'h',
      title: 'T',
      visibility: 'invite',
      inviteSecret: 'sekret',
    });
    expect(setHiveListing.mock.calls[0][1]).toBe('ws-test');
  });

  it('OMITS inviteSecret from the meta for a public listing', async () => {
    await call({ hiveId: 'h', title: 'T', visibility: 'public' });
    const meta = setHiveListing.mock.calls[0][0] as Record<string, unknown>;
    expect(meta).toMatchObject({ hiveId: 'h', visibility: 'public' });
    expect('inviteSecret' in meta).toBe(false);
  });

  it('forwards memberTopics / memberLinks / createdAt only when provided', async () => {
    await call({
      hiveId: 'h',
      title: 'T',
      visibility: 'public',
      memberTopics: ['t1'],
      memberLinks: ['papercusp://harness?x'],
      createdAt: 1_700_000_000_000,
    });
    expect(setHiveListing.mock.calls[0][0]).toMatchObject({
      memberTopics: ['t1'],
      memberLinks: ['papercusp://harness?x'],
      createdAt: 1_700_000_000_000,
    });
  });

  it('omits the optional spread fields when absent', async () => {
    await call({ hiveId: 'h', title: 'T', visibility: 'public' });
    const meta = setHiveListing.mock.calls[0][0] as Record<string, unknown>;
    expect('memberTopics' in meta).toBe(false);
    expect('memberLinks' in meta).toBe(false);
    expect('createdAt' in meta).toBe(false);
  });

  it('returns the composition result verbatim', async () => {
    setHiveListing.mockResolvedValue({ ok: true, hiveId: 'h', visibility: 'public', saved: true, announced: false, announceError: 'x' });
    const out = await call({ hiveId: 'h', title: 'T', visibility: 'public' });
    expect(out).toMatchObject({ ok: true, announced: false, announceError: 'x' });
  });
});
