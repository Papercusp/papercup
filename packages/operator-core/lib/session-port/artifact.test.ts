import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSessionPortArtifact, pruneStaleSessionPortArtifacts, readSessionPortArtifact, writeSessionPortArtifact } from './artifact';

describe('session-port artifacts', () => {
  it('writes owner-only, reads without premature deletion, and verifies the opaque token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-artifact-'));
    const artifact = await writeSessionPortArtifact({ seed: 'safe seed', root, now: 1_000 });
    expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
    await expect(readSessionPortArtifact({
      token: `${artifact.portId}.${'0'.repeat(64)}`,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).rejects.toThrow(/invalid/);
    expect(await readSessionPortArtifact({
      token: artifact.token,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).toBe('safe seed');
    expect(await readSessionPortArtifact({
      token: artifact.token,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).toBe('safe seed');
    expect(existsSync(artifact.path)).toBe(true);
    expect(await deleteSessionPortArtifact(artifact.path)).toBe(true);
    expect(await deleteSessionPortArtifact(artifact.path)).toBe(false);
  });

  it('can reproduce an idempotent token from an explicit server-derived secret', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-artifact-idempotent-'));
    const secret = 'a'.repeat(64);
    const artifact = await writeSessionPortArtifact({ seed: 'seed', root, secret });
    expect(artifact.token).toBe(`${artifact.portId}.${secret}`);
  });

  it('prunes only stale owned seed/temp names and never follows symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-artifact-prune-'));
    const old = await writeSessionPortArtifact({ seed: 'old', root, now: 1_000 });
    const fresh = await writeSessionPortArtifact({ seed: 'fresh', root, now: 1_000 });
    utimesSync(old.path, new Date(1_000), new Date(1_000));
    utimesSync(fresh.path, new Date(30_000), new Date(30_000));
    const unrelated = join(root, 'keep.txt');
    writeFileSync(unrelated, 'keep');
    const link = join(root, '33333333-3333-4333-8333-333333333333.seed.md');
    symlinkSync(unrelated, link);

    const result = await pruneStaleSessionPortArtifacts({ root, now: 40_000, ttlMs: 20_000 });
    expect(result).toMatchObject({ removed: 1, errors: 0 });
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });
});
