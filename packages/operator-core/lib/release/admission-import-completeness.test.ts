/**
 * P-004 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): admission completeness.
 *
 * The scanner and resolver are pure and tested as such — including the CONTROL that a quoted
 * import statement (which this very file is full of) is NOT read as an import, because the
 * door check will one day scan this file. The door check itself runs against a REAL temporary
 * git repository: the property is "does this path exist in that commit's tree", and only git
 * answers that. One injected runner covers the submodule and instrument-failure branches a
 * plain repo cannot produce cheaply.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkAdmissionImportCompleteness,
  extractRelativeImportSpecifiers,
  importCompletenessPreflight,
  renderMissingImports,
  resolveImportCandidates,
} from './admission-import-completeness';
import { admitPathsOntoRepairHead, frozenLineageRef, type AdmissionGitRunner } from './repair-head-admission';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOME = mkdtempSync(join(tmpdir(), 'admit-complete-home-'));
TEMP.push(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string | null>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(join(root, rel));
    else write(root, rel, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}
function refAt(root: string, ref: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', ref]) || null;
  } catch {
    return null;
  }
}

/** The frozen candidate is the first commit; `lib/b.ts` deliberately does NOT exist there. */
function repo(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'admit-complete-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  write(root, 'lib/a.ts', 'export const a = 1;\n');
  write(root, 'lib/c.ts', 'export const c = 1;\n');
  write(root, 'lib/dir/index.ts', 'export const d = 1;\n');
  write(root, 'lib/gone.ts', 'export const gone = 1;\n');
  write(root, 'docs/x.md', '# x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate']);
  return { root, candidate: git(root, ['rev-parse', 'HEAD']) };
}

const T0 = 1_800_000_000_000;
const admit = (
  root: string,
  candidate: string,
  paths: string[],
  extra: Partial<Parameters<typeof admitPathsOntoRepairHead>[0]> = {},
) =>
  admitPathsOntoRepairHead({
    root,
    candidate,
    repairHead: candidate,
    paths,
    source: { ref: 'staging' },
    actor: 'su-test',
    nowMs: T0,
    ...extra,
  });

describe('extractRelativeImportSpecifiers — relative specifiers in import position only', () => {
  it('reads static, type-only, side-effect, re-export, dynamic and require forms, in order', () => {
    const src = [
      "import { a } from './a';",
      'import type { T } from "../types";',
      "import './side-effect';",
      "export * from './re';",
      "export { x } from './re2';",
      "const m = await import('./dyn');",
      "const r = require('./req');",
      "import def, * as ns from './mixed';",
    ].join('\n');
    expect(extractRelativeImportSpecifiers(src)).toEqual([
      './a',
      '../types',
      './side-effect',
      './re',
      './re2',
      './dyn',
      './req',
      './mixed',
    ]);
  });

  it('CONTROL: ignores bare specifiers, comments, strings and templates that merely QUOTE an import, and non-import call sites', () => {
    const src = [
      "import { describe } from 'vitest';",
      "import x from '@/alias';",
      "// import y from './commented-line';",
      "/* import z from './commented-block'; */",
      'const quoted = "import q from \'./quoted-double\';";',
      'const quoted2 = \'import q from "./quoted-single";\';',
      "const tpl = `import t from './templated'; ${\"import u from './nested'\"}`;",
      "const url = 'https://example.test/x'; import real from './after-url';",
      "expect(fn('./argument')).toBe(1); foo.from('./method'); require.resolve('./resolved');",
      'const attr = <a from="./jsx-attr" />;',
    ].join('\n');
    expect(extractRelativeImportSpecifiers(src)).toEqual(['./after-url']);
  });

  it('dedupes and tolerates an unterminated string without throwing or swallowing the next line', () => {
    expect(
      extractRelativeImportSpecifiers(
        "import a from './a';\nimport b from './a';\nconst s = 'oops\nimport c from './c';",
      ),
    ).toEqual(['./a', './c']);
  });
});

