/**
 * Tests for the filesystem-backed TokenStorage adapter.
 *
 * Verifies read returns empty when no config exists, update creates the
 * config dir + file, and update is a merge (not a replace).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-storage-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
  // Skip PG mirror — best-effort by design.
  vi.doMock('../plugin-configs-pg', () => ({
    mirrorPluginConfig: async () => undefined,
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  vi.doUnmock('../plugin-configs-pg');
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('fsTokenStorage', () => {
  it('returns empty object when no plugin config exists', async () => {
    const { fsTokenStorage } = await import('./storage-fs');
    const r = await fsTokenStorage.read('p', 'h');
    expect(r).toEqual({});
  });

  it('creates the plugin-configs dir + writes JSON on first update', async () => {
    const { fsTokenStorage } = await import('./storage-fs');
    await fsTokenStorage.update('p', 'h', { token: 'abc' });
    const path = join(TMP_HOME, 'harnesses/h/plugin-configs/p.json');
    const cfg = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(cfg).toEqual({ token: 'abc' });
  });

  it('merges patches into existing config (does not replace)', async () => {
    const { fsTokenStorage } = await import('./storage-fs');
    await fsTokenStorage.update('p', 'h', { token: 'first', other: 'keep-me' });
    await fsTokenStorage.update('p', 'h', { token: 'updated' });
    const r = await fsTokenStorage.read('p', 'h');
    expect(r).toEqual({ token: 'updated', other: 'keep-me' });
  });

  it('handles malformed config files gracefully', async () => {
    // Pre-write garbage.
    const dir = join(TMP_HOME, 'harnesses/h/plugin-configs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'p.json'), '{not json');
    const { fsTokenStorage } = await import('./storage-fs');
    expect(await fsTokenStorage.read('p', 'h')).toEqual({});
  });

  it('handles non-object JSON values by coercing to {}', async () => {
    const dir = join(TMP_HOME, 'harnesses/h/plugin-configs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'p.json'), '"just a string"');
    const { fsTokenStorage } = await import('./storage-fs');
    expect(await fsTokenStorage.read('p', 'h')).toEqual({});
  });

  it('preserves all sibling fields including expiry + refresh tokens', async () => {
    const { fsTokenStorage } = await import('./storage-fs');
    await fsTokenStorage.update('p', 'h', {
      github_token: 'abc',
      github_token_refresh: 'rfr',
      github_token_expires_at: 1234,
      other_field: 'preserved',
    });
    await fsTokenStorage.update('p', 'h', { github_token: 'updated' });
    const r = await fsTokenStorage.read('p', 'h');
    expect(r).toEqual({
      github_token: 'updated',
      github_token_refresh: 'rfr',
      github_token_expires_at: 1234,
      other_field: 'preserved',
    });
  });
});
