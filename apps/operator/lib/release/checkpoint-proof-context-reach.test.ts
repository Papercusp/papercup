import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enumerateAffectedTaskSelection } from '../../../../scripts/lib/related-tests.mjs';
import { PROOF_CONTEXT_COMPONENTS, createProofContextIdentity } from '@papercusp/test-config/configuration-snapshot';
import { compareProofContextReach } from '@papercusp/operator-core/lib/release/proof-context-reach';
import { captureCheckpointProofContextAtRef, checkpointPostSuiteCommandArgv, checkpointProofContextLegEntries,
  compareCheckpointProofContextCaptures } from './checkpoint-proof-context-reach';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'checkpoint-proof-context-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=test@test',
    '-c', 'user.name=test', ...args], { encoding: 'utf8' }).trim();
  const write = (file: string, value: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), value);
  };
  git('init', '-q');
  write('package.json', JSON.stringify({ name: 'proof-fixture', type: 'module', scripts: {
    test: 'vitest run', check: 'node check.mjs', alias: 'npm run check', prealias: 'node pre.mjs' } }));
  write('vitest.config.mjs', 'export default { test: { include: ["*.test.ts"] } };');
  write('a.test.ts', 'import { value } from "./input.ts"; export const result = value;');
  write('b.test.ts', 'export const unrelated = 1;');
  write('input.ts', 'export const value = 1;');
  write('check.mjs', 'export const check = 1;'); write('pre.mjs', 'export const pre = 1;');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const before = commit();
  write('input.ts', 'export const value = 2;');
  write('a.test.ts', 'export const removed = 1;');
  write('b.test.ts', 'import { value } from "./input.ts"; export const added = value;');
  const after = commit();
  const readTree = async () => ({ head: git('rev-parse', 'HEAD'),
    dirty: !!git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') });
  const select = async () => {
    const selection = enumerateAffectedTaskSelection([{ ws: { name: 'proof-fixture', dir: '.',
      scripts: { test: 'vitest run' } }, script: 'test' }], { root, runResolver: () => [{ ok: true,
      enumerated: true, files: readdirSync(root).filter(file => file.endsWith('.test.ts')),
      config: { include: ['*.test.ts'], exclude: [] } }] });
    return { code: 0, stdout: `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n` };
  };
  const setupTree = async (ref: string) => { git('checkout', '-q', ref); return root; };
  const legs = () => checkpointProofContextLegEntries(root, [{ id: 'lint:check', commands: ['check'] }]);
  const capture = (ref: string, overrides: Partial<Parameters<typeof captureCheckpointProofContextAtRef>[0]> = {}) =>
    captureCheckpointProofContextAtRef({ ref, setupTree, readTree, select, legs, ...overrides });
  return { root, git, write, commit, before, after, readTree, select, setupTree, legs, capture };
}

describe('checkpoint ref-pinned reach adapter', () => {
  it('detaches the OLD graph before the same checkout is reset to NEW and retains unknown semantic inputs', async () => {
    const f = fixture();
    const before = await f.capture(f.before), after = await f.capture(f.after);
    expect(before.reach.status).toBe('known'); expect(after.reach.status).toBe('known');
    if (before.reach.status !== 'known' || after.reach.status !== 'known') throw new Error('capture unavailable');
    const depends = (capture: typeof before.reach, id: string) => capture.consumers.find(row => row.id === id)!
      .inputs.some(file => file.path === 'input.ts');
    expect(depends(before.reach, 'a.test.ts')).toBe(true);
    expect(depends(after.reach, 'a.test.ts')).toBe(false);
    expect(depends(before.reach, 'b.test.ts')).toBe(false);
    expect(depends(after.reach, 'b.test.ts')).toBe(true);
    expect(before.context?.components.source).not.toBe(after.context?.components.source);
    expect(before.context?.components.source).toBe(before.reach.components.source?.identity);
    expect(before.reach.components.source?.inputs.map(file => file.path))
      .toEqual(['a.test.ts', 'b.test.ts', 'check.mjs', 'input.ts', 'package.json', 'pre.mjs', 'vitest.config.mjs']);
    expect(before.context?.components.selectionGraph).not.toBeNull();
    for (const component of ['compilerConfiguration', 'runtimeCapabilities', 'schema', 'fixtures',
      'generatedAssets', 'behavior', 'population'] as const) expect(after.context?.components[component]).toBeNull();
    expect(compareCheckpointProofContextCaptures({ candidate: f.before, repairHead: f.after, before, after }))
      .toMatchObject({ status: 'unknown', after: null, reason: 'proof-context-incomplete' });
  });

  it('uses measured source bytes across distinct commits and maps leaf edits to actual consumers', async () => {
    const f = fixture(), before = await f.capture(f.before);
    f.git('commit', '--allow-empty', '-qm', 'same source, distinct commit');
    const equivalentRef = f.git('rev-parse', 'HEAD'), equivalent = await f.capture(equivalentRef);
    expect(equivalentRef).not.toBe(f.before);
    expect(equivalent.context).toEqual(before.context);
    expect(equivalent.reach).toEqual(before.reach);

    f.write('input.ts', 'export const value = 3;');
    const changedRef = f.commit(), changed = await f.capture(changedRef);
    if (before.reach.status !== 'known' || changed.reach.status !== 'known') throw new Error('capture unavailable');
    // Isolate source-reach validation. These constant test-only identities do
    // not fill any missing semantic measurement in the actual caller.
    const sourceControl = (capture: typeof before) => createProofContextIdentity({
      ...Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, 'a'.repeat(64)])),
      source: capture.context!.components.source,
      selectionGraph: capture.context!.components.selectionGraph,
    } as NonNullable<typeof capture.context>['components']);
    expect(compareProofContextReach({ before: sourceControl(before), after: sourceControl(changed),
      oldCapture: before.reach, newCapture: changed.reach })).toMatchObject({ status: 'known',
      reach: [{ component: 'source', tests: ['a.test.ts'], legs: [] }] });
    expect(compareCheckpointProofContextCaptures({ candidate: f.before, repairHead: changedRef, before, after: changed }))
      .toMatchObject({ status: 'unknown', reason: 'proof-context-incomplete', after: null });
  });

  it('keeps an unobserved source consumer unknown even with a complete byte manifest', async () => {
    const f = fixture(); await f.setupTree(f.before);
    f.write('unreferenced.ts', 'export const value = 1;');
    const originalRef = f.commit(), original = await f.capture(originalRef);
    f.write('unreferenced.ts', 'export const value = 2;');
    const changedRef = f.commit(), changed = await f.capture(changedRef);
    expect(original.reach.status).toBe('known'); expect(changed.reach.status).toBe('known');
    if (original.reach.status !== 'known' || changed.reach.status !== 'known') throw new Error('capture unavailable');
    const context = (capture: typeof original) => createProofContextIdentity({
      ...Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, 'a'.repeat(64)])),
      source: capture.context!.components.source, selectionGraph: capture.context!.components.selectionGraph,
    } as NonNullable<typeof capture.context>['components']);
    expect(compareProofContextReach({ before: context(original), after: context(changed),
      oldCapture: original.reach, newCapture: changed.reach }))
      .toMatchObject({ status: 'unknown', after: null, reason: 'reach-input-unmapped:source' });
  });

  it('refuses an incorrect setup ref and untracked source dirt before discovery', async () => {
    const f = fixture(); let selected = false;
    expect(await f.capture(f.before, { setupTree: async () => f.root,
      select: async () => { selected = true; return f.select(); } }))
      .toMatchObject({ context: null, reach: { status: 'unknown', reason: 'source-ref-mismatch-or-dirty' } });
    expect(selected).toBe(false);
    f.write('untracked.ts', 'export const x = 1;');
    expect(await f.capture(f.after)).toMatchObject({ context: null,
      reach: { reason: 'source-ref-mismatch-or-dirty' } });
  });

  it('refuses HEAD movement or new dirt during discovery', async () => {
    const f = fixture();
    expect(await f.capture(f.before, { select: async () => {
      const result = await f.select(); await f.setupTree(f.after); return result;
    } })).toMatchObject({ context: null, reach: { reason: 'source-changed-during-capture' } });
    expect(await f.capture(f.after, { select: async () => {
      const result = await f.select(); f.write('input.ts', 'export const value = 3;'); return result;
    } })).toMatchObject({ context: null, reach: { reason: 'source-changed-during-capture' } });
  });

  it('keeps selector failure, duplicate output and incomplete census fail-closed', async () => {
    const f = fixture();
    expect(await f.capture(f.after, { select: async () => ({ code: 1, stdout: '' }) }))
      .toMatchObject({ context: null, reach: { reason: 'consumer-selector-failed' } });
    expect(await f.capture(f.after, { select: async () => {
      const result = await f.select(); return { ...result, stdout: result.stdout.repeat(2) };
    } })).toMatchObject({ context: null, reach: { reason: 'consumer-selector-output-invalid' } });
    expect(await f.capture(f.after, { select: async () => ({ code: 0,
      stdout: 'AFFECTED_TESTS_SELECTION={"schemaVersion":1,"coverage":"partial"}' }) }))
      .toMatchObject({ reach: { status: 'unknown' } });
  });

  it('does not turn missing leg discovery into package.json closure or accept a foreign ref', async () => {
    const f = fixture(), before = await f.capture(f.before);
    let selected = false;
    const after = await f.capture(f.after, { legs: () => null, select: async () => {
      selected = true; return f.select();
    } });
    expect(after.reach).toEqual({ status: 'unknown', reason: 'post-suite-leg-inputs-unmeasured' });
    expect(after.context).toBeNull(); expect(selected).toBe(false);
    expect(compareCheckpointProofContextCaptures({ candidate: f.after, repairHead: f.after, before, after }))
      .toMatchObject({ status: 'unknown', after: null, reason: 'proof-context-ref-mismatch' });
  });

  it('resolves maintained npm aliases/lifecycle entries and refuses opaque command forms', () => {
    const f = fixture();
    expect(checkpointProofContextLegEntries(f.root, [{ id: 'lint:alias', commands: ['alias'] }]))
      .toEqual([{ id: 'lint:alias', entryFiles: ['check.mjs', 'package.json', 'pre.mjs'] }]);
    const manifest = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    for (const command of ['vite build', 'git grep x', 'node --conditions=private check.mjs',
      'node check.mjs; node hidden.mjs', 'node ../outside.mjs', 'node check.mjs > /tmp/result',
      'NODE_OPTIONS=--import=hidden.mjs node check.mjs']) {
      f.write('package.json', JSON.stringify({ ...manifest, scripts: { check: command } }));
      expect(checkpointProofContextLegEntries(f.root, [{ id: 'lint:check', commands: ['check'] }])).toBeNull();
    }
  });

  it('captures actual local Node loader and test operands and maps loader changes to the leg', async () => {
    const f = fixture(); await f.setupTree(f.before);
    const manifest = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    f.write('package.json', JSON.stringify({ ...manifest, scripts: {
      ...manifest.scripts, check: 'node --import ./loader.mjs check.mjs a.test.ts b.test.ts',
    } }));
    f.write('loader.mjs', 'export const loader = 1;');
    const originalRef = f.commit(), original = await f.capture(originalRef);
    expect(f.legs()).toEqual([{ id: 'lint:check',
      entryFiles: ['a.test.ts', 'b.test.ts', 'check.mjs', 'loader.mjs', 'package.json'] }]);
    f.write('loader.mjs', 'export const loader = 2;');
    const changedRef = f.commit(), changed = await f.capture(changedRef);
    const context = (capture: typeof original) => createProofContextIdentity({
      ...Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, 'a'.repeat(64)])),
      source: capture.context!.components.source, selectionGraph: capture.context!.components.selectionGraph,
    } as NonNullable<typeof capture.context>['components']);
    expect(compareProofContextReach({ before: context(original), after: context(changed),
      oldCapture: original.reach, newCapture: changed.reach })).toMatchObject({ status: 'known',
      reach: [{ component: 'source', tests: [], legs: ['lint:check'] }] });
    expect(compareCheckpointProofContextCaptures({ candidate: originalRef, repairHead: changedRef,
      before: original, after: changed })).toMatchObject({ status: 'unknown', reason: 'proof-context-incomplete' });
  });

  it('keeps unsupported or escaping Node loader and operand inputs unknown', () => {
    const f = fixture(), manifest = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    for (const command of ['node --import data:text/javascript,foo check.mjs',
      'node --import node:fs check.mjs', 'node --import /outside.mjs check.mjs',
      'node --import ../outside.mjs check.mjs', 'node --import=./../outside.mjs check.mjs',
      'node --import', 'node --eval check.mjs', 'node check.mjs --config=hidden.json',
      'node check.mjs fixtures', 'node check.mjs ../outside.test.ts']) {
      f.write('package.json', JSON.stringify({ ...manifest, scripts: { check: command } }));
      expect(checkpointProofContextLegEntries(f.root, [{ id: 'lint:check', commands: ['check'] }]), command).toBeNull();
    }
    for (const command of ['node --import=./loader.mjs --require ./pre.cjs check.mjs',
      'node -r ./pre.cjs --import ./loader.mjs -- check.mjs']) {
      f.write('package.json', JSON.stringify({ ...manifest, scripts: { check: command } }));
      expect(checkpointProofContextLegEntries(f.root, [{ id: 'lint:check', commands: ['check'] }]))
        .toEqual([{ id: 'lint:check', entryFiles: ['check.mjs', 'loader.mjs', 'package.json', 'pre.cjs'] }]);
    }
  });

  it('resolves the configured workspace lifecycle and loader instead of a root build alias', async () => {
    const f = fixture();
    const pkg = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    f.write('package.json', JSON.stringify({ ...pkg, workspaces: ['apps/*'],
      scripts: { ...pkg.scripts, build: 'node decoy.mjs' } }));
    f.write('decoy.mjs', 'export const decoy = true;');
    f.write('apps/spa/package.json', JSON.stringify({ name: '@fixture/spa', type: 'module', scripts: {
      prebuild: 'node pre.mjs', build: 'npm run bundle', bundle: 'node --import ./loader.mjs build.mjs',
    } }));
    for (const file of ['pre.mjs', 'loader.mjs', 'build.mjs']) f.write(`apps/spa/${file}`, 'export const value = 1;');
    const definitions = [{ id: 'spa-build', commands: ['build'] }];
    const legs = () => checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa');
    expect(legs()).toEqual([{ id: 'spa-build', workspaceDir: 'apps/spa', entryFiles: [
      'apps/spa/build.mjs', 'apps/spa/loader.mjs', 'apps/spa/package.json', 'apps/spa/pre.mjs', 'package.json',
    ] }]);
    expect(checkpointProofContextLegEntries(f.root, definitions, 'apps/spa')).toEqual(legs());
    const beforeRef = f.commit(), before = await f.capture(beforeRef, { legs });
    f.write('apps/spa/loader.mjs', 'export const value = 2;');
    const afterRef = f.commit(), after = await f.capture(afterRef, { legs });
    expect(before.reach.status).toBe('known'); expect(after.reach.status).toBe('known');
    if (before.reach.status !== 'known' || after.reach.status !== 'known') throw new Error('capture unavailable');
    const inputs = after.reach.consumers.find(row => row.id === 'spa-build')!.inputs.map(row => row.path);
    expect(inputs).toContain('apps/spa/loader.mjs'); expect(inputs).not.toContain('decoy.mjs');
    expect(compareCheckpointProofContextCaptures({ candidate: beforeRef, repairHead: afterRef, before, after }))
      .toMatchObject({ status: 'unknown', reason: 'proof-context-incomplete', after: null });
  });

  it('refuses ignored workspace manifests that actual npm still includes in dispatch', () => {
    const f = fixture(), definitions = [{ id: 'spa-build', commands: ['build'] }];
    const pkg = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    f.write('package.json', JSON.stringify({ ...pkg, workspaces: ['apps/*'] }));
    const spa = (dir: string) => {
      f.write(`${dir}/package.json`, JSON.stringify({ name: '@fixture/spa', scripts: { build: 'node build.mjs' } }));
      f.write(`${dir}/build.mjs`, 'export const value = 1;');
    };
    spa('apps/spa');
    f.write('.gitignore', 'apps/ignored/\n.npm-cache/\n');
    f.commit();
    const npm = () => execFileSync('npm', ['--offline', '--ignore-scripts', '--cache',
      path.join(f.root, '.npm-cache'), 'pkg', 'get', 'name', '--workspaces', '--json'],
    { cwd: f.root, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
    expect(JSON.parse(npm())).toEqual({ '@fixture/spa': '@fixture/spa' });
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa'))
      .toMatchObject([{ workspaceDir: 'apps/spa' }]);

    spa('apps/ignored');
    expect(f.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    // npm discovers this duplicate despite Git ignoring its manifest. Source
    // enrollment alone must not certify a unique workspace entry population.
    let npmFailure: unknown;
    try { npm(); } catch (error) { npmFailure = error; }
    expect(String((npmFailure as { stderr?: unknown })?.stderr)).toContain('EDUPLICATEWORKSPACE');
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa')).toBeNull();
    expect(checkpointProofContextLegEntries(f.root, definitions, 'apps/spa')).toBeNull();

    f.write('package.json', JSON.stringify({ ...pkg, workspaces: ['apps/*', '!apps/ignored'] }));
    expect(JSON.parse(npm())).toEqual({ '@fixture/spa': '@fixture/spa' });
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa'))
      .toMatchObject([{ workspaceDir: 'apps/spa' }]);
  });

  it('keeps native, missing, ambiguous, excluded and opaque workspace commands unmeasured', () => {
    const f = fixture(), definitions = [{ id: 'spa-build', commands: ['build'] }];
    const pkg = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    const configure = (workspaces: string[]) => f.write('package.json', JSON.stringify({ ...pkg, workspaces }));
    const spa = (dir: string, build: string) => f.write(`${dir}/package.json`,
      JSON.stringify({ name: '@fixture/spa', scripts: { build } }));
    configure(['apps/*']); spa('apps/spa', 'node build.mjs');
    expect(checkpointProofContextLegEntries(f.root, definitions)).toBeNull();
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/missing')).toBeNull();
    spa('apps/duplicate', 'node build.mjs');
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa')).toBeNull();
    configure(['apps/*', '!apps/duplicate']);
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa'))
      .toMatchObject([{ workspaceDir: 'apps/spa' }]);
    configure(['apps/*', '!apps/spa', '!apps/duplicate']);
    expect(checkpointProofContextLegEntries(f.root, definitions, 'apps/spa')).toBeNull();
    configure(['apps/spa']); spa('apps/spa', 'vite build');
    expect(checkpointProofContextLegEntries(f.root, definitions, '@fixture/spa')).toBeNull();
    expect(checkpointPostSuiteCommandArgv('build', '@fixture/spa'))
      .toEqual(['npm', '--workspace', '@fixture/spa', 'run', 'build']);
    expect(checkpointPostSuiteCommandArgv('lint:tsc')).toEqual(['npm', 'run', 'lint:tsc']);
    expect(checkpointPostSuiteCommandArgv('spa:conflict-markers'))
      .toEqual(['git', 'grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.']);
    expect(checkpointProofContextLegEntries(f.root,
      [{ id: 'spa-build', commands: ['spa:conflict-markers', 'build'] }], '@fixture/spa')).toBeNull();
  });
});
