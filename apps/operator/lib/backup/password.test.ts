import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Password derivation is the only piece of backup we can unit-test
 * without a live PG + kopia binary. The rest is verified by the
 * smoke test (run manually against a scratch workspace, see README).
 */
describe('deriveRepoPassword', () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'backup-pw-test-'));
    await mkdir(join(tmp, '.papercusp'), { recursive: true });
    // Deterministic 32-byte hex key
    await writeFile(
      join(tmp, '.papercusp', 'db-encryption-key'),
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  it('produces 256-bit base64url passwords', async () => {
    // re-import after HOME mutation so the module resolves the test dir
    const mod = await import('./password');
    const pw = await mod.deriveRepoPassword('test-workspace');
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding)
    expect(pw.length).toBe(43);
  });

  it('is deterministic for the same workspace', async () => {
    const mod = await import('./password');
    const a = await mod.deriveRepoPassword('ws-a');
    const b = await mod.deriveRepoPassword('ws-a');
    expect(a).toBe(b);
  });

  it('differs across workspaces (per-workspace isolation)', async () => {
    const mod = await import('./password');
    const a = await mod.deriveRepoPassword('ws-a');
    const b = await mod.deriveRepoPassword('ws-b');
    expect(a).not.toBe(b);
  });
});
