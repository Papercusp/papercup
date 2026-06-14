import { describe, it, expect, vi } from 'vitest';

// Hermetic key file: deriveDestKey() reads ~/.papercusp/db-encryption-key.
// Return a stable 32-byte hex key so encrypt/decrypt is deterministic + CI-safe.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('ab'.repeat(32), 'utf8')), // 64 hex chars → 32 bytes
}));

import { encryptDestConfig, decryptDestConfig, syncArgsFor, type DestinationConfig } from './destinations';

describe('syncArgsFor', () => {
  it('returns null for a local-only destination', () => {
    expect(syncArgsFor('local', {} as DestinationConfig)).toBeNull();
  });

  it('builds full S3 args + env (all optional fields present)', () => {
    const r = syncArgsFor('local+s3', {
      bucket: 'b', prefix: 'p/', endpoint: 'https://e', region: 'us-east-1',
      accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST',
    });
    expect(r).not.toBeNull();
    expect(r!.args).toEqual([
      'repository', 'sync-to', 's3',
      '--bucket=b', '--prefix=p/', '--endpoint=https://e', '--region=us-east-1',
      '--delete-blobs=false',
    ]);
    expect(r!.env).toEqual({
      AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'ST',
    });
  });

  it('omits optional S3 flags + session token when absent', () => {
    const r = syncArgsFor('local+s3', { bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(r!.args).toEqual(['repository', 'sync-to', 's3', '--bucket=b', '--delete-blobs=false']);
    expect(r!.env).toEqual({ AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' });
    expect(r!.env).not.toHaveProperty('AWS_SESSION_TOKEN');
  });

  it('builds B2 args and an empty env', () => {
    const r = syncArgsFor('local+b2', { bucket: 'b', keyId: 'kid', key: 'secret' });
    expect(r!.args).toEqual([
      'repository', 'sync-to', 'b2', '--bucket=b', '--key-id=kid', '--key=secret', '--delete-blobs=false',
    ]);
    expect(r!.env).toEqual({});
  });

  it('builds rclone args from the remote path', () => {
    const r = syncArgsFor('local+rclone', { remotePath: 'remote:bucket/path' });
    expect(r!.args).toEqual([
      'repository', 'sync-to', 'rclone', '--remote-path=remote:bucket/path', '--delete-blobs=false',
    ]);
    expect(r!.env).toEqual({});
  });

  it('never deletes blobs on the offsite copy (--delete-blobs=false present for every remote)', () => {
    for (const r of [
      syncArgsFor('local+s3', { bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
      syncArgsFor('local+b2', { bucket: 'b', keyId: 'k', key: 'v' }),
      syncArgsFor('local+rclone', { remotePath: 'r:p' }),
    ]) {
      expect(r!.args).toContain('--delete-blobs=false');
    }
  });
});

describe('encryptDestConfig / decryptDestConfig (AES-256-GCM round-trip)', () => {
  it('round-trips a config back to the original value', async () => {
    const cfg: DestinationConfig = { bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' };
    const ct = await encryptDestConfig('ws-1', cfg);
    expect(typeof ct).toBe('string');
    expect(await decryptDestConfig('ws-1', ct)).toEqual(cfg);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const cfg: DestinationConfig = { remotePath: 'r:p' };
    const a = await encryptDestConfig('ws-1', cfg);
    const b = await encryptDestConfig('ws-1', cfg);
    expect(a).not.toBe(b);
    expect(await decryptDestConfig('ws-1', a)).toEqual(cfg);
    expect(await decryptDestConfig('ws-1', b)).toEqual(cfg);
  });

  it('fails to decrypt under a different workspace id (per-workspace key)', async () => {
    const ct = await encryptDestConfig('ws-1', { remotePath: 'r:p' });
    await expect(decryptDestConfig('ws-2', ct)).rejects.toThrow();
  });

  it('throws on a too-short ciphertext blob', async () => {
    await expect(decryptDestConfig('ws-1', Buffer.from('short').toString('base64'))).rejects.toThrow(
      /too short/,
    );
  });

  it('throws on tampered ciphertext (GCM auth tag mismatch)', async () => {
    const ct = await encryptDestConfig('ws-1', { remotePath: 'r:p' });
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(decryptDestConfig('ws-1', buf.toString('base64'))).rejects.toThrow();
  });
});
