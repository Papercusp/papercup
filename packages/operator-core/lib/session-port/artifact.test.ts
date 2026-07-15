import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeSessionPortArtifact, writeSessionPortArtifact } from './artifact';

describe('session-port artifacts', () => {
  it('writes owner-only, consumes once, and verifies the opaque token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-artifact-'));
    const artifact = await writeSessionPortArtifact({ seed: 'safe seed', root, now: 1_000 });
    expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
    await expect(consumeSessionPortArtifact({
      token: `${artifact.portId}.${'0'.repeat(64)}`,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).rejects.toThrow(/invalid/);
    expect(await consumeSessionPortArtifact({
      token: artifact.token,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).toBe('safe seed');
    await expect(consumeSessionPortArtifact({
      token: artifact.token,
      expectedTokenHash: artifact.tokenHash,
      expectedPath: artifact.path,
      expiresAt: artifact.expiresAt,
      now: 2_000,
    })).rejects.toThrow();
  });
});
