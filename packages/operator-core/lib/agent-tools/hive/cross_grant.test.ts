/**
 * cross_grant.test.ts — the pot:cross_grant HANDLER (the grant store mocked). This is
 * the sovereignty boundary between Hives (default-deny both directions), so the handler's
 * dispatch + defaults matter: list returns the grants; grant/revoke REQUIRE
 * peerHivePubkey (else a refusal, no store write); grant defaults kinds→['ask'] and
 * direction→'in'; revoke targets the given direction. A regression that grants without a
 * peer key, or flips the default direction, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/cross_grant.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../cross-hive-grants', () => ({
  loadDirectedCrossHiveGrants: vi.fn(async () => [{ peer: 'pk1', kinds: ['ask'] }]),
  setCrossHiveGrant: vi.fn(),
  revokeCrossHiveGrant: vi.fn(),
}));

import { setCrossHiveGrant, revokeCrossHiveGrant } from '../../cross-hive-grants';
const setM = vi.mocked(setCrossHiveGrant);
const revokeM = vi.mocked(revokeCrossHiveGrant);
const tool = (await import('./cross_grant')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler({ pot: 'my-hive', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('pot:cross_grant handler', () => {
  it('list returns the current grants', async () => {
    const b = body(await call({ action: 'list' }));
    expect(b).toMatchObject({ ok: true, action: 'list', pot: 'my-hive', grants: [{ peer: 'pk1' }] });
    expect(setM).not.toHaveBeenCalled();
  });

  it('grant/revoke require peerHivePubkey', async () => {
    const b = body(await call({ action: 'grant' }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/peerHivePubkey/);
    expect(setM).not.toHaveBeenCalled();
  });

  it('grant defaults kinds=[ask] and direction=in', async () => {
    await call({ action: 'grant', peerHivePubkey: 'pk2' });
    expect(setM).toHaveBeenCalledTimes(1);
    const [ws, hive, peer, kinds, direction] = setM.mock.calls[0]!;
    expect([ws, hive, peer, kinds, direction]).toEqual(['ws-1', 'my-hive', 'pk2', ['ask'], 'in']);
  });

  it('revoke targets the given direction', async () => {
    await call({ action: 'revoke', peerHivePubkey: 'pk2', direction: 'out' });
    expect(revokeM).toHaveBeenCalledWith('ws-1', 'my-hive', 'pk2', 'out');
    expect(setM).not.toHaveBeenCalled();
  });
});
