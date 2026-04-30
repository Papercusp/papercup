import { describe, expect, it } from 'vitest';
import { mintFileToken, verifyFileToken } from './signed-url';
import { randomBytes } from './random';

const key = () => randomBytes(32);
const future = () => Math.floor(Date.now() / 1000) + 900;

describe('signed file-upload tokens', () => {
  it('verifies a valid token', async () => {
    const k = key();
    const tok = await mintFileToken(k, {
      deploymentId: 'dep_abc12345',
      sha256: 'a'.repeat(64),
      exp: future(),
    });
    expect(
      await verifyFileToken(k, tok, {
        deploymentId: 'dep_abc12345',
        sha256: 'a'.repeat(64),
      }),
    ).toBe(true);
  });

  it('rejects mismatched deploymentId', async () => {
    const k = key();
    const tok = await mintFileToken(k, {
      deploymentId: 'dep_abc12345',
      sha256: 'a'.repeat(64),
      exp: future(),
    });
    expect(
      await verifyFileToken(k, tok, {
        deploymentId: 'dep_xyz98765',
        sha256: 'a'.repeat(64),
      }),
    ).toBe(false);
  });

  it('rejects mismatched sha256', async () => {
    const k = key();
    const tok = await mintFileToken(k, {
      deploymentId: 'dep_abc12345',
      sha256: 'a'.repeat(64),
      exp: future(),
    });
    expect(
      await verifyFileToken(k, tok, {
        deploymentId: 'dep_abc12345',
        sha256: 'b'.repeat(64),
      }),
    ).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const k = key();
    const tok = await mintFileToken(k, {
      deploymentId: 'dep_abc12345',
      sha256: 'a'.repeat(64),
      exp: 100,
    });
    expect(
      await verifyFileToken(k, tok, {
        deploymentId: 'dep_abc12345',
        sha256: 'a'.repeat(64),
      }),
    ).toBe(false);
  });

  it('rejects malformed tokens', async () => {
    const k = key();
    expect(
      await verifyFileToken(k, 'malformed', {
        deploymentId: 'd',
        sha256: 'a'.repeat(64),
      }),
    ).toBe(false);
  });

  it('rejects tokens signed with a different key', async () => {
    const k1 = key();
    const k2 = key();
    const tok = await mintFileToken(k1, {
      deploymentId: 'dep_abc12345',
      sha256: 'a'.repeat(64),
      exp: future(),
    });
    expect(
      await verifyFileToken(k2, tok, {
        deploymentId: 'dep_abc12345',
        sha256: 'a'.repeat(64),
      }),
    ).toBe(false);
  });
});
