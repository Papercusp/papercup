/**
 * Coverage for branch-action-manifest: normalizeButtonDecl (string vs object
 * form, POST default) and resolveEnv (literal/plugin/config/harness source
 * resolution + missing-required tracking). resolveEnv reads real temp config
 * files under a harnessConfigsDir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeButtonDecl, resolveEnv } from './branch-action-manifest';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bam-'));
  mkdirSync(join(dir, 'plugin-configs'), { recursive: true });
  writeFileSync(join(dir, 'plugin-configs', 'myplug.json'), JSON.stringify({ apiKey: 'xyz' }));
  writeFileSync(join(dir, 'plugin-configs', 'cp.json'), JSON.stringify({ k: 'v' }));
  writeFileSync(join(dir, 'env.json'), JSON.stringify({ TOKEN: 't' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest = (env: Record<string, any>) => ({ name: 'a', env }) as never;

describe('normalizeButtonDecl', () => {
  it('expands a string to { url, method:POST }', () => {
    expect(normalizeButtonDecl('/api/x')).toEqual({ url: '/api/x', method: 'POST' });
  });
  it('passes object fields through, defaulting method to POST', () => {
    expect(normalizeButtonDecl({ url: '/api/y', displayName: 'Go', description: 'd' })).toEqual({
      url: '/api/y',
      method: 'POST',
      displayName: 'Go',
      description: 'd',
    });
    expect(normalizeButtonDecl({ url: '/api/z', method: 'GET' }).method).toBe('GET');
  });
});

describe('resolveEnv', () => {
  it('returns empty when the manifest has no env', async () => {
    expect(await resolveEnv(undefined, { harnessConfigsDir: dir })).toEqual({ env: {}, missing: [] });
  });

  it('resolves a literal source', async () => {
    const r = await resolveEnv(manifest({ FOO: { from: 'literal', value: 'bar' } }), { harnessConfigsDir: dir });
    expect(r.env).toEqual({ FOO: 'bar' });
  });

  it('resolves a plugin-config source', async () => {
    const r = await resolveEnv(
      manifest({ KEY: { from: 'plugin', plugin: 'myplug', field: 'apiKey' } }),
      { harnessConfigsDir: dir },
    );
    expect(r.env).toEqual({ KEY: 'xyz' });
  });

  it('resolves a harness env.json source', async () => {
    const r = await resolveEnv(manifest({ VAR: { from: 'harness', field: 'TOKEN' } }), { harnessConfigsDir: dir });
    expect(r.env).toEqual({ VAR: 't' });
  });

  it('resolves a config source against the contributing plugin', async () => {
    const r = await resolveEnv(
      manifest({ C: { from: 'config', field: 'k' } }),
      { harnessConfigsDir: dir, contributingPlugin: 'cp' },
    );
    expect(r.env).toEqual({ C: 'v' });
  });

  it('records a required config source as missing when no contributing plugin', async () => {
    const r = await resolveEnv(
      manifest({ C: { from: 'config', field: 'k', required: true, description: 'need it' } }),
      { harnessConfigsDir: dir },
    );
    expect(r.env).toEqual({});
    expect(r.missing).toEqual([
      expect.objectContaining({ name: 'C', from: 'config', field: 'k', description: 'need it' }),
    ]);
  });

  it('records a required plugin source as missing when the field is absent', async () => {
    const r = await resolveEnv(
      manifest({ R: { from: 'plugin', plugin: 'myplug', field: 'absent', required: true } }),
      { harnessConfigsDir: dir },
    );
    expect(r.env).toEqual({});
    expect(r.missing).toEqual([expect.objectContaining({ name: 'R', from: 'plugin', plugin: 'myplug' })]);
  });
});
