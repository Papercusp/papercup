import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packRuntimeTarball } from './runtime-pack';
import { resolveRuntimeTarball } from './bootstrap-input';

describe('packRuntimeTarball', () => {
  it('packs the tree and applies the default excludes (.git / node_modules / target)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-pack-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"x"}');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'index.ts'), 'export {}');
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: x');
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'dep', 'big.js'), '//');
      mkdirSync(join(root, 'sub', 'target'), { recursive: true });
      writeFileSync(join(root, 'sub', 'target', 'bin'), 'x');
      mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
      writeFileSync(join(root, 'apps', 'operator', '.env.local'), 'SECRET=1');
      // root backups/ (kopia repo) is excluded; a NESTED source dir named
      // backups/ must SURVIVE (app/settings/backups bit us live).
      mkdirSync(join(root, 'backups'), { recursive: true });
      writeFileSync(join(root, 'backups', 'snap.bin'), 'x');
      mkdirSync(join(root, 'apps', 'operator', 'app', 'backups'), { recursive: true });
      writeFileSync(join(root, 'apps', 'operator', 'app', 'backups', 'page.tsx'), 'export {}');

      const out = join(root, '..', 'pc-pack-out.tgz');
      const { bytes } = await packRuntimeTarball(root, out);
      expect(bytes).toBeGreaterThan(0);

      const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
      expect(listing).toContain('./package.json');
      expect(listing).toContain('./src/index.ts');
      expect(listing).not.toContain('.git/HEAD');
      expect(listing).not.toContain('node_modules');
      expect(listing).not.toContain('target/bin');
      // security: env files (live secrets + host-specific config) never ship
      expect(listing).not.toContain('.env.local');
      // root backups excluded; nested source backups survives
      expect(listing).not.toContain('./backups/snap.bin');
      expect(listing).toContain('./apps/operator/app/backups/page.tsx');
      rmSync(out, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveRuntimeTarball', () => {
  it('reads provider.runtimeTarball and expands ~', () => {
    expect(resolveRuntimeTarball({ target: 'latitude' })).toBeUndefined();
    expect(
      resolveRuntimeTarball({ target: 'latitude', provider: { runtimeTarball: '/x/r.tgz' } }),
    ).toBe('/x/r.tgz');
    expect(
      resolveRuntimeTarball({ target: 'latitude', provider: { runtimeTarball: '~/r.tgz' } }),
    ).toBe(`${process.env.HOME}/r.tgz`);
  });
});
