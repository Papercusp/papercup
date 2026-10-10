import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireAcceptanceDependencies } from './release-acceptance-cache';
import type { HolderScan } from '../release-cut-reclaim';

const idle = async (): Promise<HolderScan> => ({ verified: true, holders: new Map() });
describe('PUI acceptance dependency retirement', () => {
  let cache: string;
  let checkout: string;
  let sha: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), 'pui-cache-retirement-'));
    checkout = join(cache, 'slot-1');
    await mkdir(checkout);
    execFileSync('git', ['init', '-q', checkout]);
    await writeFile(join(checkout, 'source.txt'), 'source evidence');
    // Fixture commits are private test repositories, not the shared tree.
    execFileSync('git', ['-C', checkout, 'add', 'source.txt']);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    sha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    for (const tree of ['node_modules', 'apps/operator/node_modules']) {
      await mkdir(join(checkout, tree), { recursive: true });
      await writeFile(join(checkout, tree, 'package.txt'), 'rebuildable');
    }
    await mkdir(join(checkout, '.papercusp-artifacts'));
    await writeFile(join(checkout, '.papercusp-artifacts', 'receipt.json'), 'retained');
  });
  afterEach(async () => { await rm(cache, { recursive: true, force: true }); });

  it('previews and retires only named dependencies while retaining source and receipts', async () => {
    const input = { checkout, expectedSha: sha, trees: ['node_modules'], scan: idle };
    expect((await retireAcceptanceDependencies(input)).removed).toEqual([]);
    expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    expect((await retireAcceptanceDependencies({ ...input, execute: true })).removed).toEqual([join(checkout, 'node_modules')]);
    await expect(readFile(join(checkout, 'node_modules/package.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('source evidence');
    expect(await readFile(join(checkout, '.papercusp-artifacts/receipt.json'), 'utf8')).toBe('retained');
    expect(await readFile(join(checkout, 'apps/operator/node_modules/package.txt'), 'utf8')).toBe('rebuildable');
  });

  it.each(['../node_modules', 'source.txt', 'node_modules/nested', '/node_modules'])('rejects out-of-scope target %s', async (tree) => {
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: [tree], execute: true, scan: idle })).rejects.toThrow('not a dependency tree');
  });
  it('refuses stale source commits and symlinked dependency paths', async () => {
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: '0'.repeat(40), trees: ['node_modules'], scan: idle })).rejects.toThrow('source commit changed');
    await mkdir(join(cache, 'outside'));
    await symlink(join(cache, 'outside'), join(checkout, 'packages'));
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['packages/other/node_modules'], scan: idle })).resolves.toMatchObject({ candidates: [] });
    await mkdir(join(cache, 'outside/other/node_modules'), { recursive: true });
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['packages/other/node_modules'], execute: true, scan: idle })).rejects.toThrow('physical directory');
  });
  it('refuses live or unverified process use before deleting anything', async () => {
    for (const result of [{ verified: false, holders: new Map() }, { verified: true, holders: new Map([[checkout, ['live']]]) }]) {
      await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['node_modules'], execute: true, scan: async () => result })).rejects.toThrow();
      expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    }
  });
  it('the existing wrapper refuses retirement while a slot lock is held', async () => {
    const child = spawn('flock', [join(cache, 'slot-1.lock'), 'sh', '-c', 'echo READY; cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const result = spawnSync('bash', [resolve(__dirname, '../../../../apps/tui/scripts/release-acceptance.sh'), '--retire-dependencies', '1', sha, 'node_modules', '--execute'], {
        env: { ...process.env, PUI_ACCEPTANCE_CHECKOUT_ROOT: cache }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('slot 1 is held');
      expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    } finally {
      child.stdin.end();
      if (child.exitCode === null) await once(child, 'close');
    }
  });
});
