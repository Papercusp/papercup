import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureVerifierDependencies, prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import { buildRuntimeGeneratedInputs, verifyRuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { packRuntimeSourceImage } from './blind-review-source-image';
import { admitRuntimeSourceImage } from './blind-review-source-admission';
import { git, write } from './source-preview.fixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
const policy = fileURLToPath(new URL('../../../apps/operator/bin/release/dependency-generation.sh', import.meta.url));

async function fixture(options: { gitCheckout?: boolean; omitAssets?: boolean } = {}) {
  const custodyRoot = mkdtempSync(join(tmpdir(), 'broker-generated-')); roots.push(custodyRoot);
  const repositoryRoot = join(custodyRoot, 'repo'), root = join(custodyRoot, 'source'); mkdirSync(repositoryRoot);
  write(repositoryRoot, 'package.json', JSON.stringify({ name: 'build-fixture', private: true, workspaces: ['apps/operator-vite'] }));
  write(repositoryRoot, 'apps/operator-vite/package.json', JSON.stringify({ name: '@papercusp/operator-vite',
    scripts: { prebuild: 'node ../operator/bin/build.cjs prebuild', build: 'node ../operator/bin/build.cjs spa' } }));
  write(repositoryRoot, 'apps/operator/bin/build.cjs', `
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
function put(p,s){p=path.join(root,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);}
if(process.argv[2]==='prebuild') {
 if(process.env.BROKER_HOST_SECRET || process.env.VITEST || process.env.PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE) process.exit(90);
 put('apps/operator/public/wake-runtime/runtime.js','measured prebuild');
} else if(process.argv[2]==='spa') {
 put('apps/operator/dist-verify/spa/index.html','<html>measured spa</html>');
 if (${!options.omitAssets}) put('apps/operator/dist-verify/spa/assets/main.js','measured browser code');
} else put('apps/operator/dist-verify/hono-host.mjs','export const marker="measured host";');
`);
  write(repositoryRoot, 'apps/operator/scripts/setup-porcupine-runtime.sh', '#!/bin/bash\nset -eu\nmkdir -p apps/operator/public/porcupine\nprintf "measured model" > apps/operator/public/porcupine/porcupine_params.pv\n');
  write(repositoryRoot, 'apps/operator/bin/bundle-host.sh', '#!/bin/bash\nset -eu\nnode apps/operator/bin/build.cjs host\n');
  write(repositoryRoot, 'scripts/pc-heavy.sh', '#!/bin/bash\nset -eu\n[ "$1" != -- ] || shift\nexec "$@"\n');
  write(repositoryRoot, 'papercusp-desktop/bin/lib/pinned-deps.sh', '#!/bin/bash\n[ "$1" = trees ] || exit 2\nprintf "node_modules\\n"\n');
  write(repositoryRoot, 'apps/operator/bin/release/dependency-generation.sh', readFileSync(policy, 'utf8'));
  chmodSync(join(repositoryRoot, 'scripts/pc-heavy.sh'), 0o755);
  git(repositoryRoot, ['init', '-q']); git(repositoryRoot, ['add', '.']); git(repositoryRoot, ['commit', '-qm', 'fixed build fixture']);
  // The maintained Git verifier checks HEAD^ as well as the exact selected pin.
  git(repositoryRoot, ['commit', '--allow-empty', '-qm', 'fixture parent boundary']);
  const source = await prepareVerifierSource({ repo: repositoryRoot, ref: git(repositoryRoot, ['rev-parse', 'HEAD']),
    dest: root, inputs: ['apps/operator/bin/build.cjs'], gitCheckout: options.gitCheckout });
  write(root, 'node_modules/dep/index.js', 'measured dependency');
  const dependencies = captureVerifierDependencies({ dest: root, receipt: source });
  return { root, repositoryRoot, custodyRoot, source, dependencies };
}

describe('broker generated build closure', () => {
  it('measures fixed build outputs and boots all three output classes from the same sealed image after donor removal', async () => {
    const f = await fixture({ gitCheckout: true }); const generated = await buildRuntimeGeneratedInputs(f);
    expect(Object.isFrozen(generated.files)).toBe(true);
    expect(generated.files.map(file => file.path)).toContain('apps/operator/public/wake-runtime/runtime.js');
    const image = await packRuntimeSourceImage({ ...f, generated });
    try {
      await expect(admitRuntimeSourceImage({ ...image }, { repositoryId: 'fixture-repository' }))
        .rejects.toThrow('broker_source_origin_unavailable');
      // Change the mutable preparation after sealing. Admission must inspect
      // only the retained image and compare with independent committed Git bytes.
      write(f.root, 'apps/operator/bin/build.cjs', 'changed donor bytes');
      const admission = await admitRuntimeSourceImage(image, { repositoryId: 'fixture-repository' });
      expect(admission.censusStatus).toBe('admit');
      expect(admission.sourceImageNonce).toBe(image.sourceImageNonce);
      rmSync(f.root, { recursive: true }); rmSync(f.repositoryRoot, { recursive: true });
      const result = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'seal-exec', '--sha256', image.imageSha256,
        '--max-bytes', String(image.imageBytes), '--', '/usr/bin/python3', '-I', '-S', helper,
        'mount-exec', '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', `
import json,os
assert 'measured host' in open('/source/apps/operator/dist-verify/hono-host.mjs').read()
assert 'measured spa' in open('/source/apps/operator/dist-verify/spa/index.html').read()
assert open('/source/apps/operator/public/wake-runtime/runtime.js').read() == 'measured prebuild'
build=json.load(open('/source/.broker-build.json'))
assert len(build['files']) >= 5
assert not os.path.exists('/source/.git')
print('GENERATED_CLOSURE_BOOTED')`],
      { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 20_000 });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('GENERATED_CLOSURE_BOOTED');
    } finally { await image.handle.close(); }
  }, 30_000);

  it.each(['generated-bytes', 'unrecorded-output', 'dependency-bytes', 'source-bytes', 'redirect'])(
    'refuses changed closure before image publication (%s)', async defect => {
      const f = await fixture(); const generated = await buildRuntimeGeneratedInputs(f);
      if (defect === 'generated-bytes') write(f.root, 'apps/operator/dist-verify/hono-host.mjs', 'changed');
      if (defect === 'unrecorded-output') write(f.root, 'apps/operator/dist-verify/new.mjs', 'unknown');
      if (defect === 'dependency-bytes') write(f.root, 'node_modules/dep/index.js', 'changed');
      if (defect === 'source-bytes') write(f.root, 'apps/operator/bin/build.cjs', 'changed');
      if (defect === 'redirect') {
        rmSync(join(f.root, 'apps/operator/dist-verify/hono-host.mjs'));
        symlinkSync('/etc/passwd', join(f.root, 'apps/operator/dist-verify/hono-host.mjs'));
      }
      await expect(packRuntimeSourceImage({ ...f, generated })).rejects.toThrow();
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
    }, 30_000);

  it('rejects receipt-shaped copies and never adopts pre-existing generated outputs', async () => {
    const f = await fixture(); const generated = await buildRuntimeGeneratedInputs(f);
    await expect(verifyRuntimeGeneratedInputs(f.root, f.source, f.dependencies,
      JSON.parse(JSON.stringify(generated)))).rejects.toThrow('broker_generated_provenance_invalid');
    await expect(buildRuntimeGeneratedInputs(f)).rejects.toThrow('broker_generated_output_already_exists');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  }, 30_000);

  it('requires complete build output even when every build command exits successfully', async () => {
    const f = await fixture({ omitAssets: true });
    await expect(buildRuntimeGeneratedInputs(f)).rejects.toThrow('broker_generated_build_incomplete');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  }, 30_000);

  it('honors cancellation before allocating private build state', async () => {
    const f = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(buildRuntimeGeneratedInputs({ ...f, signal: controller.signal })).rejects.toThrow();
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  });
});
