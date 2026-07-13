/**
 * secret-ref.test.ts — resolveSecretRef (B-PROV, WI-288).
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/secret-ref.test.ts
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecretRef } from './secret-ref';

afterEach(() => {
  delete process.env.EGRESS_TEST_SECRET;
});

describe('resolveSecretRef', () => {
  it('resolves env:NAME from process.env', async () => {
    process.env.EGRESS_TEST_SECRET = 'shh';
    await expect(resolveSecretRef('env:EGRESS_TEST_SECRET')).resolves.toBe('shh');
  });

  it('throws when the env var is unset', async () => {
    await expect(resolveSecretRef('env:EGRESS_TEST_SECRET')).rejects.toThrow(/not set/);
  });

  it('resolves file:<path> to the trimmed file contents', async () => {
    const path = join(tmpdir(), `egress-secret-${Date.now()}.txt`);
    await fs.writeFile(path, '  key-value-123  \n');
    try {
      await expect(resolveSecretRef(`file:${path}`)).resolves.toBe('key-value-123');
    } finally {
      await fs.unlink(path);
    }
  });

  it('throws for an unsupported ref shape', async () => {
    await expect(resolveSecretRef('ftp:whatever')).rejects.toThrow(/unsupported secret ref/);
  });

  it('throws for an empty secret file', async () => {
    const path = join(tmpdir(), `egress-secret-empty-${Date.now()}.txt`);
    await fs.writeFile(path, '   \n');
    try {
      await expect(resolveSecretRef(`file:${path}`)).rejects.toThrow(/empty/);
    } finally {
      await fs.unlink(path);
    }
  });
});
