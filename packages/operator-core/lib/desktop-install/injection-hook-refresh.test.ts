import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshInjectionHooks } from './injection-hook-refresh';

let root: string, home: string, source: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'injection-refresh-'));
  home = join(root, 'home'); source = join(root, 'source');
  await mkdir(join(source, 'adapters'), { recursive: true });
  await writeFile(join(source, 'index.mjs'), 'export const version = 1;');
  await writeFile(join(source, 'core.mjs'), 'export const attempts = 1;');
  await writeFile(join(source, 'adapters', 'codex.mjs'), 'export const client = "codex";');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function copyBundle() {
  const files: string[] = [];
  for (const relative of ['', 'adapters']) {
    const destination = join(home, '.papercusp', 'hooks', 'inject', relative);
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(join(source, relative))) {
      if (!name.endsWith('.mjs')) continue;
      await copyFile(join(source, relative, name), join(destination, name));
      files.push(join(relative, name));
    }
  }
  return files;
}

describe('injection bundle freshness after bootstrap', () => {
  it('refreshes changed code and new modules while unchanged launches do not reinstall', async () => {
    const install = vi.fn(copyBundle);
    expect(await refreshInjectionHooks(home,source,install)).toMatchObject({status:'refreshed'});
    expect(await refreshInjectionHooks(home,source,install)).toMatchObject({status:'current'});
    expect(install).toHaveBeenCalledTimes(1);
    await writeFile(join(source,'core.mjs'),'export const attempts = 2;');
    await writeFile(join(source,'adapters','shared.mjs'),'export const version = 2;');
    expect(await refreshInjectionHooks(home,source,install)).toMatchObject({status:'refreshed'});
    expect(await readFile(join(home,'.papercusp/hooks/inject/core.mjs'),'utf8')).toContain('attempts = 2');
    expect(await readFile(join(home,'.papercusp/hooks/inject/adapters/shared.mjs'),'utf8')).toContain('version = 2');
    expect(install).toHaveBeenCalledTimes(2);
  });
  it('single-flights concurrent checks and retries refused or incomplete installs', async () => {
    expect(await refreshInjectionHooks(home,source,async()=>[])).toMatchObject({status:'deferred'});
    expect(await refreshInjectionHooks(home,source,async()=>['index.mjs'])).toMatchObject({status:'deferred'});
    const install = vi.fn(copyBundle);
    const [a,b] = await Promise.all([refreshInjectionHooks(home,source,install),refreshInjectionHooks(home,source,install)]);
    expect(a).toEqual(b); expect(a.status).toBe('refreshed');
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('repairs installed drift but never publishes an incomplete source', async () => {
    await copyBundle();
    await writeFile(join(home,'.papercusp/hooks/inject/core.mjs'),'old installed code');
    const install = vi.fn(copyBundle);
    expect(await refreshInjectionHooks(home,source,install)).toMatchObject({status:'refreshed'});
    await rm(join(source,'index.mjs'));
    expect(await refreshInjectionHooks(home,source,install)).toMatchObject({status:'unavailable'});
    expect(install).toHaveBeenCalledTimes(1);
  });
});
