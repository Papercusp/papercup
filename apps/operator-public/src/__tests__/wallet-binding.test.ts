/**
 * Signed-nonce wallet binding through the shipped Worker door (P-029).
 *
 * These tests use the real Hono route, real SQLite migrations, and the real
 * EIP-191 recovery implementation. Only GitHub's external bearer lookup is
 * mocked; the authenticated numeric id still becomes the principal inside the
 * production route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ethereumPersonalMessageDigest } from '@papercusp/operator-core/lib/cupboard/wallet-binding';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});
const { AuthError } = await import('../auth.ts');

const keyOne = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
]);
const keyTwo = keyOne.map((value, index) => (index === 31 ? 2 : value));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function walletFor(key: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(key, false);
  return `0x${hex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

function sign(message: string, key: Uint8Array): string {
  const recovered = secp256k1.sign(ethereumPersonalMessageDigest(message), key, {
    prehash: false,
    format: 'recovered',
  });
  const ethereum = new Uint8Array(65);
  ethereum.set(recovered.subarray(1), 0);
  ethereum[64] = recovered[0] + 27;
  return `0x${hex(ethereum)}`;
}

const walletOne = walletFor(keyOne);
const walletTwo = walletFor(keyTwo);

function harness() {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  return { api: buildApi(), env, raw };
}

function bearerJson(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  };
}

async function challenge(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  walletAddress: string,
) {
  const response = await api.request(
    '/commerce/wallet-bindings/challenges',
    bearerJson({ walletAddress, chainId: 1 }),
    env,
  );
  return {
    response,
    body: (await response.json()) as {
      challengeId: string;
      walletAddress: string;
      message: string;
      expiresAtMs: number;
    },
  };
}

async function verify(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  challengeId: string,
  signature: string,
) {
  return api.request(
    '/commerce/wallet-bindings',
    bearerJson({ challengeId, signature }),
    env,
  );
}

describe('wallet-binding Worker door', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'wallet-owner' });
  });

  it('authenticates before issuing a principal-bound SIWE-style challenge', async () => {
    const { api, env, raw } = harness();
    const issued = await challenge(api, env, walletOne);
    expect(issued.response.status).toBe(201);
    expect(issued.body.walletAddress).toBe(walletOne);
    expect(issued.body.message).toContain('urn:papercusp:principal:gh:42');
    expect(issued.body.message).toContain(walletOne);
    expect(raw.prepare('SELECT principal_id, wallet_address, consumed_at_ms FROM wallet_binding_challenges').get())
      .toMatchObject({ principal_id: 'gh:42', wallet_address: walletOne, consumed_at_ms: null });

    auth.resolveGithubBearer.mockRejectedValue(new AuthError('missing_bearer'));
    const refused = await api.request(
      '/commerce/wallet-bindings/challenges',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletAddress: walletTwo }) },
      env,
    );
    expect(refused.status).toBe(401);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM wallet_binding_challenges').get()).toMatchObject({ n: 1 });
  });

  it('consumes a challenge once and rejects a replay without rewriting the binding', async () => {
    const { api, env, raw } = harness();
    const issued = await challenge(api, env, walletOne);
    const signature = sign(issued.body.message, keyOne);

    const first = await verify(api, env, issued.body.challengeId, signature);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      bound: true,
      rotated: false,
      binding: { walletAddress: walletOne, challengeId: issued.body.challengeId },
    });

    const replay = await verify(api, env, issued.body.challengeId, signature);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: 'challenge_already_used' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM wallet_bindings').get()).toMatchObject({ n: 1 });
    expect(raw.prepare('SELECT challenge_id, wallet_address FROM wallet_bindings').get())
      .toMatchObject({ challenge_id: issued.body.challengeId, wallet_address: walletOne });
  });

  it('rejects an expired challenge and leaves it unconsumed', async () => {
    const { api, env, raw } = harness();
    const issued = await challenge(api, env, walletOne);
    raw.prepare(
      'UPDATE wallet_binding_challenges SET issued_at_ms = 0, expires_at_ms = 1 WHERE challenge_id = ?',
    )
      .run(issued.body.challengeId);

    const response = await verify(api, env, issued.body.challengeId, sign(issued.body.message, keyOne));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: 'challenge_expired' });
    expect(raw.prepare('SELECT consumed_at_ms FROM wallet_binding_challenges WHERE challenge_id = ?').get(issued.body.challengeId))
      .toMatchObject({ consumed_at_ms: null });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM wallet_bindings').get()).toMatchObject({ n: 0 });
  });

  it('refuses address-only principal inference and ignores a spoofed principal id', async () => {
    const { api, env } = harness();
    const issuedResponse = await api.request(
      '/commerce/wallet-bindings/challenges',
      bearerJson({ walletAddress: walletOne, principalId: 'gh:999' }),
      env,
    );
    expect(issuedResponse.status).toBe(201);
    const issued = (await issuedResponse.json()) as { message: string };
    expect(issued.message).toContain('urn:papercusp:principal:gh:42');
    expect(issued.message).not.toContain('gh:999');

    const queryLookup = await api.request(
      `/commerce/wallet-bindings?walletAddress=${walletOne}`,
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    const pathLookup = await api.request(
      `/commerce/wallet-bindings/${walletOne}`,
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(queryLookup.status).toBe(404);
    expect(pathLookup.status).toBe(404);
  });

  it('rotates the authenticated principal to a newly verified wallet', async () => {
    const { api, env, raw } = harness();
    const firstChallenge = await challenge(api, env, walletOne);
    expect((await verify(
      api,
      env,
      firstChallenge.body.challengeId,
      sign(firstChallenge.body.message, keyOne),
    )).status).toBe(201);

    const secondChallenge = await challenge(api, env, walletTwo);
    const rotated = await verify(
      api,
      env,
      secondChallenge.body.challengeId,
      sign(secondChallenge.body.message, keyTwo),
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({
      bound: true,
      rotated: true,
      rotatedFromWalletAddress: walletOne,
      binding: { walletAddress: walletTwo, challengeId: secondChallenge.body.challengeId },
    });

    const status = await api.request(
      '/commerce/wallet-bindings/me',
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ bound: true, binding: { walletAddress: walletTwo } });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM wallet_bindings').get()).toMatchObject({ n: 1 });
  });

  it('prevents one wallet from binding two principals, rolls back the losing challenge, and supports unbind', async () => {
    const { api, env, raw } = harness();
    const firstChallenge = await challenge(api, env, walletOne);
    await verify(api, env, firstChallenge.body.challengeId, sign(firstChallenge.body.message, keyOne));

    auth.resolveGithubBearer.mockResolvedValue({ id: 99, login: 'other-principal' });
    const conflictingChallenge = await challenge(api, env, walletOne);
    const conflict = await verify(
      api,
      env,
      conflictingChallenge.body.challengeId,
      sign(conflictingChallenge.body.message, keyOne),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'wallet_already_bound' });
    expect(raw.prepare('SELECT principal_id FROM wallet_bindings WHERE wallet_address = ?').get(walletOne))
      .toMatchObject({ principal_id: 'gh:42' });
    expect(
      raw.prepare('SELECT consumed_at_ms FROM wallet_binding_challenges WHERE challenge_id = ?')
        .get(conflictingChallenge.body.challengeId),
    ).toMatchObject({ consumed_at_ms: null });

    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'wallet-owner' });
    const unbound = await api.request(
      '/commerce/wallet-bindings/me',
      { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(unbound.status).toBe(200);
    expect(await unbound.json()).toEqual({ unbound: true, previousWalletAddress: walletOne });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM wallet_bindings').get()).toMatchObject({ n: 0 });

    auth.resolveGithubBearer.mockResolvedValue({ id: 99, login: 'other-principal' });
    const retried = await verify(
      api,
      env,
      conflictingChallenge.body.challengeId,
      sign(conflictingChallenge.body.message, keyOne),
    );
    expect(retried.status).toBe(201);
    expect(raw.prepare('SELECT principal_id FROM wallet_bindings WHERE wallet_address = ?').get(walletOne))
      .toMatchObject({ principal_id: 'gh:99' });
  });
});
