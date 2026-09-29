import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(),
}));

import { readQueue } from '../locks/su-lock-store';
import { runTestFilesCore } from './run';
import { mutationProbeRefusal } from './mutation-probe-fence';

const readQueueMock = vi.mocked(readQueue);
let root: string;

afterEach(() => {
  readQueueMock.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'testing-run-mutation-probe-fence-'));
  return root;
}

it('refuses the run before root discovery when the checkout has an active mutation-probe lock', async () => {
  readQueueMock.mockResolvedValue({
    active_locks: [{
      lock_id: 'probe-lock',
      path: 'src/subject.ts',
      owner: 'peer',
      owner_label: 'Peer',
      intent: ' mutation probe ',
      goal_ref: null,
      acquired_ts: new Date('2026-09-24T07:00:00.000Z'),
      expires_ts: new Date('2026-09-24T08:00:00.000Z'),
      coordination_domain: '/repo',
    }],
    waiting: [],
  });

  const checkout = makeRoot();
  const result = await runTestFilesCore({ root: checkout, files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect("hint" in result ? result.hint : undefined).toContain('src/subject.ts');
  expect(readQueueMock).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: checkout });
});

it('fails closed when the lock ledger cannot establish whether a probe is active', async () => {
  readQueueMock.mockRejectedValue(new Error('lock ledger unavailable'));

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_state_unknown' });
  expect("hint" in result ? result.hint : undefined).toContain('lock ledger unavailable');
});

it('continues to ordinary root validation when no mutation-probe lock is active', async () => {
  readQueueMock.mockResolvedValue({ active_locks: [], waiting: [] });

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'invalid_root' });
});

