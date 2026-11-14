import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSourceByteSnapshot, captureRecordedProofContext } from '@papercusp/test-config/execution-details';
import { listFilesIncludingUntracked } from '../../../../scripts/lib/tracked-files.mjs';
import { PROOF_CONTEXT_COMPONENTS, createProofContextIdentity, proofContextImpact,
  type ProofContextIdentity } from '@papercusp/test-config/configuration-snapshot';
import { enumerateAffectedTaskSelection } from '../../../../scripts/lib/related-tests.mjs';
import { planComposedProof } from './composed-promotion-proof';
import { captureProofContextReach, capturedProofContextComponents, compareProofContextReach,
  PROOF_CONTEXT_REACH_VERSION, type ProofContextReachCapture,
  type ProofContextReachCaptureInput } from './proof-context-reach';

const A = 'packages/app/a.test.ts', B = 'packages/app/b.test.ts';
const INPUT = 'packages/data/input.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text);
}
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'proof-context-reach-')); roots.push(root);
  write(root, 'package.json', '{"name":"reach-fixture","private":true,"type":"module","workspaces":["packages/*"]}');
  write(root, 'packages/app/package.json', '{"name":"@reach/app","type":"module"}');
  write(root, 'packages/data/package.json', '{"name":"@reach/data","type":"module","exports":{".":"./input.ts"}}');
  write(root, 'packages/app/vitest.config.mjs', 'export default { test: { include: ["*.test.ts"] } };');
  write(root, INPUT, 'export const input = 1;');
  write(root, A, 'import { input } from "@reach/data"; export const result = input;');
  write(root, B, 'export const unrelated = 1;');
  write(root, 'packages/app/check.ts', 'import { input } from "@reach/data"; export const checked = input;');
  return root;
}
function tasks() {
  return [{ ws: { name: '@reach/app', dir: 'packages/app', scripts: { test: 'vitest run' } }, script: 'test' }];
}
function input(root: string): ProofContextReachCaptureInput {
  // Only config discovery is fixed here; graph/bytes/package resolution are the REAL producer.
  const selection = enumerateAffectedTaskSelection(tasks(), { root, runResolver: () => [{
    ok: true, enumerated: true, files: readdirSync(join(root, 'packages/app')).filter(file => file.endsWith('.test.ts')),
    config: { include: ['*.test.ts'], exclude: [] },
  }] });
  return { rootDir: root, selection, componentFiles: { generatedAssets: [INPUT] },
    legs: [{ id: 'lint:check', entryFiles: ['packages/app/check.ts'], workspaceDir: 'packages/app' }] };
}
function known(value: ProofContextReachCapture) {
  expect(value).toMatchObject({ status: 'known' });
  if (value.status !== 'known') throw new Error(value.reason);
  return value;
}
function context(capture: ProofContextReachCapture) {
  return createProofContextIdentity({ ...Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, hash(key)])),
    ...capturedProofContextComponents(capture) } as ProofContextIdentity['components'])!;
}
function compare(oldCapture: ProofContextReachCapture, newCapture: ProofContextReachCapture) {
  return compareProofContextReach({ before: context(oldCapture), after: context(newCapture), oldCapture, newCapture });
}

