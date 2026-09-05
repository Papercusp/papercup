/**
 * Coverage for `decodeOperatorSecretKey` — the guard that stops a corrupt
 * `operator_secrets` row from silently degrading into a short/empty HMAC key.
 *
 * Three layers, deliberately:
 *   1. CALIBRATION — proves the hazard is REAL. If Node ever started throwing on
 *      corrupt base64, or refusing a 0-byte HMAC key, the guard would be redundant
 *      and these controls would fail, telling us so. Without them a future reader
 *      cannot tell whether this guard defends against anything.
 *   2. The helper itself, both directions (accepts a real key / rejects each way
 *      a row can be corrupt).
 *   3. WIRING — the guard is worth zero until something calls it, so both real
 *      loaders are driven through a mocked-corrupt PG row and must actually throw.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  decodeOperatorSecretKey,
  OPERATOR_SECRET_KEY_BYTES,
  OPERATOR_SECRET_KEY_CORRUPT,
} from './operator-secret-key';

/* ─── 1. Calibration: the hazard this guard exists for is real ───────────── */

describe('calibration — why this guard exists', () => {
  it('Buffer.from(corrupt, base64) does NOT throw — it silently truncates', () => {
    // Every one of these is a way an operator_secrets row can be damaged, and
    // NONE of them raises. This is the whole reason a length assertion is needed.
    expect(Buffer.from('', 'base64')).toHaveLength(0);
    expect(Buffer.from('   ', 'base64')).toHaveLength(0);
    expect(Buffer.from('!!!!not base64!!!!', 'base64')).toHaveLength(6);
    expect(Buffer.from('AAAA', 'base64')).toHaveLength(3);
  });

  it('createHmac accepts a 0-byte key, so a degenerate key still signs and verifies', () => {
    // The silent-downgrade mechanism: signing and verifying both load the SAME
    // degenerate key, so the round-trip succeeds and nothing looks wrong.
    const sign = () => createHmac('sha256', Buffer.alloc(0)).update('payload').digest('hex');
    expect(sign).not.toThrow();
    expect(sign()).toEqual(sign()); // verifies against itself — looks perfectly healthy
  });
});

/* ─── 2. The helper, both directions ─────────────────────────────────────── */

describe('decodeOperatorSecretKey', () => {
  const validB64 = Buffer.from('ab'.repeat(32), 'hex').toString('base64');

  it('accepts a well-formed 32-byte key and returns the exact bytes', () => {
    const out = decodeOperatorSecretKey(validB64, 'spawn-signing-key');
    expect(out).toHaveLength(OPERATOR_SECRET_KEY_BYTES);
    expect(out.toString('base64')).toBe(validB64);
  });

  // Each row is a distinct way the stored value can be wrong. Table-driven so a
  // new corruption shape is one line, not a new copy of the assertion.
  const corrupt: Array<[label: string, value: string | null | undefined]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-base64 garbage', '!!!!not base64!!!!'],
    ['truncated', 'AAAA'],
    ['null', null],
    ['undefined', undefined],
    ['a 16-byte key (half-length)', Buffer.alloc(16).toString('base64')],
    ['a 64-byte key (double-length)', Buffer.alloc(64).toString('base64')],
  ];

  for (const [label, value] of corrupt) {
    it(`throws on ${label}`, () => {
      expect(() => decodeOperatorSecretKey(value, 'power-user-token-key')).toThrow(
        OPERATOR_SECRET_KEY_CORRUPT,
      );
    });
  }

  it('names the offending row and both remedies, so the log line is actionable', () => {
    let msg = '';
    try {
      decodeOperatorSecretKey('AAAA', 'spawn-signing-key');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('spawn-signing-key'); // WHICH secret
    expect(msg).toContain('3 byte(s)'); // what it actually decoded to
    expect(msg).toMatch(/restore/i); // remedy 1
    expect(msg).toMatch(/rotate/i); // remedy 2
  });

  it('does NOT self-heal — a corrupt key never yields a usable buffer', () => {
    // Re-minting on read would silently invalidate every live signed URL/token.
    // Failing is the correct behaviour; assert we never hand back a substitute.
    expect(() => decodeOperatorSecretKey('', 'spawn-signing-key')).toThrow();
  });
});

/* ─── 3. Wiring: the real loaders actually call it ───────────────────────── */

const CORRUPT_B64 = 'AAAA'; // decodes to 3 bytes, not 32

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  const db: Record<string, unknown> = {};
  Object.assign(db, {
    select: () => db,
    from: () => db,
    where: () => db,
    // Both loaders read the row under either column spelling.
    limit: async () => [
      { value_b64: CORRUPT_B64, valueB64: CORRUPT_B64, rotated_at: '2026-01-01T00:00:00.000Z', rotatedAt: '2026-01-01T00:00:00.000Z' },
    ],
    insert: () => db,
    values: () => db,
    onConflictDoNothing: async () => undefined,
    onConflictDoUpdate: async () => undefined,
  });
  return { ...actual, getOrgPg: () => ({ db, sql: vi.fn(async () => []) }) };
});
vi.mock('./fleet/nursery', () => ({
  cancelSubtree: vi.fn(async () => ({ cancelled: [], alreadyTerminal: [], resourcesReleased: {} })),
}));
vi.mock('./fleet/operator-spawn', () => ({ abortLocalSpawn: vi.fn(() => true) }));
vi.mock('./fleet/spawn-reclaim', () => ({ shouldRelaunchReclaimedSpawn: vi.fn(() => false) }));
vi.mock('./fleet/spawn-relaunch', () => ({ relaunchReclaimedSpawn: vi.fn(async () => true) }));

import { signSpawnParams, _resetSpawnSigningKeyCache } from './spawn-signing';
import { mintAccessToken, _resetPowerUserTokenKeyCache } from './power-user-token';

describe('wiring — a corrupt PG key row fails LOUDLY at both real loaders', () => {
  beforeEach(() => {
    // The cache is what would otherwise hide a corrupt row behind a prior good load.
    _resetSpawnSigningKeyCache();
    _resetPowerUserTokenKeyCache();
  });

  it('spawn-signing refuses to sign rather than signing with a 3-byte key', async () => {
    await expect(signSpawnParams(new URLSearchParams({ spawn: 's-1' }))).rejects.toThrow(
      OPERATOR_SECRET_KEY_CORRUPT,
    );
  });

  it('power-user-token refuses to mint rather than minting a forgeable token', async () => {
    await expect(
      mintAccessToken({ sessionId: 'auth-1', subject: 'owner' } as never),
    ).rejects.toThrow(OPERATOR_SECRET_KEY_CORRUPT);
  });
});
