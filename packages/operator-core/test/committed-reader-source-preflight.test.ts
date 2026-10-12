import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifierSourceFiles } from '../lib/verifier-source';
import { qualifyCommittedReaderSource, type CommittedReaderClosure } from './private-http-workspace-preflight';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reader-source-preflight-')); temporary.push(dir);
  const root = join(dir, 'source'); const prepared = join(dir, 'prepare');
  mkdirSync(root); mkdirSync(prepared);
  for (const name of ['reader.test.ts', 'helper.ts', 'config.ts', 'import.ts', 'asset.sql']) writeFileSync(join(root, name), name);
  const source = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
    testedInputs: [{ path: 'reader.test.ts', sha256: digest('reader.test.ts') }], files: verifierSourceFiles(root) };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(source));
  const sourceReceiptPath = join(dir, 'source-receipt.json'); writeFileSync(sourceReceiptPath, JSON.stringify(source));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  mkdirSync(join(modules, 'example'));
  writeFileSync(join(modules, 'example', 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
  writeFileSync(join(modules, 'example', 'index.js'), 'module.exports = 1');
  // Match the private worker's maintained dependency resolution from its bundle.
  symlinkSync(modules, join(dir, 'node_modules'), 'dir');
  const bundle = join(prepared, 'hono-host.mjs'); writeFileSync(bundle, 'export const host = 1;');
  const copiedAsset = join(prepared, 'asset.sql'); writeFileSync(copiedAsset, 'asset.sql');
  const graph = { inputs: {
    'helper.ts': { imports: [{ path: 'import.ts' }, { path: 'example', external: true }, { path: 'node:fs', external: true }] },
    'import.ts': { imports: [] },
  }, outputs: { 'hono-host.mjs': { imports: [{ path: 'example', external: true }] } } };
  writeFileSync(`${bundle}.meta.json`, JSON.stringify(graph));
  const closure: CommittedReaderClosure = { sourceCommit: source.sourceCommit, sha256: digest(readFileSync(bundle)),
    metafileSha256: digest(readFileSync(`${bundle}.meta.json`)), testPaths: ['reader.test.ts'],
    helperPaths: ['helper.ts'], configPaths: ['config.ts'], executedImports: ['helper.ts', 'import.ts'],
    dependencyFiles: verifierSourceFiles(modules), externalResolutions: { example: 'node_modules/example/index.js' },
    copiedSources: ['asset.sql'], artifacts: [
      ...[bundle, `${bundle}.meta.json`].map(path => ({ path, sha256: digest(readFileSync(path)) })),
      { path: copiedAsset, sha256: digest('asset.sql'), sourcePath: 'asset.sql' },
    ],
    schema: { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') },
    environment: { PAPERCUSP_BACKGROUND_WORKERS: digest('0') }, omitted: [], opaque: [] };
  const receiptPath = join(dir, 'operator-api-preflight.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(closure)); save();
  vi.stubEnv('VERIFY_TAURI_SOURCE_REF', source.sourceCommit);
  return { dir, root, bundle, closure, save, options: { root, bundle, receiptPath, sourceReceiptPath,
    selectedCommit: source.sourceCommit, schema: { ...closure.schema }, environment: { PAPERCUSP_BACKGROUND_WORKERS: '0' } } };
}

describe('selected committed reader preparation closure', () => {
  it('accepts matching independent source, build, external, dependency, schema and environment pins as preparation only', () => {
    const f = fixture();
    expect(qualifyCommittedReaderSource(f.options)).toMatchObject({ sourceCommit: 'a'.repeat(40),
      sha256: f.closure.sha256, omitted: [], opaque: [], hostStarted: false, httpStarted: false });
  });

  it.each(['helper.ts', 'config.ts', 'import.ts', 'asset.sql'])('refuses changed required %s before host startup', path => {
    const f = fixture(); writeFileSync(join(f.root, path), 'changed');
    const startHost = vi.fn();
    expect(() => { qualifyCommittedReaderSource(f.options); startHost(); }).toThrow(/tampered verification source archive/);
    expect(startHost).not.toHaveBeenCalled();
  });

  it('refuses a missing required source member', () => {
    const f = fixture(); rmSync(join(f.root, 'import.ts'));
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/missing import.ts/);
  });

  it.each(['omitted', 'opaque'] as const)('refuses unresolved required %s without starting a host', dimension => {
    const f = fixture(); f.closure[dimension] = ['subprocess imports']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(new RegExp(dimension));
  });

  it('refuses a missing config dimension instead of treating it as an empty census', () => {
    const f = fixture(); delete (f.closure as Partial<CommittedReaderClosure>).configPaths; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/dimension missing: configPaths/);
  });

  it('refuses a build input outside the independently recorded import closure', () => {
    const f = fixture(); f.closure.executedImports = ['helper.ts']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/absent from observed import closure: import.ts/);
  });

  it('refuses dependency bytes changed after independent preparation', () => {
    const f = fixture(); writeFileSync(join(f.root, 'node_modules/example/index.js'), 'module.exports = 2');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Materialized dependency census differs/);
  });

  it('refuses an omitted external resolution pin', () => {
    const f = fixture(); f.closure.externalResolutions = {}; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/External resolution census differs/);
  });

  it.each(['bundle', 'graph'] as const)('refuses changed prepared %s bytes', artifact => {
    const f = fixture(); writeFileSync(artifact === 'bundle' ? f.bundle : `${f.bundle}.meta.json`, 'changed');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/changed/);
  });

  it('refuses a schema mismatch rather than using migration source presence', () => {
    const f = fixture(); f.options.schema['harness_shared.tool_invocations.args_json'] = digest('text:nullable');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Applied required private schema differs/);
  });

  it('refuses an omitted copied-source artifact mapping', () => {
    const f = fixture(); f.closure.artifacts = f.closure.artifacts.filter(artifact => !artifact.sourcePath); f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Copied source lacks retained artifact mapping/);
  });

  it('refuses a changed required environment setting', () => {
    const f = fixture(); f.options.environment.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/environment differs/);
  });

  it('refuses a sibling selected commit', () => {
    const f = fixture(); f.options.selectedCommit = 'b'.repeat(40);
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/differs from selected committed source/);
  });

  it('refuses a closure receipt inside the archive', () => {
    const f = fixture(); f.options.receiptPath = join(f.root, '.verifier-source.json');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/must be independent/);
  });
});
