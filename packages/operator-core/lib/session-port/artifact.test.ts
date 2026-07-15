import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSessionPortArtifact, readSessionPortArtifact, writeSessionPortArtifact } from './artifact';

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
});