describe('actual OLD + NEW static consumer reach', () => {
  it('uses the same source-byte identity as original result observations', () => {
    const root = tree();
    const source = [...listFilesIncludingUntracked(root).files].sort();
    const captured = known(captureProofContextReach({ ...input(root), componentFiles: { source } }));
    const pin = createSourceByteSnapshot(source.map(file => ({ path: file,
      sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') })))!;
    const recorded = captureRecordedProofContext({ commitSha: 'a'.repeat(40), worktreeDirty: false,
      sourceBytes: { schemaVersion: 'source-byte-observation-v1', before: pin, after: pin } });
    expect(recorded.components.source).toBe(captured.components.source?.identity);
    expect(recorded.components.compilerConfiguration).toBeNull();
  });

  it('follows actual package exports, selects a limited test/leg, and carries unrelated eligible proof', () => {
    const root = tree(), oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;');
    const newCapture = known(captureProofContextReach(input(root))), result = compare(oldCapture, newCapture);
    expect(result).toMatchObject({ status: 'known', reach: [{ component: 'generatedAssets', tests: [A], legs: ['lint:check'],
      provenance: { version: PROOF_CONTEXT_REACH_VERSION, before: oldCapture.fingerprint,
        after: newCapture.fingerprint, complete: true } }] });
    expect(proofContextImpact(result)).toMatchObject({ status: 'known', tests: [A], legs: ['lint:check'] });
    expect(planComposedProof({ proofContext: result, round1Tests: { [A]: 'pass', [B]: 'pass' },
      lintLegs: [{ id: 'lint:check', passed: true, covers: () => false },
        { id: 'lint:other', passed: true, covers: () => false }], admissions: [], dependentTestsOf: () => null }))
      .toMatchObject({ mode: 'composed', rerunTests: [A], carriedTests: [B],
        rerunLegs: ['lint:check'], carriedLegs: ['lint:other'] });
  });

  it('uses the OLD edge after its removal and the NEW edge after its addition', () => {
    const root = tree(), oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;');
    write(root, A, 'export const removed = 1;');
    write(root, B, 'import { input } from "@reach/data"; export const added = input;');
    const newCapture = known(captureProofContextReach(input(root)));
    const result = compare(oldCapture, newCapture);
    expect(result.status).toBe('known');
    if (result.status === 'known') {
      expect(result.reach.find(row => row.component === 'generatedAssets')?.tests).toEqual([A, B]);
      expect(result.reach.find(row => row.component === 'selectionGraph')?.tests).toEqual([A, B]);
    }
  });

  it('captures equivalent source trees independently without invalidating their proof', () => {
    const a = tree(), b = tree();
    const first = known(captureProofContextReach(input(a))), second = known(captureProofContextReach(input(b)));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(compare(first, second)).toMatchObject({ status: 'known', reach: [] });
  });

  it('includes runner-config dependencies for every selected consumer', () => {
    const root = tree();
    write(root, 'packages/app/vitest.config.mjs', 'import { input } from "@reach/data"; export default { test: { retry: input } };');
    const oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;');
    expect(compare(oldCapture, known(captureProofContextReach(input(root)))))
      .toMatchObject({ status: 'known', reach: [{ tests: [A, B] }] });
  });

  it('fails closed for unresolved cross-root exports, missing inputs and dynamic imports', () => {
    const root = tree();
    write(root, 'packages/data/package.json', '{"name":"@reach/data","exports":"./missing.ts"}');
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'unknown', reason: 'consumer-graph-incomplete' });
    write(root, 'packages/data/package.json', '{"name":"@reach/data","exports":"./input.ts"}');
    write(root, A, 'const name = "./hidden.ts"; export const x = import(name);');
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'unknown', reason: 'consumer-graph-incomplete' });
    write(root, A, 'export const x = 1;');
    expect(captureProofContextReach({ ...input(root), componentFiles: { fixtures: ['missing.json'] } }))
      .toMatchObject({ status: 'unknown', reason: 'input-unreadable' });
  });

  it('does not mistake runtime file discovery for a complete static graph', () => {
    const root = tree();
    write(root, A, 'import { readFileSync } from "node:fs"; export const x = readFileSync("fixture.json");');
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'unknown', reason: 'consumer-graph-incomplete' });
  });

  it.each([
    ['escaped require', 'const load = require; export const x = load("./hidden.ts");'],
    ['aliased createRequire', 'import { createRequire as make } from "node:module"; const load = make(import.meta.url); export const x = load("./hidden.ts");'],
    ['aliased fs import', 'import { readFileSync as read } from "node:fs"; export const x = read("./hidden.ts", "utf8");'],
    ['destructured fs require', 'const { readFileSync: read } = require("node:fs"); export const x = read("./hidden.ts", "utf8");'],
  ])('fails closed for escaped loader: %s', (_name, source) => {
    const root = tree(); write(root, A, source); write(root, 'packages/app/hidden.ts', 'export const hidden = 1;');
    const options = () => ({ ...input(root), componentFiles: { generatedAssets: ['packages/app/hidden.ts'] } });
    const oldCapture = captureProofContextReach(options());
    write(root, 'packages/app/hidden.ts', 'export const hidden = 2;');
    const newCapture = captureProofContextReach(options());
    const comparison = compare(oldCapture, newCapture);
    expect(oldCapture).toMatchObject({ status: 'unknown', reason: 'consumer-graph-incomplete' });
    expect(comparison.status).toBe('unknown');
    expect(proofContextImpact(comparison)).toMatchObject({ status: 'unknown' });
  });

  it('refuses incomplete/ambiguous selector census and mismatched test/leg identities', () => {
    const root = tree(), original = input(root);
    for (const selection of [{ ...original.selection, coverage: 'partial' },
      { ...original.selection, files: [A] }, { ...original.selection, overlaps: [A] }]) {
      expect(captureProofContextReach({ ...original, selection })).toMatchObject({ status: 'unknown' });
    }
    expect(captureProofContextReach({ ...original, legs: [{ id: A, entryFiles: [B], workspaceDir: 'packages/app' }] }))
      .toMatchObject({ status: 'unknown', reason: 'consumer-census-ambiguous' });
  });

  it('uses global reach for actual dependency manifests rather than empty static reach', () => {
    const root = tree(); write(root, 'package-lock.json', '{"lockfileVersion":2}');
    const options = () => ({ ...input(root), componentFiles: { dependencies: ['package-lock.json'] } });
    const oldCapture = known(captureProofContextReach(options()));
    write(root, 'package-lock.json', '{"lockfileVersion":3}');
    expect(compare(oldCapture, known(captureProofContextReach(options()))))
      .toMatchObject({ status: 'known', reach: [{ component: 'dependencies', tests: [A, B], legs: ['lint:check'] }] });
  });

  it('refuses unknown reach, transplanted identities and tampered captures', () => {
    const root = tree(), oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;');
    const newCapture = known(captureProofContextReach(input(root)));
    const before = context(oldCapture), after = context(newCapture);
    expect(compareProofContextReach({ before, after, oldCapture,
      newCapture: { ...newCapture, consumers: [] } })).toMatchObject({ status: 'unknown', reason: 'reach-capture-incomplete' });
    expect(compareProofContextReach({ before, after: createProofContextIdentity({ ...after.components, generatedAssets: hash('foreign') }),
      oldCapture, newCapture })).toMatchObject({ status: 'unknown', reason: 'reach-component-identity-mismatch:generatedAssets' });
    const unknown = compareProofContextReach({ before, after: createProofContextIdentity({ ...before.components, fixtures: hash('new-fixture') }),
      oldCapture, newCapture });
    expect(unknown).toMatchObject({ status: 'unknown', reason: 'reach-component-unmapped:fixtures' });
    expect(proofContextImpact(unknown)).toMatchObject({ status: 'unknown' });
    expect(compareProofContextReach({ before, after: createProofContextIdentity({ ...after.components, selectionGraph: hash('foreign-graph') }),
      oldCapture, newCapture })).toMatchObject({ status: 'unknown', reason: 'reach-graph-identity-mismatch' });
  });

  it('survives JSONB key reordering and binds reach to the actual captured graph', () => {
    const root = tree(), oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;');
    const newCapture = known(captureProofContextReach(input(root)));
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
    expect(compare(reorder(oldCapture) as ProofContextReachCapture, reorder(newCapture) as ProofContextReachCapture))
      .toMatchObject({ status: 'known', reach: [{ tests: [A] }] });
    expect(context(oldCapture).components.selectionGraph).toBe(context(newCapture).components.selectionGraph);
  });

  it('falls back for an unconsumed non-module input instead of assuming an empty runtime radius', () => {
    const root = tree(); write(root, 'unmapped.json', '{"value":1}');
    const options = () => ({ ...input(root), componentFiles: { fixtures: ['unmapped.json'] } });
    const oldCapture = known(captureProofContextReach(options())); write(root, 'unmapped.json', '{"value":2}');
    expect(compare(oldCapture, known(captureProofContextReach(options()))))
      .toMatchObject({ status: 'unknown', reason: 'reach-input-unmapped:fixtures' });
  });

  it('keeps an input missing from both consumer graphs unknown even when source-shaped', () => {
    const root = tree(); write(root, 'hidden.ts', 'export const hidden = 1;');
    const options = () => ({ ...input(root), componentFiles: { generatedAssets: ['hidden.ts'] } });
    const oldCapture = known(captureProofContextReach(options())); write(root, 'hidden.ts', 'export const hidden = 2;');
    const comparison = compare(oldCapture, known(captureProofContextReach(options())));
    expect(comparison).toMatchObject({ status: 'unknown', reason: 'reach-input-unmapped:generatedAssets' });
    expect(proofContextImpact(comparison)).toMatchObject({ status: 'unknown' });
  });

  it('uses the maintained workspace registry rather than fixture package names', () => {
    const root = tree();
    write(root, 'fixtures/clone/package.json', '{"name":"@reach/data","exports":"./missing.ts"}');
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'known' });
    const options = input(root); options.legs.push({ id: 'lint:duplicate', entryFiles: [B], workspaceDir: 'fixtures/clone' });
    expect(captureProofContextReach(options)).toMatchObject({ status: 'unknown', reason: 'ambiguous-workspace-package' });
  });

  it('keeps reach unknown when actual npm discovers a workspace missing from source custody', () => {
    const root = tree();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    write(root, '.gitignore', 'packages/ignored/\n.npm-cache/\n');
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Reach fixture', '-c', 'user.email=reach@example.test', 'commit', '-qm', 'fixture');
    const npm = () => execFileSync('npm', ['--offline', '--ignore-scripts', '--cache',
      join(root, '.npm-cache'), 'pkg', 'get', 'name', '--workspaces', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
    expect(JSON.parse(npm())).toEqual({ '@reach/app': '@reach/app', '@reach/data': '@reach/data' });
    const original = known(captureProofContextReach(input(root)));
    write(root, 'packages/ignored/package.json', '{"name":"@reach/data","exports":"./input.ts"}');
    write(root, 'packages/ignored/input.ts', 'export const input = 99;');
    expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    let npmFailure: unknown;
    try { npm(); } catch (error) { npmFailure = error; }
    expect(String((npmFailure as { stderr?: unknown })?.stderr)).toContain('EDUPLICATEWORKSPACE');
    const hidden = captureProofContextReach(input(root));
    expect(hidden).toMatchObject({ status: 'unknown', reason: 'workspace-census-incomplete' });
    const comparison = compareProofContextReach({ before: context(original), after: context(original),
      oldCapture: original, newCapture: hidden });
    expect(planComposedProof({ proofContext: comparison, round1Tests: { [A]: 'pass', [B]: 'pass' },
      lintLegs: [], admissions: [], dependentTestsOf: () => [] })).toMatchObject({ mode: 'full-gate' });

    write(root, 'packages/ignored/package.json', '{"name":"@reach/ignored"}');
    expect(JSON.parse(npm())).toHaveProperty('@reach/ignored', '@reach/ignored');
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'unknown', reason: 'workspace-census-incomplete' });
    write(root, 'package.json', JSON.stringify({ name: 'reach-fixture', private: true, type: 'module',
      workspaces: ['packages/*', '!packages/ignored'] }));
    expect(JSON.parse(npm())).toEqual({ '@reach/app': '@reach/app', '@reach/data': '@reach/data' });
    expect(captureProofContextReach(input(root))).toMatchObject({ status: 'known' });
  }, 30_000);

  it('hashes actual binary bytes rather than their lossy UTF-8 decoding', () => {
    const root = tree(); writeFileSync(join(root, 'asset.bin'), Buffer.from([0xff]));
    const options = () => ({ ...input(root), componentFiles: { generatedAssets: ['asset.bin'] } });
    const oldCapture = known(captureProofContextReach(options()));
    writeFileSync(join(root, 'asset.bin'), Buffer.from([0xfe]));
    const newCapture = known(captureProofContextReach(options()));
    expect(oldCapture.components.generatedAssets?.inputs[0]?.sha256)
      .not.toBe(newCapture.components.generatedAssets?.inputs[0]?.sha256);
    expect(context(oldCapture).fingerprint).not.toBe(context(newCapture).fingerprint);
  });

  it('keeps unknown graph capture on full fallback even when supplied contexts are equal', () => {
    const root = tree(), capture = known(captureProofContextReach(input(root))), identity = context(capture);
    const comparison = compareProofContextReach({ before: identity, after: identity,
      oldCapture: capture, newCapture: { status: 'unknown', reason: 'unresolved-import' } });
    expect(comparison.status).toBe('unknown');
    expect(proofContextImpact(comparison)).toMatchObject({ status: 'unknown' });
    expect(planComposedProof({ proofContext: comparison, round1Tests: { [A]: 'pass', [B]: 'pass' },
      lintLegs: [], admissions: [], dependentTestsOf: () => [] })).toMatchObject({ mode: 'full-gate' });
  });

  it('treats malformed persisted captures as unknown rather than throwing on validly hashed bad shape', () => {
    const root = tree(), capture = known(captureProofContextReach(input(root))), identity = context(capture);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
    const { fingerprint: _fingerprint, ...body } = capture;
    for (const invalid of [{ ...body, components: null }, { ...body, consumers: [null] }]) {
      const newCapture = { ...invalid, fingerprint: hash(JSON.stringify(canonical(invalid))) } as unknown as ProofContextReachCapture;
      const comparison = compareProofContextReach({ before: identity, after: identity, oldCapture: capture, newCapture });
      expect(comparison).toMatchObject({ status: 'unknown', reason: 'reach-capture-incomplete' });
      expect(proofContextImpact(comparison)).toMatchObject({ status: 'unknown' });
    }
  });

  it('rejects a changed or incomplete population rather than carrying unknown proof', () => {
    const root = tree(), oldCapture = known(captureProofContextReach(input(root)));
    write(root, INPUT, 'export const input = 2;'); write(root, 'packages/app/c.test.ts', 'export const added = 1;');
    expect(compare(oldCapture, known(captureProofContextReach(input(root)))))
      .toMatchObject({ status: 'unknown', reason: 'reach-population-changed' });
    const complete = context(oldCapture), incomplete = createProofContextIdentity({ ...complete.components, behavior: null });
    expect(compareProofContextReach({ before: complete, after: incomplete, oldCapture, newCapture: oldCapture }))
      .toMatchObject({ status: 'unknown', reason: 'proof-context-incomplete' });
  });

  it('produces reach from actual native Vitest selection discovery, not a handcrafted complete graph', () => {
    const root = tree(), repo = fileURLToPath(new URL('../../../..', import.meta.url));
    const nativeSelection = () => enumerateAffectedTaskSelection(tasks(), { root, enumerateSpecifications: true,
      runResolver: (requests: unknown[]) => {
        const output = execFileSync(process.execPath, [join(repo, 'scripts/resolve-vitest-config-contracts.mjs')], {
          cwd: repo, input: JSON.stringify({ requests }), encoding: 'utf8', timeout: 30_000,
        });
        const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
        const line = output.split(/\r?\n/).reverse().find(value => value.startsWith(marker));
        if (!line) throw new Error(output);
        return JSON.parse(line.slice(marker.length)).results;
      } });
    const selection = nativeSelection();
    expect(selection.coverage).toBe('complete');
    expect(selection.files).toEqual([A, B]);
    expect(selection.tasks[0]).toHaveProperty('selectedSpecifications');
    const oldCapture = known(captureProofContextReach({ ...input(root), selection }));
    write(root, INPUT, 'export const input = 7;');
    const newCapture = known(captureProofContextReach({ ...input(root), selection: nativeSelection() }));
    expect(compare(oldCapture, newCapture)).toMatchObject({ status: 'known', reach: [{ tests: [A], legs: ['lint:check'] }] });
    expect(readFileSync(join(root, INPUT), 'utf8')).toContain('7');
  }, 90_000);
});
