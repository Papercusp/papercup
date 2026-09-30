import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  embeddedPgMajor,
  hostPgvectorCandidates,
  installEmbeddedPgvector,
  runtimeDirs,
} from './install-embedded-pgvector.mjs';

function fakeCheckout({ version = '18.3.0-beta.17', flat = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'emb-pgv-'));
  const pkgDir = join(root, 'node_modules', '@embedded-postgres', 'linux-x64');
  const nativeDir = join(pkgDir, 'native');
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@embedded-postgres/linux-x64', version }));
  if (flat) {
    mkdirSync(join(nativeDir, 'lib'), { recursive: true });
    mkdirSync(join(nativeDir, 'share', 'extension'), { recursive: true });
    writeFileSync(join(nativeDir, 'lib', 'pgcrypto.so'), '');
  }
  return { root, nativeDir };
}

function fakeHostPgvector() {
  const dir = mkdtempSync(join(tmpdir(), 'host-pgv-'));
  const extDir = join(dir, 'extension');
  mkdirSync(extDir);
  writeFileSync(join(dir, 'vector.so'), 'ELF');
  writeFileSync(join(extDir, 'vector.control'), "default_version = '0.8.1'");
  writeFileSync(join(extDir, 'vector--0.8.1.sql'), '-- sql');
  writeFileSync(join(extDir, 'unrelated.sql'), '-- not ours');
  return { PAPERCUSP_PGVECTOR_LIB: join(dir, 'vector.so'), PAPERCUSP_PGVECTOR_EXT_DIR: extDir };
}

test('embeddedPgMajor reads the Postgres major from the package version', () => {
  assert.equal(embeddedPgMajor('18.3.0-beta.17'), 18);
  assert.equal(embeddedPgMajor('17.6.0'), 17);
  assert.equal(embeddedPgMajor(undefined), null);
});

test('linux candidates target the embedded major, never another', () => {
  const [candidate] = hostPgvectorCandidates({ platform: 'linux', major: 18, env: {} });
  assert.equal(candidate.lib, '/usr/lib/postgresql/18/lib/vector.so');
  assert.equal(candidate.extDir, '/usr/share/postgresql/18/extension');
});

test('a fresh npm ci tree gets pgvector copied into the Debian-style layout', () => {
  const { root, nativeDir } = fakeCheckout();
  const report = installEmbeddedPgvector({ root, platform: 'linux', env: fakeHostPgvector(), log: () => {} });
  assert.equal(report.trees[0].status, 'installed');
  assert.equal(report.trees[0].sqlFiles, 1);
  assert.ok(existsSync(join(nativeDir, 'lib', 'postgresql', 'vector.so')));
  assert.ok(existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'vector.control')));
  assert.ok(existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'vector--0.8.1.sql')));
  assert.ok(!existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'unrelated.sql')));
});

test('the flat layout is honoured when the tree uses it', () => {
  const { root, nativeDir } = fakeCheckout({ flat: true });
  assert.deepEqual(runtimeDirs(nativeDir), { libDir: join(nativeDir, 'lib'), extDir: join(nativeDir, 'share', 'extension') });
  installEmbeddedPgvector({ root, platform: 'linux', env: fakeHostPgvector(), log: () => {} });
  assert.ok(existsSync(join(nativeDir, 'lib', 'vector.so')));
  assert.ok(existsSync(join(nativeDir, 'share', 'extension', 'vector.control')));
});

test('a second run is a no-op once pgvector is present', () => {
  const { root, nativeDir } = fakeCheckout();
  const env = fakeHostPgvector();
  installEmbeddedPgvector({ root, platform: 'linux', env, log: () => {} });
  writeFileSync(join(nativeDir, 'lib', 'postgresql', 'vector.so'), 'SENTINEL');
  const report = installEmbeddedPgvector({ root, platform: 'linux', env, log: () => {} });
  assert.equal(report.trees[0].status, 'present');
  assert.equal(readFileSync(join(nativeDir, 'lib', 'postgresql', 'vector.so'), 'utf8'), 'SENTINEL');
});

test('a host without pgvector is reported with an install hint, not silently skipped', () => {
  const { root } = fakeCheckout({ version: '99.0.0' });
  const report = installEmbeddedPgvector({ root, platform: 'linux', env: {}, log: () => {} });
  assert.equal(report.trees[0].status, 'missing-source');
  assert.equal(report.missingSource.length, 1);
  assert.match(report.missingSource[0].hint, /postgresql-99-pgvector/);
});

test('no embedded-postgres install means nothing to do', () => {
  const root = mkdtempSync(join(tmpdir(), 'emb-pgv-empty-'));
  assert.deepEqual(installEmbeddedPgvector({ root, platform: 'linux', env: {}, log: () => {} }), { trees: [], missingSource: [] });
});
