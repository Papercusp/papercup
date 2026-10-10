import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sources, productSources, productPortalSources, resolveReviewArgs, reviewCommand, verifySources, verifyProductImports, speechReady } from './review-cloud-tutorial-native.mjs';

test('desktop re-entry keeps caller-relative manifests and roots when its working directory changes', () => {
  const caller = resolve('/caller'), child = resolve('/retained');
  const args = ['--root', '/retained', '--source-root', '.', '--manifest', 'docs/review.json',
    '--out', '../evidence/native', '--portal-root', '../portal', '--portal-source-root', 'portal-current',
    '--profile', 'product-guide'];
  const normalized = resolveReviewArgs(args, caller);
  assert.equal(normalized[normalized.indexOf('--manifest') + 1], resolve(caller, 'docs/review.json'));
  assert.equal(normalized[normalized.indexOf('--out') + 1], resolve(caller, '../evidence/native'));
  assert.equal(normalized[normalized.indexOf('--source-root') + 1], caller);
  assert.equal(normalized[normalized.indexOf('--portal-root') + 1], resolve(caller, '../portal'));
  assert.equal(normalized[normalized.indexOf('--portal-source-root') + 1], resolve(caller, 'portal-current'));
  assert.deepEqual(resolveReviewArgs(normalized, child), normalized);
  assert.deepEqual(args.slice(-2), normalized.slice(-2));
  assert.equal(args[args.indexOf('--manifest') + 1], 'docs/review.json');
  assert.throws(() => resolveReviewArgs(['--manifest', '--desktop'], caller), /Required --manifest/);
  assert.throws(() => resolveReviewArgs(['--out'], caller), /Required --out/);
});

test('declared root source custody paths exist in the reviewed repository', () => {
  for (const path of [...sources, ...productSources]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `Missing reviewed source: ${path}`);
  }
  const portalRoot = process.env.PAPERCUSP_REVIEW_PORTAL_SOURCE_ROOT;
  if (portalRoot) for (const path of productPortalSources) {
    assert.equal(existsSync(join(portalRoot, path)), true, `Missing reviewed Portal source: ${path}`);
  }
});

test('healthy existing Speech Dispatcher is accepted by SSIP without spawning or restarting it', () => {
  const calls = [];
  const modules = speechReady({ run(command, args) {
    calls.push({ command, args });
    assert.equal(command, '/usr/bin/python3');
    assert.match(args[1], /SSIPClient/);
    assert.match(args[1], /list_output_modules/);
    return { status: 0, stdout: '["espeak-ng"]' };
  } });
  assert.deepEqual(modules, ['espeak-ng']);
  assert.equal(calls.length, 1);
});

test('unusable daemon, missing module and invalid SSIP reply fail closed before browser review', () => {
  for (const result of [
    { status: 1, stderr: 'connection refused' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: 'not JSON' },
    { status: null, error: new Error('SSIP deadline') },
  ]) assert.throws(() => speechReady({ run: () => result }));
});

test('source preflight rejects missing scope, duplicate scope, current drift and changed paused fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-at-source-'));
  const current = mkdtempSync(join(tmpdir(), 'native-at-current-'));
  const fixture = 'apps/operator/e2e/cloud-tutorial.spec.ts';
  for (const base of [root, current]) for (const p of [...sources, fixture]) {
    mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), p);
  }
  const manifest = { files: sources.map(path => ({ path, sha256: createHash('sha256').update(path).digest('hex') })) };
  verifySources(root, current, manifest);
  assert.throws(() => verifySources(root, current, { files: manifest.files.slice(1) }), /exactly/);
  assert.throws(() => verifySources(root, current, { files: manifest.files.map(() => manifest.files[0]) }), /exactly/);
  writeFileSync(join(current, sources[0]), 'changed');
  assert.throws(() => verifySources(root, current, manifest), /source drift/);
  writeFileSync(join(current, sources[0]), sources[0]);
  writeFileSync(join(current, fixture), 'changed fixture');
  assert.throws(() => verifySources(root, current, manifest), /fixture source drift/);
});

