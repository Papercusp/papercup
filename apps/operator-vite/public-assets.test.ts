// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicAssetsPlugin } from './public-assets';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vite-public-assets-'));
  roots.push(root);
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), 'console.log("public-assets-fixture");');
  const put = async (path: string, bytes: string) => {
    const file = join(root, 'public', path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, bytes);
  };
  return { root, put };
}

describe('operator public asset build copy', () => {
  it('builds required assets while pruning docs and swap trees before traversing them', async () => {
    const { root, put } = await fixture();
    const assets = ['wordmark.svg', 'wake-runtime/ort.wasm', 'vditor/lute.js',
      'docs/pagefind/index.pf_index', 'internal/docs-api/schema.json', 'internal/docs.old.notes/readme.txt'];
    for (const path of assets) await put(path, `asset:${path}`);
    for (const directory of ['docs', 'docs.old.123', 'docs.tmp.456']) {
      await put(`internal/${directory}/pagefind/fragment/en.pf_fragment`, 'separately served');
      // A traversal would fail, so success proves exclusion BEFORE descent,
      // rather than copying and deleting the unused tree after the build.
      await symlink(join(root, 'missing-docs-target'), join(root, 'public/internal', directory, 'unreadable-link'));
    }
    let effectiveCopyPublicDir: boolean | undefined;
    await build({ root, configFile: false, logLevel: 'silent', build: { outDir: 'output' },
      plugins: [publicAssetsPlugin(), { name: 'observe-effective-public-copy',
        configResolved(config) { effectiveCopyPublicDir = config.build.copyPublicDir; } }],
    });
    expect(effectiveCopyPublicDir).toBe(false);
    expect(existsSync(join(root, 'output/index.html'))).toBe(true);
    for (const path of assets) expect(await readFile(join(root, 'output', path), 'utf8')).toBe(`asset:${path}`);
    for (const directory of ['docs', 'docs.old.123', 'docs.tmp.456']) {
      expect(existsSync(join(root, 'output/internal', directory))).toBe(false);
      expect(await readFile(join(root, 'public/internal', directory, 'pagefind/fragment/en.pf_fragment'), 'utf8'))
        .toBe('separately served');
    }
  });

  it('honors an explicit public-copy opt out', async () => {
    const { root, put } = await fixture();
    await put('wordmark.svg', 'unused');
    await build({ root, configFile: false, logLevel: 'silent',
      build: { copyPublicDir: false }, plugins: [publicAssetsPlugin()] });
    expect(existsSync(join(root, 'dist/wordmark.svg'))).toBe(false);
  });

  it('leaves write:false builds on their existing in-memory path', async () => {
    const { root, put } = await fixture();
    await put('wordmark.svg', 'unused');
    await build({ root, configFile: false, logLevel: 'silent',
      build: { write: false }, plugins: [publicAssetsPlugin()] });
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('accepts builds without a public directory', async () => {
    const { root } = await fixture();
    await build({ root, configFile: false, logLevel: 'silent', plugins: [publicAssetsPlugin()] });
    expect(existsSync(join(root, 'dist/index.html'))).toBe(true);
  });

  it('fails the build when a required public asset cannot be copied', async () => {
    const { root, put } = await fixture();
    await put('wordmark.svg', 'required');
    await symlink(join(root, 'missing-runtime'), join(root, 'public/runtime.wasm'));
    await expect(build({ root, configFile: false, logLevel: 'silent', plugins: [publicAssetsPlugin()] })).rejects.toThrow();
  });
});
