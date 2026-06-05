/**
 * Unit tests for power-user-token.ts — the HMAC envelope for the
 * `workspace-power-user` auth tier.
 *
 * PG is mocked: `getOrgPg` returns a stub `db` that always serves the
 * same fixed 32-byte key, so these tests exercise the pure sign / verify
 * / expiry / type-confusion logic with no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// A stable key shared by every getOrgPg() call in a test run.
const FIXED_KEY_B64 = randomBytes(32).toString('base64');
const FIXED_ROTATED_AT = new Date('2026-05-20T00:00:00.000Z');

vi.mock('@papercusp/db-org', () => ({
  generated: {
    operatorSecretsInHarnessShared: { name: 'name', valueB64: 'value_b64', rotatedAt: 'rotated_at' },
  },
  getOrgPg: () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ valueB64: FIXED_KEY_B64, rotatedAt: FIXED_ROTATED_AT }],
          }),
        }),
      }),
      // First-run insert path is never hit (select always returns a row).
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    },
  }),
}));

import {
  mintAccessToken,
  mintRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  newAuthSessionId,
  _resetPowerUserTokenKeyCache,
} from './power-user-token';

beforeEach(() => {
  _resetPowerUserTokenKeyCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('power-user-token', () => {
  it('mints + verifies an access token roundtrip', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'ws-alpha',
      userId: 'user-1',
      authSessionId: 'pus-abc',
    });
    const claims = await verifyAccessToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.t).toBe('access');
    expect(claims!.workspaceId).toBe('ws-alpha');
    expect(claims!.userId).toBe('user-1');
    expect(claims!.authSessionId).toBe('pus-abc');
    expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('mints + verifies a refresh token roundtrip', async () => {
    const { token } = await mintRefreshToken({ authSessionId: 'pus-xyz' });
    const claims = await verifyRefreshToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.t).toBe('refresh');
    expect(claims!.authSessionId).toBe('pus-xyz');
  });

  it('rejects a tampered payload (signature mismatch)', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'ws-alpha',
      userId: 'user-1',
      authSessionId: 'pus-abc',
    });
    // Swap the payload for one claiming a different workspace, keep the sig.
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        t: 'access',
        workspaceId: 'ws-VICTIM',
        userId: 'user-1',
        authSessionId: 'pus-abc',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'utf8',
    ).toString('base64url');
    expect(await verifyAccessToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'ws-alpha',
      userId: 'user-1',
      authSessionId: 'pus-abc',
      ttlSec: -10, // already expired
    });
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects type confusion — a refresh token is not a valid access token', async () => {
    const { token } = await mintRefreshToken({ authSessionId: 'pus-xyz' });
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects type confusion — an access token is not a valid refresh token', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'ws-alpha',
      userId: 'user-1',
      authSessionId: 'pus-abc',
    });
    expect(await verifyRefreshToken(token)).toBeNull();
  });

  it('rejects malformed input without throwing', async () => {
    for (const bad of [null, undefined, '', 'no-dot', '.', 'a.', '.b', 'a.b.c']) {
      expect(await verifyAccessToken(bad as string)).toBeNull();
    }
  });

  it('newAuthSessionId produces unique pus-prefixed ids', () => {
    const a = newAuthSessionId();
    const b = newAuthSessionId();
    expect(a).toMatch(/^pus-/);
    expect(b).toMatch(/^pus-/);
    expect(a).not.toBe(b);
  });
});