describe('resolveImportCandidates — TS bundler/node16 shapes, in probe order', () => {
  it('rewrites .js → .ts/.tsx (and .mjs → .mts) before trying the literal', () => {
    expect(resolveImportCandidates('lib/a.ts', './b.js')).toEqual(['lib/b.ts', 'lib/b.tsx', 'lib/b.js']);
    expect(resolveImportCandidates('lib/a.mts', '../x/y.mjs')).toEqual(['x/y.mts', 'x/y.mjs']);
  });
  it('probes extensions then index files for an extensionless specifier', () => {
    const c = resolveImportCandidates('lib/deep/a.ts', '../b');
    expect(c?.[0]).toBe('lib/b.ts');
    expect(c).toContain('lib/b.d.ts');
    expect(c).toContain('lib/b/index.ts');
  });
  it('takes an explicit asset/TS extension literally, strips ?raw/?url, and refuses to escape the repo', () => {
    expect(resolveImportCandidates('lib/a.ts', './style.css?raw')).toEqual(['lib/style.css']);
    expect(resolveImportCandidates('lib/a.ts', './b.ts')).toEqual(['lib/b.ts']);
    expect(resolveImportCandidates('lib/a.ts', '../../outside')).toBeNull();
    expect(resolveImportCandidates('a.ts', '../x')).toBeNull();
  });
  it('an unknown "extension" is part of the name: the literal first, then the probes', () => {
    const c = resolveImportCandidates('lib/a.ts', './foo.service');
    expect(c?.slice(0, 2)).toEqual(['lib/foo.service', 'lib/foo.service.ts']);
  });
});

