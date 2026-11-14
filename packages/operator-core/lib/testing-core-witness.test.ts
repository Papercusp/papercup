import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureTestingCoreInputUniverse, createTestingCoreResolverNamespace, prepareTestingCore, retainTestingCoreResolverMetadata, verifyTestingCoreReceipt } from '../../../scripts/lib/testing-core-witness.mjs';
import { createCompilerInputCustody } from '../../../scripts/lib/compiler-input-custody.mjs';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';

const repoRoot = resolve(__dirname, '../../..');
const entry = 'packages/operator-core/lib/agent-tools/testing/testing-core.worker.ts';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let base: string, compilerPath: string, sequence = 0;

beforeAll(() => {
  // Keep fixtures private. The compiler closes its enclosing namespace instead
  // of assuming the shared HOME directory remains idle during these builds.
  const bank = join(homedir(), '.papercusp/testing-core-witness-tests');
  mkdirSync(bank, { recursive: true });
  base = mkdtempSync(join(bank, 'case-'));
  const env = { ...process.env, PATH: localEsbuildNpxPath(join(base, 'compiler'), repoRoot) };
  const selected = spawnSync('npx', ['--yes', '--package=esbuild@0.25.0', '-c', 'command -v esbuild'],
    { encoding: 'utf8', env });
  expect(selected.status, selected.stderr).toBe(0);
  compilerPath = selected.stdout.trim();
}, 60_000);
afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