// EI-24100872054224181 secondary: the fence used to refuse the WHOLE checkout. It now admits a
// test file only when its import closure provably cannot observe the probed source.
describe('mutationProbeRefusal narrowing', () => {
  const probe = (...paths: string[]) => ({ probePaths: async () => paths });
  function checkout(files: Record<string, string>): string {
    const dir = makeRoot();
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }
  const base = {
    'src/subject.ts': 'export const subject = 1;\n',
    'src/other.ts': 'export const other = 2;\n',
    'src/mid.ts': "export { subject } from './subject';\n",
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', main: 'index.js' }),
    'node_modules/pkg/index.js': 'exports.value = 3;\n',
  };

  it('admits a test whose closure excludes the probed source, including packages it imports', async () => {
    const dir = checkout({ ...base,
      'tests/other.test.ts': "import { other } from '../src/other';\nimport { value } from 'pkg';\nimport { join } from 'node:path';\nexport default [other, value, join];\n" });
    await expect(mutationProbeRefusal(dir, ['tests/other.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  it('admits an untraceable dynamic import only while a matching original-byte overlay is published', async () => {
    const dir = checkout({ ...base,
      'tests/dynamic.test.ts': 'export const load = (name: string) => import(name);\n',
    });
    const manifestDir = join('/tmp', `papercusp-mutation-probe-${process.getuid?.() ?? 0}-${createHash('sha256').update(dir).digest('hex')}`);
    mkdirSync(manifestDir, { mode: 0o700 });
    try {
      writeFileSync(join(manifestDir, 'original.manifest'),
        `${dir}\0${join(dir, 'src/subject.ts')}\0${join(dir, 'snapshot.ts')}\0${process.pid}\0`);
      await expect(mutationProbeRefusal(dir, ['tests/dynamic.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
      await expect(mutationProbeRefusal(dir, ['tests/dynamic.test.ts'], probe('src/other.ts')))
        .resolves.toMatchObject({ error: 'mutation_probe_active' });
    } finally {
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it('does not mistake a commented literal package import for a dynamic import', async () => {
    const dir = checkout({ ...base,
      'tests/commented.test.ts': "export const load = () => import(/* package name */ 'pkg');\n" });
    await expect(mutationProbeRefusal(dir, ['tests/commented.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  // EI-24556278753778650: the bundle-text scan refused every test reaching a module whose STRING
  // mentioned `import(...)` (a real operator-core test prose message did exactly that).
  it('does not mistake import()/require() text inside strings or comments for a call', async () => {
    const dir = checkout({ ...base,
      'src/prose.ts': "// see import(name) and require(x) below\nexport const msg = 'import(...) throws this exact V8-level message before ' + `require(${1})`;\n",
      'tests/prose.test.ts': "import { msg } from '../src/prose';\nexport default msg;\n" });
    await expect(mutationProbeRefusal(dir, ['tests/prose.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  it('refuses a test that imports the probed source, directly or transitively', async () => {
    const dir = checkout({ ...base,
      'tests/direct.test.ts': "import { subject } from '../src/subject';\nexport default subject;\n",
      'tests/transitive.test.ts': "import { subject } from '../src/mid';\nexport default subject;\n" });
    for (const test of ['tests/direct.test.ts', 'tests/transitive.test.ts']) {
      const refusal = await mutationProbeRefusal(dir, [test], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain(`${test} may observe it: imports`);
    }
  });

  it('refuses when any one requested test can observe the probe', async () => {
    const dir = checkout({ ...base,
      'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n",
      'tests/direct.test.ts': "import { subject } from '../src/subject';\nexport default subject;\n" });
    const refusal = await mutationProbeRefusal(dir, ['tests/other.test.ts', 'tests/direct.test.ts'], probe('src/subject.ts'));
    expect(refusal!.hint).toContain('tests/direct.test.ts may observe it');
  });

  it('fails closed on every reach the import graph cannot see', async () => {
    const dir = checkout({ ...base,
      'src/data.sql': 'select 1;\n',
      'src/loader.ts': "import { readFileSync } from 'node:fs';\nexport const text = () => readFileSync(`src/${'subject'}.ts`, 'utf8');\n",
      'tests/dynamic.test.ts': "export const load = (name: string) => import(name);\n",
      'tests/commented-dynamic.test.ts': "export const load = (name: string) => import(/* runtime */ name);\n",
      'tests/template-dynamic.test.ts': "export const load = (name: string) => import(`../src/${name}.ts`);\n",
      'tests/named.test.ts': "import { text } from '../src/loader';\nexport default text;\n",
      'tests/walks.test.ts': "import { readdirSync } from 'node:fs';\nexport default readdirSync('src');\n",
      'tests/unresolved.test.ts': "import { gone } from '../src/gone';\nexport default gone;\n",
      'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n" });
    const cases: Array<[string, string, string]> = [
      ['tests/dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/commented-dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/template-dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/named.test.ts', 'src/subject.ts', 'loader.ts names subject'],
      ['tests/walks.test.ts', 'src/subject.ts', 'reads the filesystem or spawns a process'],
      ['tests/unresolved.test.ts', 'src/subject.ts', 'import closure could not be established'],
      ['tests/missing.test.ts', 'src/subject.ts', 'could not be resolved'],
      ['tests/other.test.ts', 'src/data.sql', 'is not a code module'],
    ];
    for (const [test, probed, why] of cases) {
      const refusal = await mutationProbeRefusal(dir, [test], probe(probed));
      expect(refusal, test).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint, test).toContain(why);
    }
  });

  // EI-24556278753778650: a createRequire loader used to refuse EVERY test whose closure held the
  // text `createRequire(` — including the db connection module reached by most operator-core tests.
  describe('createRequire loaders', () => {
    const lazyNodeRequire = [
      "import { createRequire } from 'node:module';",
      'let _nodeRequire: ReturnType<typeof createRequire> | undefined;',
      'const nodeRequire = (id: string): unknown => (_nodeRequire ??= createRequire(import.meta.url))(id);',
      "export const home = () => (nodeRequire('node:os') as { homedir(): string }).homedir();",
      "export const exists = (p: string) => (nodeRequire('node:fs') as { existsSync(p: string): boolean }).existsSync(p);",
    ].join('\n');

    it('admits a test that reaches a createRequire loader of builtins only (the libs/db connection idiom)', async () => {
      const dir = checkout({ ...base,
        'src/connection.ts': `${lazyNodeRequire}\n// never \`createRequire(import.meta.url)(x)\` eagerly\n`,
        'tests/db.test.ts': "import { home } from '../src/connection';\nimport { other } from '../src/other';\nexport default [home, other];\n" });
      await expect(mutationProbeRefusal(dir, ['tests/db.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
    });

    it('follows a literal createRequire edge into the probed source and refuses', async () => {
      const dir = checkout({ ...base,
        'src/cr-loader.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const mod = req('./mid');\n",
        'tests/cr.test.ts': "import { mod } from '../src/cr-loader';\nexport default mod;\n" });
      const refusal = await mutationProbeRefusal(dir, ['tests/cr.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      // Reached through the resolved edge (cr-loader → mid → subject), not a name heuristic.
      expect(refusal!.hint).toContain(`imports ${join(dir, 'src/subject.ts')}`);
    });

    it('refuses only the tests whose closure reaches an unfollowable createRequire loader', async () => {
      const dir = checkout({ ...base,
        'src/dyn-loader.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const load = (n: string) => req(n);\n",
        'tests/dyn.test.ts': "import { load } from '../src/dyn-loader';\nexport default load;\n",
        'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n" });
      await expect(mutationProbeRefusal(dir, ['tests/other.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
      const refusal = await mutationProbeRefusal(dir, ['tests/other.test.ts', 'tests/dyn.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('tests/dyn.test.ts may observe it');
      expect(refusal!.hint).toContain('createRequire loader this walk cannot follow');
    });
  });

  it('makes no closure walk when no probe is active', async () => {
    await expect(mutationProbeRefusal(makeRoot(), ['tests/absent.test.ts'], probe())).resolves.toBeNull();
  });
});