describe('checkAdmissionImportCompleteness — real git', () => {
  it('names the sibling an admitted file imports that is absent at the commit, says it exists on the probe ref, and passes once both are admitted', () => {
    const { root, candidate } = repo();
    sweep(
      root,
      { 'lib/a.ts': "import { b } from './b';\nexport const a = b + 1;\n", 'lib/b.ts': 'export const b = 1;\n' },
      'a fix that spans two files',
    );
    const only = admit(root, candidate, ['lib/a.ts'], { dryRun: true });
    expect(only.ok).toBe(true);
    if (!only.ok) return;
    const r = checkAdmissionImportCompleteness({ root, commit: only.commit, paths: only.diff, probeRef: 'staging' });
    expect(r).toMatchObject({
      ok: false,
      code: 'admission-incomplete',
      checked: ['lib/a.ts'],
      imports: 1,
      missing: [{ from: 'lib/a.ts', specifier: './b', wanted: 'lib/b.ts', atProbeRef: 'present' }],
    });
    if (r.ok || r.code !== 'admission-incomplete') return;
    expect(r.missing[0]?.tried[0]).toBe('lib/b.ts');
    expect(renderMissingImports(r.missing)).toContain('lib/b.ts (exists on the shared tip — admit it too)');

    const both = admit(root, candidate, ['lib/a.ts', 'lib/b.ts'], { dryRun: true });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(
      checkAdmissionImportCompleteness({ root, commit: both.commit, paths: both.diff, probeRef: 'staging' }),
    ).toMatchObject({
      ok: true,
      checked: ['lib/a.ts', 'lib/b.ts'],
      imports: 1,
    });
  });

  it('resolves .js→.ts, /index.*, explicit extensions and ?raw at the commit; skips non-code paths and deletions; ignores a commented import', () => {
    const { root, candidate } = repo();
    sweep(
      root,
      {
        'lib/a.ts':
          "import { c } from './c.js';\nimport { d } from './dir';\nimport md from '../docs/x.md?raw';\n" +
          "// import './ghost';\nexport const a = c + d + md.length;\n",
        'docs/x.md': '# x2\n',
        'lib/gone.ts': null,
      },
      'fix',
    );
    const out = admit(root, candidate, ['lib/a.ts', 'docs/x.md', 'lib/gone.ts'], { dryRun: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diff.sort()).toEqual(['docs/x.md', 'lib/a.ts', 'lib/gone.ts']);
    const r = checkAdmissionImportCompleteness({ root, commit: out.commit, paths: out.diff, probeRef: 'staging' });
    expect(r).toMatchObject({ ok: true, checked: ['lib/a.ts'], imports: 3 });
    if (!r.ok) return;
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { path: 'docs/x.md', reason: 'not-scanned-extension' },
        { path: 'lib/gone.ts', reason: 'not-a-blob' },
      ]),
    );
  });

  it('reports atProbeRef absent when the tip lacks the file too, unknown without a probe ref, and skips an import that escapes the repo', () => {
    const { root, candidate } = repo();
    sweep(
      root,
      { 'lib/a.ts': "import { n } from './nowhere';\nimport o from '../../outside';\nexport const a = n + o;\n" },
      'fix',
    );
    const out = admit(root, candidate, ['lib/a.ts'], { dryRun: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      checkAdmissionImportCompleteness({ root, commit: out.commit, paths: out.diff, probeRef: 'staging' }),
    ).toMatchObject({
      ok: false,
      code: 'admission-incomplete',
      missing: [{ from: 'lib/a.ts', specifier: './nowhere', wanted: 'lib/nowhere.ts', atProbeRef: 'absent' }],
      skipped: [{ path: 'lib/a.ts', reason: 'escapes-repo', specifier: '../../outside' }],
    });
    expect(checkAdmissionImportCompleteness({ root, commit: out.commit, paths: out.diff })).toMatchObject({
      ok: false,
      missing: [{ atProbeRef: 'unknown' }],
    });
  });

  it('accepts a generated package dist import only when a tracked builder names that exact output', () => {
    const { root } = repo();
    const generated = sweep(
      root,
      {
        'apps/operator/tool.ts':
          "import native from '../../packages/demo/dist/native-client.cjs';\nexport { native };\n",
        'packages/demo/build-native.mjs':
          "const outfile = root + 'packages/demo/dist/native-client.cjs';\nexport { outfile };\n",
      },
      'tracked generated output',
    );
    expect(
      checkAdmissionImportCompleteness({ root, commit: generated, paths: ['apps/operator/tool.ts'] }),
    ).toMatchObject({
      ok: true,
      imports: 1,
      skipped: [
        {
          path: 'apps/operator/tool.ts',
          reason: 'generated-by-tracked-builder',
          specifier: '../../packages/demo/dist/native-client.cjs',
        },
      ],
    });

    const wrongOutput = sweep(
      root,
      { 'packages/demo/build-native.mjs': "const outfile = 'packages/demo/dist/other.cjs';\nexport { outfile };\n" },
      'builder no longer emits requested output',
    );
    expect(
      checkAdmissionImportCompleteness({ root, commit: wrongOutput, paths: ['apps/operator/tool.ts'] }),
    ).toMatchObject({
      ok: false,
      code: 'admission-incomplete',
      missing: [expect.objectContaining({ wanted: 'packages/demo/dist/native-client.cts' })],
    });
  });

  it('wired as the primitive preflight (the admit door): refuses BEFORE publish naming the path, the lineage ref never moves, and both paths then publish', () => {
    const { root, candidate } = repo();
    sweep(
      root,
      { 'lib/a.ts': "import { b } from './b';\nexport const a = b;\n", 'lib/b.ts': 'export const b = 2;\n' },
      'fix',
    );
    const preflight = importCompletenessPreflight({ root, probeRef: 'staging' });
    const refused = admit(root, candidate, ['lib/a.ts'], { preflight });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('admission-incomplete');
    expect(refused.missing).toEqual([
      { from: 'lib/a.ts', specifier: './b', wanted: 'lib/b.ts', tried: expect.any(Array), atProbeRef: 'present' },
    ]);
    expect(refused.detail).toContain('NOT published');
    expect(refused.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();

    const ok = admit(root, candidate, ['lib/a.ts', 'lib/b.ts'], { preflight });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.published).toBe(true);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(ok.commit);
  });
});

