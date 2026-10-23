import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyStore = vi.hoisted(() => {
  const rows = [{ value_b64: Buffer.alloc(32, 9).toString('base64'), rotated_at: '2026-01-01' }];
  const db: Record<string, unknown> = {};
  Object.assign(db, { select: () => db, from: () => db, where: () => db, limit: async () => rows });
  return { db, rows };
});
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ db: keyStore.db }),
}));
import { _resetSpawnSigningKeyCache, signSpawnParams } from '../../spawn-signing';
import { mintConverseChatBinding, verifyConverseChatBinding } from './converse-chat-binding';

const parent = { workspaceId: 'ws-a', conversationId: 'conv-a', turnId: 'turn-a', runId: 'parent-run',
  authority: { kind: 'system' as const, principalId: 'system:operator', credentialSha256: 'a'.repeat(64) } };
const authority = { workspaceId: parent.workspaceId, bearer: 'current-credential' };
beforeEach(() => {
  keyStore.rows[0] = { value_b64: Buffer.alloc(32, 9).toString('base64'), rotated_at: '2026-01-01' };
  _resetSpawnSigningKeyCache();
});

describe('converse signed parent association', () => {
  it('round-trips without exposing the bearer or changing the parent identity', async () => {
    const token = await mintConverseChatBinding(parent, authority.bearer);
    expect(token).not.toContain(authority.bearer);
    expect(await verifyConverseChatBinding(token, authority)).toEqual({ ...parent,
      credentialSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it.each(['workspace', 'run', 'chat', 'harness', 'exp', 'sig'])('rejects tampered %s', async key => {
    const params = new URLSearchParams(await mintConverseChatBinding(parent, authority.bearer));
    params.set(key, key === 'exp' ? String(Math.floor(Date.now() / 1000) + 10) : 'forged');
    expect(await verifyConverseChatBinding(params.toString(), authority)).toBeNull();
  });

  it('rejects cross-workspace and cross-credential reuse', async () => {
    const token = await mintConverseChatBinding(parent, authority.bearer);
    expect(await verifyConverseChatBinding(token, { ...authority, workspaceId: 'ws-b' })).toBeNull();
    expect(await verifyConverseChatBinding(token, { ...authority, bearer: 'replacement-credential' })).toBeNull();
    const params = new URLSearchParams(token);
    const payload = JSON.parse(params.get('chat')!);
    payload[5] = 'b'.repeat(64);
    params.set('chat', JSON.stringify(payload));
    expect(await verifyConverseChatBinding(params.toString(), authority)).toBeNull();
  });

  it('rejects duplicate and unknown fields, permanent/expired grants, and missing identity', async () => {
    const token = await mintConverseChatBinding(parent, authority.bearer);
    for (const suffix of ['&run=other', '&sig=other', '&extra=1']) {
      expect(await verifyConverseChatBinding(token + suffix, authority)).toBeNull();
    }
    for (const value of ['0', '1']) {
      const params = new URLSearchParams(token);
      await signSpawnParams(params, { nowMs: value === '1' ? 0 : Date.now(), ttlSec: value === '1' ? 1 : 0 });
      expect(await verifyConverseChatBinding(params.toString(), authority)).toBeNull();
    }
    await expect(mintConverseChatBinding({ ...parent, turnId: '' }, authority.bearer)).rejects.toThrow('invalid-chat-parent');
  });

  it('honors rotation through the existing signer current-key read', async () => {
    const token = await mintConverseChatBinding(parent, authority.bearer);
    keyStore.rows[0] = { value_b64: Buffer.alloc(32, 8).toString('base64'), rotated_at: '2026-01-02' };
    expect(await verifyConverseChatBinding(token, authority)).toBeNull();
    expect(await verifyConverseChatBinding(await mintConverseChatBinding(parent, authority.bearer), authority)).toMatchObject(parent);
  });
});
