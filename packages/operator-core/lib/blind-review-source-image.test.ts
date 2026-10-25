import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureVerifierDependencies, prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import { git, write } from './source-preview.fixture';
import { packRuntimeSourceImage, prepareRuntimeSourceImage, type RuntimeSourceImage } from './blind-review-source-image';

const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
const policy = fileURLToPath(new URL('../../../apps/operator/bin/release/dependency-generation.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const custodyRoot = mkdtempSync(join(tmpdir(), 'broker-producer-')); roots.push(custodyRoot);
  const repo = join(custodyRoot, 'repo'), root = join(custodyRoot, 'frozen');
  mkdirSync(repo);
  write(repo, 'package.json', '{"name":"broker-fixture","private":true}');
  write(repo, 'src/input.ts', 'export const marker = "committed source";\n');
  write(repo, 'papercusp-desktop/bin/lib/pinned-deps.sh', '#!/bin/bash\n[ "$1" = trees ] || exit 2\nprintf "node_modules\\n"\n');
  write(repo, 'apps/operator/bin/release/dependency-generation.sh', readFileSync(policy, 'utf8'));
  write(repo, 'bin/run', '#!/bin/sh\nprintf "recorded executable"\n'); chmodSync(join(repo, 'bin/run'), 0o755);
  symlinkSync('src/input.ts', join(repo, 'source-link'));
  git(repo, ['init', '-q']); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'pinned broker fixture']);
  const source = await prepareVerifierSource({ repo, ref: git(repo, ['rev-parse', 'HEAD']),
    dest: root, inputs: ['src/input.ts'] });
  // The production dependency census/writer measures these installed bytes,
  // including its real exclusions and a real workspace symlink.
  write(root, 'node_modules/dep/index.js', 'module.exports = "measured dependency";\n');
  write(root, 'node_modules/.cache/ambient-secret', 'MUST_NOT_SHIP');
  symlinkSync('../src', join(root, 'node_modules/workspace-source'));
  const dependencies = captureVerifierDependencies({ dest: root, receipt: source });
  return { root, custodyRoot, source, dependencies };
}

function mount(image: RuntimeSourceImage, code: string, manifestSha256 = image.manifestSha256) {
  return spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'seal-exec', '--sha256', image.imageSha256,
    '--max-bytes', String(image.imageBytes), '--', '/usr/bin/python3', '-I', '-S', helper,
    'mount-exec', '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
    '--manifest-sha256', manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', code],
  { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 20_000 });
}

describe('canonical broker source image producer', () => {
  it('boots the real sealed closure with measured dependencies, manifests and executable modes after donor removal', async () => {
    const f = await fixture();
    const image = await packRuntimeSourceImage(f);
    try {
      expect((await image.handle.stat()).nlink).toBe(0);
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
      rmSync(f.root, { recursive: true });
      const result = mount(image, `
import os,json,errno,hashlib
assert 'committed source' in open('/source/src/input.ts').read()
assert 'committed source' in open('/source/node_modules/workspace-source/input.ts').read()
assert 'measured dependency' in open('/source/node_modules/dep/index.js').read()
assert os.readlink('/source/source-link') == 'src/input.ts'
assert os.stat('/source/bin/run').st_mode & 0o111
assert not os.path.exists('/source/node_modules/.cache')
manifest=json.load(open('/source/.broker-closure.json'))
deps=json.load(open('/source/.broker-dependencies.json'))
assert deps['root'] == '/source'
paths={row['path'] for row in manifest['files']}
assert {'.verifier-source.json','.broker-dependencies.json'} <= paths
assert manifest['sourceReceiptSha256'] == deps['sourceReceiptSha256']
assert hashlib.sha256(open('/source/.broker-dependencies.json','rb').read()).hexdigest() == manifest['dependenciesReceiptSha256']
try: open('/source/src/input.ts','w')
except OSError as error: assert error.errno == errno.EROFS
else: raise AssertionError('source writable')
print('CANONICAL_CLOSURE_BOOTED')`);
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('CANONICAL_CLOSURE_BOOTED');
    } finally { await image.handle.close(); }
  });

  it('refuses a wrong manifest pin before executing the child and does not rely on receipt-shaped metadata', async () => {
    const f = await fixture(); const image = await packRuntimeSourceImage(f);
    try {
      const result = mount(image, "print('CHILD_EXECUTED')", '0'.repeat(64));
      expect(result.status).toBe(3); expect(result.stdout).not.toContain('CHILD_EXECUTED');
      expect(result.stderr).toContain('SEALED_SOURCE_REFUSED');
    } finally { await image.handle.close(); }
  });

  it.each(['dependency-bytes', 'omitted-dependency', 'source-bytes', 'unrecorded-source', 'source-receipt'])(
    'refuses changed or incomplete verifier provenance (%s) without publishing an image', async defect => {
      const f = await fixture();
      if (defect === 'dependency-bytes') write(f.root, 'node_modules/dep/index.js', 'changed');
      if (defect === 'omitted-dependency') f.dependencies.trees[0]!.files.pop();
      if (defect === 'source-bytes') write(f.root, 'src/input.ts', 'changed');
      if (defect === 'unrecorded-source') write(f.root, 'unrecorded.ts', 'unknown input');
      if (defect === 'source-receipt') write(f.root, '.verifier-source.json', '{}');
      await expect(packRuntimeSourceImage(f)).rejects.toThrow();
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
    });

  it('refuses escaping dependency symlinks through the canonical dependency census', async () => {
    const f = await fixture();
    symlinkSync('/etc/passwd', join(f.root, 'node_modules/escape'));
    await expect(packRuntimeSourceImage(f)).rejects.toThrow('symlink escapes source root');
  });

  it('honors cancellation before allocating image storage and requires an exact source commit', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(packRuntimeSourceImage({ ...f, signal: controller.signal })).rejects.toThrow();
    await expect(prepareRuntimeSourceImage({ repositoryRoot: f.root, custodyRoot: f.custodyRoot,
      sourceCommit: 'HEAD', inputs: ['src/input.ts'] })).rejects.toThrow('broker_requires_exact_commit');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
  });
});
