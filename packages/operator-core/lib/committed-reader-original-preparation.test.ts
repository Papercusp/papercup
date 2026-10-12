import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifierSourceFiles } from './verifier-source';

const sourcePreview = vi.hoisted(() => ({ prepareVerifierSource: vi.fn(), prepareVerifierDependencies: vi.fn() }));
vi.mock('../../../scripts/source-preview.mjs', () => sourcePreview);

import { produceCommittedReaderOriginalPreparation, qualifyCommittedReaderPlannedInputs } from '../test/private-http-workspace-preflight';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
const testPath = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts';
const helperPaths = ['packages/operator-core/test/staging-first-http-fixture.ts', 'apps/operator/bin/bundle-host.sh'];
const configPaths = ['package.json', 'packages/operator-core/vitest.integration.config.ts'];

function fixtureSource(root: string, sourceCommit: string) {
  const paths = [testPath, ...helperPaths, ...configPaths, 'src/main.ts'];
  for (const path of paths) {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `// ${path}\n`);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reader-preparation-fixture', private: true }));
  const builder = join(root, 'apps/operator/bin/bundle-host.sh');
  writeFileSync(builder, `#!/bin/bash
set -e
mkdir -p "$(dirname "$2")"
printf 'independent-bundle' > "$2"
cat > "$2.meta.json" <<'GRAPH'
{"inputs":{"src/main.ts":{"imports":[{"path":"example","external":true}]}},"outputs":{"hono-host.mjs":{"imports":[{"path":"example","external":true}]}}}
GRAPH
`);
  chmodSync(builder, 0o755);
  const sourceManifest = { schemaVersion: 'verifier-source-v1', sourceCommit,
    testedInputs: [{ path: testPath, sha256: digest(readFileSync(join(root, testPath))) }],
    files: verifierSourceFiles(root), submodules: [] };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(sourceManifest));
  return sourceManifest;
}

beforeEach(() => {
  vi.clearAllMocks();
  sourcePreview.prepareVerifierSource.mockImplementation(async ({ ref, dest }: { ref: string; dest: string }) =>
    fixtureSource(dest, ref));
  sourcePreview.prepareVerifierDependencies.mockImplementation(async ({ dest }: { dest: string }) => {
    const example = join(dest, 'node_modules/example'); mkdirSync(example, { recursive: true });
    writeFileSync(join(example, 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
    writeFileSync(join(example, 'index.js'), 'module.exports = 1;');
  });
});

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('maintained independent committed-reader preparation', () => {
  it('pins selected source, dependency graph, schema, environment and same-process observations before consumer preparation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'reader-original-preparation-test-')); roots.push(parent);
    const repositoryRoot = join(parent, 'repo'); mkdirSync(repositoryRoot);
    const workRoot = join(parent, 'independent');
    const selectedCommit = 'a'.repeat(40);
    const schema = { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') };
    const environment = { PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1' };

    const prepared = await produceCommittedReaderOriginalPreparation({ repositoryRoot, workRoot,
      selectedCommit, testPath, helperPaths, configPaths, schema, environment });

    expect(prepared.root).toBe(join(workRoot, 'source'));
    expect(prepared.root).not.toBe(repositoryRoot);
    expect(sourcePreview.prepareVerifierSource).toHaveBeenCalledOnce();
    expect(sourcePreview.prepareVerifierDependencies).toHaveBeenCalledOnce();
    const sourceBytes = readFileSync(prepared.sourceReceiptPath);
    const inputBytes = readFileSync(prepared.inputReceiptPath);
    const observationBytes = readFileSync(prepared.observationReceiptPath);
    expect(digest(sourceBytes)).toBe(prepared.sourceReceiptSha256);
    expect(digest(inputBytes)).toBe(prepared.inputReceiptSha256);
    expect(digest(observationBytes)).toBe(prepared.observationReceiptSha256);
    expect(existsSync(join(repositoryRoot, 'apps/operator/dist-verify/original-hono-host.mjs'))).toBe(false);

    const source = JSON.parse(String(sourceBytes));
    const inputs = JSON.parse(String(inputBytes));
    const observations = JSON.parse(String(observationBytes));
    expect(inputs).toMatchObject({ sourceCommit: selectedCommit, phase: 'planned', testPaths: [testPath],
      helperPaths: [...helperPaths].sort(), configPaths: [...configPaths].sort(),
      executedImports: ['src/main.ts'], externalResolutions: { example: 'node_modules/example/index.js' },
      schema, environment: Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, digest(value)])),
      omitted: [], opaque: [] });
    expect(observations).toMatchObject({ ...prepared.identity, sourceRoot: prepared.root,
      sourceReceipt: { path: prepared.sourceReceiptPath, sha256: prepared.sourceReceiptSha256 },
      inputReceipt: { path: prepared.inputReceiptPath, sha256: prepared.inputReceiptSha256 },
      omitted: [], opaque: [] });
    for (const value of Object.values(observations.observations)) expect(value).toMatchObject({
      ...prepared.identity,
    });
    expect(observations.observations.source.value).toEqual(source);
    expect(observations.observations.schema.value).toEqual(schema);

    const qualified = qualifyCommittedReaderPlannedInputs(prepared.root, { inputReceiptPath: prepared.inputReceiptPath,
      sourceReceiptPath: prepared.sourceReceiptPath, selectedCommit, inputReceiptSha256: prepared.inputReceiptSha256,
      sourceReceiptSha256: prepared.sourceReceiptSha256 });
    expect(qualified.inputs).toEqual(inputs);
  });

  it('refuses empty live schema observations before creating source or bundle artifacts', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'reader-original-preparation-empty-schema-')); roots.push(parent);
    const repositoryRoot = join(parent, 'repo'); mkdirSync(repositoryRoot);
    await expect(produceCommittedReaderOriginalPreparation({ repositoryRoot, workRoot: join(parent, 'independent'),
      selectedCommit: 'b'.repeat(40), testPath, helperPaths, configPaths, schema: {},
      environment: { PAPERCUSP_BACKGROUND_WORKERS: '0' } })).rejects.toThrow(/schema observation is required/);
    expect(sourcePreview.prepareVerifierSource).not.toHaveBeenCalled();
    expect(sourcePreview.prepareVerifierDependencies).not.toHaveBeenCalled();
  });
});