describe('injected runner — the branches a plain repo cannot produce cheaply', () => {
  const fake =
    (answers: {
      blob: string;
      batch: (input: string) => string | null;
      /** `ls-tree -d -z --full-tree <commit> -- <dirs>`: the NUL-terminated entries for the named dirs. */
      lsTree?: (dirs: string[]) => string;
    }): AdmissionGitRunner =>
    (argv, opts) => {
      if (argv[0] === 'cat-file' && argv[1] === 'blob') return { status: 0, stdout: answers.blob, stderr: '' };
      if (argv[0] === 'cat-file' && typeof argv[1] === 'string' && argv[1].startsWith('--batch-check')) {
        const out = answers.batch(opts.input ?? '');
        return out === null ? { status: 128, stdout: '', stderr: 'boom' } : { status: 0, stdout: out, stderr: '' };
      }
      if (argv[0] === 'ls-tree') {
        const dirs = argv.slice(argv.indexOf('--') + 1);
        return { status: 0, stdout: answers.lsTree ? answers.lsTree(dirs) : '', stderr: '' };
      }
      throw new Error(`unexpected git ${argv.join(' ')}`);
    };

  const gitlinkEntry = (path: string) => `160000 commit ${'d'.repeat(40)}\t${path}\0`;
  const treeEntry = (path: string) => `040000 tree ${'e'.repeat(40)}\t${path}\0`;

  it('an import that resolves under a gitlink is skipped as inside-submodule, never reported missing', () => {
    // Faithful to real git (measured 2026-09-06 on libs/generic/desktop-ipc): `cat-file
    // --batch-check` on `<commit>:lib/sub` resolves the gitlink to the SUBMODULE's commit oid,
    // which the superproject's object store does not hold, so it answers `<oid> missing` —
    // byte-identical to a deleted path. Only the tree ENTRY (`ls-tree -d`, mode 160000) tells
    // the two apart, and that is the probe the checker must ask.
    const git = fake({
      blob: "import { s } from './sub/x';\n",
      batch: (input) =>
        input
          .trim()
          .split('\n')
          .map((q) => `${q} missing`)
          .join('\n') + '\n',
      lsTree: (dirs) => dirs.map((d) => (d === 'lib/sub' ? gitlinkEntry(d) : d === 'lib' ? treeEntry(d) : '')).join(''),
    });
    expect(
      checkAdmissionImportCompleteness({ root: '/repo', commit: 'c'.repeat(40), paths: ['lib/a.ts'], git }),
    ).toMatchObject({
      ok: true,
      checked: ['lib/a.ts'],
      imports: 1,
      skipped: [{ path: 'lib/a.ts', reason: 'inside-submodule', specifier: './sub/x' }],
    });
  });

  it('an import under a plain (non-gitlink) ancestor that resolves to nothing is still reported missing', () => {
    // The dual of the case above: the same `missing` answers from cat-file, but ls-tree says the
    // ancestors are ordinary trees — so this IS a missing sibling and must be refused.
    const git = fake({
      blob: "import { s } from './sub/x';\n",
      batch: (input) =>
        input
          .trim()
          .split('\n')
          .map((q) => `${q} missing`)
          .join('\n') + '\n',
      lsTree: (dirs) => dirs.map((d) => (d === 'lib/sub' || d === 'lib' ? treeEntry(d) : '')).join(''),
    });
    expect(
      checkAdmissionImportCompleteness({ root: '/repo', commit: 'c'.repeat(40), paths: ['lib/a.ts'], git }),
    ).toMatchObject({
      ok: false,
      code: 'admission-incomplete',
      missing: [expect.objectContaining({ from: 'lib/a.ts', specifier: './sub/x', wanted: 'lib/sub/x.ts' })],
    });
  });

  it('an instrument failure is git-failed, and the wired preflight fails CLOSED with it', () => {
    const git = fake({ blob: "import './b';\n", batch: () => null });
    expect(
      checkAdmissionImportCompleteness({ root: '/repo', commit: 'c'.repeat(40), paths: ['lib/a.ts'], git }),
    ).toMatchObject({
      ok: false,
      code: 'git-failed',
      step: 'cat-file --batch-check',
    });
    const stop = importCompletenessPreflight({ root: '/repo', git })({
      commit: 'c'.repeat(40),
      tree: 't'.repeat(40),
      admitted: ['lib/a.ts'],
    });
    expect(stop).toMatchObject({ code: 'git-failed', step: expect.stringContaining('completeness preflight') });
  });
});
