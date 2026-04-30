import { describe, expect, it } from 'vitest';
import {
  derivePublishKey,
  deriveSnapshotKey,
  deriveSubkey,
} from './hkdf';
import { randomBytes } from './random';
import { toHex } from './hex';

describe('hkdf subkey derivation', () => {
  it('derives 32-byte subkeys by default', async () => {
    const ikm = randomBytes(32);
    const k = await derivePublishKey(ikm);
    expect(k.length).toBe(32);
  });

  it('publish and snapshot keys differ for the same tenantSecret', async () => {
    const ikm = randomBytes(32);
    const p = await derivePublishKey(ikm);
    const s = await deriveSnapshotKey(ikm);
    expect(toHex(p)).not.toBe(toHex(s));
  });

  it('is deterministic for the same input', async () => {
    const ikm = randomBytes(32);
    const a = await derivePublishKey(ikm);
    const b = await derivePublishKey(ikm);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('different ikm produces different keys', async () => {
    const a = await derivePublishKey(randomBytes(32));
    const b = await derivePublishKey(randomBytes(32));
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('honors custom info string', async () => {
    const ikm = randomBytes(32);
    const a = await deriveSubkey(ikm, 'foo');
    const b = await deriveSubkey(ikm, 'bar');
    expect(toHex(a)).not.toBe(toHex(b));
  });
});