function fixture() {
  const directory = join(base, String(sequence++)), root = join(directory, 'source');
  const put = (path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  put('package.json', '{"type":"module"}');
  put('tsconfig.json', '{"compilerOptions":{"target":"ES2022"}}');
  put('package-lock.json', '{}');
  for (const path of ['apps/operator/bin/bundle-host-common.sh', 'apps/operator/bin/bundle-host.sh',
    'scripts/lib/testing-core-witness.mjs', 'scripts/lib/compiler-input-custody.mjs',
    'packages/operator-core/lib/util/cli-entry.ts',
    'apps/operator/bin/ascii-escape-bundle.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(repoRoot, path), join(root, path));
  }
  put('packages/operator-core/lib/retained-replay-sources.json', '["replay.ts"]');
  put('replay.ts', 'export const replay = 1;');
  put('core.ts', 'export const result: number = 42;');
  put(entry, 'import {result} from "../../../../../core"; export const testingCoreSourceSha256 = __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__; export function runTestFilesCore() {return result}');
  const outfile = join(directory, 'output/testing-core.worker.mjs');
  mkdirSync(dirname(outfile), { recursive: true });
  const replay = hash(JSON.stringify({ version: 1, sources: [['replay.ts', hash(readFileSync(join(root, 'replay.ts')))]] }));
  const argv = [join(root, entry), '--bundle', '--platform=node', '--format=esm', '--target=node22',
    `--outfile=${outfile}`, `--metafile=${outfile}.meta.json`,
    `--define:__PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__=${JSON.stringify(replay)}`];
  return { root, outfile, argv, compilerPath, put };
}

describe('testing core producing-build witness', () => {
  it('binds actual native compiler inputs, final bytes and a loadable plain-Node API', async () => {
    const f = fixture(), receipt = await prepareTestingCore(f);
    expect(verifyTestingCoreReceipt(receipt, receipt.witness)).toEqual(receipt.witness);
    expect(receipt.input.sources.map((row: {path: string}) => row.path)).toContain('core.ts');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const core=await import(process.argv[1]);console.log(JSON.stringify({value:core.runTestFilesCore(),source:core.testingCoreSourceSha256}));',
      f.outfile], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ value: 42, source: receipt.witness.sourceSha256 });
    expect(hash(readFileSync(f.outfile))).toBe(receipt.witness.artifactSha256);
  });

  it.each(['core.ts', 'tsconfig.json', 'package-lock.json'])(
    'changes the source/profile witness when %s changes', async path => {
      const f = fixture(), first = await prepareTestingCore(f);
      f.put(path, path === 'core.ts' ? 'export const result: number = 43;'
        : path === 'tsconfig.json' ? '{"compilerOptions":{"target":"ES2021"}}' : '{"lockfileVersion":3}');
      const next = await prepareTestingCore(f);
      expect(next.witness.sourceSha256).not.toBe(first.witness.sourceSha256);
    });

  it.each(['core.ts', 'tsconfig.json'])(
    'refuses temporary substitution/restoration of original %s before final compilation', async path => {
      const f = fixture(), original = readFileSync(join(f.root, path));
      await expect(prepareTestingCore({ ...f, phase: async (name: string, run: () => Promise<unknown>) => {
        if (name === 'final') { writeFileSync(join(f.root, path), ''); writeFileSync(join(f.root, path), original); }
        return run();
      } })).rejects.toThrow(/identity changed|interval changed/);
      expect(existsSync(f.outfile)).toBe(false);
    });

  it('refuses a create/remove failed-probe substitution and preserves last known good bytes', async () => {
    const f = fixture(), first = await prepareTestingCore(f), before = readFileSync(f.outfile);
    await expect(prepareTestingCore({ ...f, phase: async (name: string, run: () => Promise<unknown>) => {
      if (name === 'final') { f.put('core.js', 'export const result = 9;'); rmSync(join(f.root, 'core.js')); }
      return run();
    } })).rejects.toThrow(/identity changed|interval changed/);
    expect(readFileSync(f.outfile)).toEqual(before);
    expect(hash(before)).toBe(first.witness.artifactSha256);
  });

  it('holds the original interval through parent compilation and checks final worker bytes', async () => {
    const f = fixture(), receipt = await prepareTestingCore(f);
    const original = readFileSync(join(f.root, 'core.ts'));
    f.put('core.ts', 'export const result = 9;'); writeFileSync(join(f.root, 'core.ts'), original);
    expect(() => verifyTestingCoreReceipt(receipt, receipt.witness)).toThrow(/interval changed/);
    const current = await prepareTestingCore(f);
    writeFileSync(f.outfile, 'export const forged = true;');
    expect(() => verifyTestingCoreReceipt(current, current.witness)).toThrow(/final artifact changed/);
  });

  it('rejects unknown compiler switches before publishing output', async () => {
    const f = fixture();
    await expect(prepareTestingCore({ ...f, argv: [...f.argv, '--inject=unknown.js'] }))
      .rejects.toThrow(/outside maintained recipe/);
    expect(existsSync(f.outfile)).toBe(false);
  });

  it('qualifies a real enclosing dependency from its original population', async () => {
    const f = fixture(), dependency = join(dirname(f.root), 'node_modules/enclosing-custody');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"name":"enclosing-custody","main":"index.js"}');
    writeFileSync(join(dependency, 'index.js'), 'export const result = 43;');
    f.put('core.ts', 'export {result} from "enclosing-custody";');
    const receipt = await prepareTestingCore(f);
    expect(receipt.input.sources.some((row: {path: string}) => row.path.endsWith('enclosing-custody/index.js'))).toBe(true);
    expect(verifyTestingCoreReceipt(receipt, receipt.witness)).toEqual(receipt.witness);
  });

  it('accepts unrelated enclosing-directory entry churn throughout native compilation', async () => {
    const f = fixture(), unrelated = join(dirname(f.root), 'unrelated-agent-state');
    const receipt = await prepareTestingCore({ ...f,
      phase: async (name: string, run: () => Promise<unknown>) => {
        if (name === 'final') {
          writeFileSync(unrelated, 'another agent wrote state');
          rmSync(unrelated);
        }
        return run();
      } });
    expect(verifyTestingCoreReceipt(receipt, receipt.witness)).toEqual(receipt.witness);
  });

  it('probes native namespace support independently of inherited Node preloads', () => {
    const f = fixture(), universe = captureTestingCoreInputUniverse(f.root, dirname(f.outfile));
    const ordinary = createTestingCoreResolverNamespace(universe);
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = '--import=/does-not-exist/testing-core-probe-must-stay-native.mjs';
      expect(createTestingCoreResolverNamespace(universe)).toEqual(ordinary);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });

  it.each(['package.json', 'tsconfig.json'])(
    'still refuses A/B/restore of original enclosing %s', async name => {
      const f = fixture(), metadata = join(dirname(f.root), name);
      const original = name === 'package.json' ? '{"type":"module"}' : '{"compilerOptions":{}}';
      writeFileSync(metadata, original);
      await expect(prepareTestingCore({ ...f,
        phase: async (phase: string, run: () => Promise<unknown>) => {
          if (phase === 'final') {
            writeFileSync(metadata, '{}');
            writeFileSync(metadata, original);
          }
          return run();
        } })).rejects.toThrow(/identity changed|interval changed/);
      expect(existsSync(f.outfile)).toBe(false);
    });

  it('keeps a newly created enclosing dependency outside the native resolver namespace', async () => {
    const f = fixture(), dependency = join(dirname(f.root), 'node_modules/late-ancestor');
    f.put('core.ts', 'export {result} from "late-ancestor";');
    const closed = createTestingCoreResolverNamespace(
      captureTestingCoreInputUniverse(f.root, dirname(f.outfile))) !== undefined;
    await expect(prepareTestingCore({ ...f,
      phase: async (phase: string, run: () => Promise<unknown>) => {
        if (phase === 'discovery') {
          mkdirSync(dependency, { recursive: true });
          writeFileSync(join(dependency, 'package.json'), '{"name":"late-ancestor","main":"index.js"}');
          writeFileSync(join(dependency, 'index.js'), 'export const result = 99;');
        }
        return run();
      } })).rejects.toThrow(closed ? /Could not resolve "late-ancestor"/ : /outside original census|interval changed/);
    expect(existsSync(f.outfile)).toBe(false);
    // The same real native binary resolves the new host dependency outside the
    // namespace. Merely dropping ancestor timestamp checks cannot pass this.
    const raw = spawnSync(compilerPath, [join(f.root, 'core.ts'), '--bundle', '--platform=node', '--format=esm'],
      { encoding: 'utf8' });
    expect(raw.status, raw.stderr).toBe(0);
    expect(raw.stdout).toContain('99');
  });

  it('retains arbitrary-extension recursive JSONC configuration inputs and their changes', async () => {
    const f = fixture();
    f.put('tsconfig.json', '{"extends":"./compiler.settings",}');
    f.put('compiler.settings', '{/* comment */ "\\u0065xtends":"./base.settings", "compilerOptions":{"target":"ES2022",},}');
    f.put('base.settings', '{"compilerOptions":{"useDefineForClassFields":true}}');
    const first = await prepareTestingCore(f);
    expect(first.input.sources.map((row: {path: string}) => row.path))
      .toEqual(expect.arrayContaining(['compiler.settings', 'base.settings']));
    f.put('base.settings', '{"compilerOptions":{"useDefineForClassFields":false}}');
    const next = await prepareTestingCore(f);
    expect(next.witness.sourceSha256).not.toBe(first.witness.sourceSha256);
  });

  it('refuses A/B/restore of a native arbitrary-extension config without replacing LKG', async () => {
    const f = fixture();
    f.put('tsconfig.json', '{"extends":"./compiler.settings"}');
    f.put('compiler.settings', '{"compilerOptions":{"target":"ES2022"}}');
    await prepareTestingCore(f);
    const before = readFileSync(f.outfile), original = readFileSync(join(f.root, 'compiler.settings'));
    await expect(prepareTestingCore({ ...f, phase: async (name: string, run: () => Promise<unknown>) => {
      if (name === 'final') {
        f.put('compiler.settings', '{"compilerOptions":{"target":"ES2020"}}');
        writeFileSync(join(f.root, 'compiler.settings'), original);
      }
      return run();
    } })).rejects.toThrow(/identity changed|interval changed/);
    expect(readFileSync(f.outfile)).toEqual(before);
  });

  it.each(['../escaped.settings', './dist-host/excluded.settings', 'unqualified-package'])(
    'refuses native configuration outside the qualified closure: %s', async extension => {
      const f = fixture();
      await prepareTestingCore(f);
      const before = readFileSync(f.outfile);
      f.put('tsconfig.json', JSON.stringify({ extends: extension }));
      if (extension !== 'unqualified-package') f.put(extension, '{"compilerOptions":{"target":"ES2022"}}');
      await expect(prepareTestingCore(f)).rejects.toThrow(/configuration .*outside/);
      expect(readFileSync(f.outfile)).toEqual(before);
    });

  it('guards the pinned native compiler ignoring implicit dependency tsconfigs', async () => {
    const f = fixture(), dependency = join(f.root, 'node_modules/native-config-boundary');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"name":"native-config-boundary","main":"index.ts"}');
    writeFileSync(join(dependency, 'tsconfig.json'), '{"compilerOptions":{"useDefineForClassFields":false}}');
    writeFileSync(join(dependency, 'index.ts'), 'class Base { set field(value: number) {} } class Example extends Base { field = 1; } export const result = Object.hasOwn(new Example(), "field");');
    f.put('core.ts', 'export {result} from "native-config-boundary";');
    const receipt = await prepareTestingCore(f);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'console.log((await import(process.argv[1])).runTestFilesCore());', f.outfile], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('true');
    expect(verifyTestingCoreReceipt(receipt, receipt.witness)).toEqual(receipt.witness);
  });

  it('keeps unrelated application JSON outside compiler input hashes', async () => {
    const f = fixture();
    f.put('.mcp.json', '{"client":"before"}');
    const first = await prepareTestingCore(f);
    f.put('.mcp.json', '{"client":"after"}');
    const next = await prepareTestingCore(f);
    expect(next.witness.sourceSha256).toBe(first.witness.sourceSha256);
    expect(next.input.sources.map((row: {path: string}) => row.path)).not.toContain('.mcp.json');
  });

  it('keeps verification archive dependency metadata outside compiler custody during hard-link churn', () => {
    const f = fixture();
    const metadata = 'apps/operator/dist-verify/previous-build/node_modules/archive-only/package.json';
    f.put(metadata, '{"name":"archive-only"}');
    const universe = captureTestingCoreInputUniverse(f.root, dirname(f.outfile));
    const alias = join(dirname(join(f.root, metadata)), 'linked-package.json');
    linkSync(join(f.root, metadata), alias);
    rmSync(alias);
    const retained = retainTestingCoreResolverMetadata(universe);
    expect(retained.some((row: {path: string}) => row.path.includes('dist-verify'))).toBe(false);
    expect(retained.some((row: {path: string}) => row.path === join(f.root, 'package.json'))).toBe(true);
  });

  it('refuses a module input from a verification archive at the compiler custody boundary', () => {
    const f = fixture();
    const archived = 'apps/operator/dist-verify/previous-build/core.ts';
    f.put(archived, 'export const result = 99;');
    const universe = captureTestingCoreInputUniverse(f.root, dirname(f.outfile));
    const custody = createCompilerInputCustody({ root: universe.domainRoot, files: universe.files,
      discoverInputs: true, verifyBoundary: () => {} });
    expect(custody.readToolchainInput(join(f.root, 'core.ts')).contents.toString()).toContain('42');
    expect(() => custody.readToolchainInput(join(f.root, archived))).toThrow(/outside original census/);
    expect(existsSync(f.outfile)).toBe(false);
  });

  it('admits a generic product-named SOURCE directory below a package root (EI-28737711143045377)', () => {
    const f = fixture();
    // operator-core/lib/agent-tools/build holds the build:* tool group; a
    // basename-only exclusion refused it and failed every staging host bundle.
    const source = 'packages/operator-core/lib/agent-tools/build/typecheck.ts';
    f.put(source, 'export const typecheck = 1;');
    f.put('packages/operator-core/package.json', '{"name":"operator-core"}');
    const products = ['packages/operator-core/build/stale.js', 'packages/operator-core/dist/stale.js', 'out/stale.js'];
    for (const product of products) f.put(product, 'export const stale = 1;');
    const universe = captureTestingCoreInputUniverse(f.root, dirname(f.outfile));
    const custody = createCompilerInputCustody({ root: universe.domainRoot, files: universe.files,
      discoverInputs: true, verifyBoundary: () => {} });
    expect(custody.readToolchainInput(join(f.root, source)).contents.toString()).toContain('typecheck');
    for (const product of products)
      expect(() => custody.readToolchainInput(join(f.root, product))).toThrow(/outside original census/);
  });

  it('refuses symlinked native configuration without guessing extends semantics', async () => {
    const f = fixture();
    f.put('compiler.settings', '{"compilerOptions":{"target":"ES2022"}}');
    rmSync(join(f.root, 'tsconfig.json'));
    const link = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {symlinkSync} from "node:fs";symlinkSync("compiler.settings",process.argv[1]);',
      join(f.root, 'tsconfig.json')], { encoding: 'utf8' });
    expect(link.status, link.stderr).toBe(0);
    await expect(prepareTestingCore(f)).rejects.toThrow(/configuration symlink.*outside/);
    expect(existsSync(f.outfile)).toBe(false);
  });

  it('observes contrasting native class-field behavior for an applicable source config', async () => {
    const f = fixture();
    f.put('tsconfig.json', '{"compilerOptions":{"useDefineForClassFields":false}}');
    f.put('core.ts', 'class Base { set field(value: number) {} } class Example extends Base { field = 1; } export const result = Object.hasOwn(new Example(), "field");');
    await prepareTestingCore(f);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'console.log((await import(process.argv[1])).runTestFilesCore());', f.outfile], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('false');
  });
});