test('product review refuses drift in either source tree, including its paused Portal fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-product-root-'));
  const sourceRoot = mkdtempSync(join(tmpdir(), 'native-product-current-'));
  const portalRoot = mkdtempSync(join(tmpdir(), 'native-product-portal-'));
  const portalSourceRoot = mkdtempSync(join(tmpdir(), 'native-product-portal-current-'));
  const seed = (roots, files) => {
    for (const base of roots) for (const p of files) {
      mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), p);
    }
    return files.map(path => ({ path, sha256: createHash('sha256').update(path).digest('hex') }));
  };
  const manifest = { files: seed([root, sourceRoot], productSources),
    portalFiles: seed([portalRoot, portalSourceRoot], productPortalSources) };
  const options = { profile: 'product-guide', portalRoot, portalSourceRoot };
  verifySources(root, sourceRoot, manifest, options);
  assert.throws(() => verifySources(root, sourceRoot, manifest, { profile: 'product-guide' }), /both.*roots/);
  assert.throws(() => verifySources(root, sourceRoot, { ...manifest, portalFiles: manifest.portalFiles.slice(1) }, options), /exactly/);
  writeFileSync(join(sourceRoot, productSources[0]), 'changed charge explanation');
  assert.throws(() => verifySources(root, sourceRoot, manifest, options), /Product guide source drift/);
  writeFileSync(join(sourceRoot, productSources[0]), productSources[0]);
  writeFileSync(join(portalSourceRoot, 'e2e/portal-product-tutorial.spec.ts'), 'changed fixture');
  assert.throws(() => verifySources(root, sourceRoot, manifest, options), /Product Portal source drift/);
});

test('review profile selects the maintained Portal script and one explicit pause journey', () => {
  assert.equal(reviewCommand({ root: '/root' }).cwd, '/root/apps/operator');
  assert.deepEqual(reviewCommand({ profile: 'product-guide', root: '/root', portalRoot: '/portal' }), {
    cwd: '/portal', args: ['run', 'test:e2e:browser', '--', 'e2e/portal-product-tutorial.spec.ts', '--headed', '--workers=1',
      '--grep', 'guide precedes portal destination and persists reload with workspace=null$'],
  });
  assert.throws(() => reviewCommand({ profile: 'product-guide', root: '/root' }), /portal-root/);
  assert.throws(() => reviewCommand({ profile: 'unknown', root: '/root' }), /Unknown/);
});

test('product import preflight rejects matching live bytes and redirected package exports', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'native-product-imports-'));
  try {
    const root = join(fixture, 'frozen'), live = join(fixture, 'live');
    for (const base of [root, live]) {
      for (const path of productSources) {
        mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), path);
      }
      writeFileSync(join(base, 'packages/operator-ui/package.json'), JSON.stringify({ name: '@papercusp/operator-ui',
        exports: { './onboarding': './src/onboarding/product-tutorial.tsx', './browser-telemetry': './src/browser-telemetry.tsx' } }));
      writeFileSync(join(base, 'packages/operator-core/package.json'), JSON.stringify({ name: '@papercusp/operator-core',
        exports: { './lib/*': './lib/*.ts' } }));
      mkdirSync(join(base, 'node_modules/@papercusp'), { recursive: true });
      symlinkSync(join(base, 'packages/operator-core'), join(base, 'node_modules/@papercusp/operator-core'));
    }
    const consumer = (name, source) => {
      const portal = join(fixture, name), modules = join(portal, 'node_modules/@papercusp');
      mkdirSync(modules, { recursive: true });
      for (const pkg of ['operator-ui', 'operator-core']) symlinkSync(join(source, 'packages', pkg), join(modules, pkg));
      return portal;
    };
    assert.throws(() => verifyProductImports(root, consumer('live-portal', live)), /imported source escapes/);
    const portal = consumer('frozen-portal', root);
    assert.equal(verifyProductImports(root, portal).length, 5);
    // A package can be pinned while one source child is still linked to the live tree.
    rmSync(join(root, productSources[2])); symlinkSync(join(live, productSources[2]), join(root, productSources[2]));
    assert.throws(() => verifyProductImports(root, portal), /imported source escapes/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('product review filter accepts Playwright file-qualified titles and excludes the other account journey', () => {
  const { args } = reviewCommand({ profile: 'product-guide', root: '/root', portalRoot: '/portal' });
  const filter = new RegExp(args[args.indexOf('--grep') + 1]);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=null'), true);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=assigned-workspace'), false);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=null extra case'), false);
});
