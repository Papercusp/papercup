/**
 * posttooluse-ts-parse-nudge — the recurrence guard for the unparseable-file-in-the-
 * shared-tree CLASS (EI-19457231269012320 / EI-19457320059999661).
 *
 * THE POINT OF THIS FILE: a parse-class detector already existed and was correct
 * (`tsParseDetector`, packages/operator-core/lib/content-lint/registry.ts) — it just
 * ran on the COMMIT path, and the 2026-08-03 :3170 outage never involved a commit.
 * bundle-host.sh bundles the WORKING TREE as ExecStartPre, so uncommitted bytes took
 * the port the whole fleet tests against down for 17 minutes. So the assertion that
 * matters here is not "the hook is well-formed" but **it FIRES on the real break**,
 * and the DRIFT GUARD below — which pins this hook's inline parse against the REAL
 * exported detector, so the two cannot silently diverge.
 *
 * The negative cases matter exactly as much. This hook runs on every .ts edit in the
 * fleet: one false positive on an ordinary edit and agents learn to ignore it, which
 * is precisely how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { findTsParseError } from '../../../../../../packages/operator-core/lib/content-lint/ts-parse';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');

/**
 * The subject under test, overridable by env. This exists so falsifiability can be
 * proven with scripts/mutation-probe.sh in its default COPY-OUT mode — mutating a
 * copy OUTSIDE the tree, which is the only form with no sweep race. git-sync commits
 * the whole working tree every few minutes, so an in-tree mutation held for the
 * length of a suite run can be committed even when nothing goes wrong and no trap
 * fires (that is how a committed mutant of verify-tauri-headless.sh reached staging
 * on 2026-08-03, EI-19450431506682666). Defaults to the real file.
 */
const HOOK = process.env.PROBE_HOOK
  ? resolve(process.env.PROBE_HOOK)
  : resolve(__dirname, '../posttooluse-ts-parse-nudge.mjs');

type Hit = { line: number | null; col: number | null; code: number; reason: string };
type HookMod = {
  findParseError: (ts: unknown, fileName: string, text: string, compilerOptions?: Record<string, unknown>) => Hit | null;
  isCandidateFile: (f: string) => boolean;
  isWithinRepo: (repoRoot: string, filePath: string) => boolean;
  nudgeFor: (f: string, deps?: Record<string, unknown>) => Promise<string | null>;
  formatNudge: (rel: string, hit: Hit) => string;
  logFiring: (rel: string, hit: Hit | null, deps?: Record<string, unknown>) => void;
};

async function hookMod(): Promise<HookMod> {
  return (await import(`file://${HOOK}`)) as unknown as HookMod;
}

/**
 * The real break, byte-for-byte in shape: a markdown-quoted identifier inside a SQL
 * comment that lives inside a tagged template literal. The backtick is \x60 so this
 * FILE does not itself trip `sqlCommentBacktickDetector` and get quarantined by the
 * git-sync content-guard — verified 2026-08-03, literal backticks here produce a real
 * hit with backticks:3.
 */
const OUTAGE_SHAPE =
  'const rows = await sql\x60\n  SELECT 1\n  -- crowded out; \x60name\x60 is a tiebreak\n  ORDER BY 1\x60;\n';

/**
 * The 2026-08-10 break, in shape: a duplicate block-scoped declaration. Unlike every
 * syntax case above, this one PARSES — a redeclaration is an ECMAScript early error, so
 * `parseDiagnostics` is empty and the grammar phase's only finding is TS2451.
 */
const DUPLICATE_CONST_SHAPE =
  'export function f(ownerId: string) {\n  const sessionId = ownerId ? "a" : null;\n  const sessionId = ownerId ? "b" : null;\n  return sessionId;\n}\n';

function optionSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'tsparse-config-'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"sandbox"}\n');
  symlinkSync(resolve(ROOT, 'node_modules/typescript'), join(dir, 'node_modules/typescript'));
  return dir;
}

/** Cases the hook and the real detector must agree on, exactly. */
const CORPUS: Array<[name: string, file: string, text: string]> = [
  ['the 2026-08-03 outage shape', 'watchdog.ts', OUTAGE_SHAPE],
  ['a clean module', 'a.ts', 'export const a: number = 1;\n'],
  ['an unclosed paren', 'b.ts', 'export function f( {\n'],
  ['an unterminated template', 'c.ts', 'const s = \x60abc\n'],
  ['a type error only', 'd.ts', 'const n: number = "nope";\n'],
  ['an unresolved import', 'e.ts', 'import { x } from "./nowhere";\nexport const y = x;\n'],
  ['tsx with JSX', 'f.tsx', 'export const C = () => <div className="x">hi</div>;\n'],
  ['tsx with broken JSX', 'g.tsx', 'export const C = () => <div>;\n'],
  ['an empty-ish file', 'h.ts', '\n'],
  ['decorators + generics', 'i.ts', 'export class A<T> { m(x: T): T { return x; } }\n'],
  ['a stray closing brace', 'j.ts', 'export const a = 1;\n}\n'],
  // WI-37398 — the DUPLICATE MODIFIER class. The parser accepts these (the error comes
  // from the checker), so before the two-phase fix BOTH sides agreed on the wrong
  // answer and this drift guard passed while exercising none of the code that matters.
  // Without these rows the hook's grammar phase is never entered by any test.
  ['the WI-37398 doubled export', 'corpus-recall-io.ts', "export export const A = ['x'] as const;\n"],
  ['a doubled async modifier', 'k.ts', 'export async async function f() {}\n'],
  ['a doubled accessibility modifier', 'l.ts', 'class C { public public x = 1; }\n'],
  // EI-19457229906581679 — the 2026-08-10 outage shape. Parses cleanly AND passes the
  // grammar phase; its only signal is TS2451, which the <2000 bound discarded. esbuild
  // refuses it, so it took :3170 down fleet-wide while this very guard was installed.
  ['the 2026-08-10 duplicate-const outage shape', 'launch-su.ts', DUPLICATE_CONST_SHAPE],
  // The counterweight: 2xxx diagnostics the noLib grammar phase raises ON ITS OWN. These
  // MUST stay silent, and they are why the fix is an enumerated set of esbuild-fatal codes
  // rather than a raised bound (a raised bound would flag every async function in the repo).
  ['noLib-only Promise/console noise', 'm.ts', 'export async function f() {\n  console.log(1);\n  return Promise.resolve(2);\n}\n'],
];

describe('posttooluse-ts-parse-nudge', () => {
  it('DRIFT GUARD: agrees with the real findTsParseError on every corpus case', async () => {
    const { findParseError } = await hookMod();
    const ts = (await import('typescript')).default;

    const disagreements: string[] = [];
    for (const [name, file, text] of CORPUS) {
      const mine = findParseError(ts, file, text);
      const real = findTsParseError(file, text);
      const sameShape =
        (mine === null) === (real === null) &&
        (mine === null ||
          (mine.line === real!.line && mine.col === real!.col && mine.code === real!.code && mine.reason === real!.reason));
      if (!sameShape) {
        disagreements.push(`${name}: hook=${JSON.stringify(mine)} detector=${JSON.stringify(real)}`);
      }
    }
    expect(disagreements, `hook parse diverged from findTsParseError:\n  ${disagreements.join('\n  ')}`).toEqual([]);
  });

  it('the corpus actually exercises BOTH outcomes (guards a vacuous drift check)', async () => {
    const broken = CORPUS.filter(([, f, t]) => findTsParseError(f, t) !== null).length;
    const clean = CORPUS.length - broken;
    expect(broken, 'no failing case in the corpus').toBeGreaterThan(0);
    expect(clean, 'no clean case in the corpus').toBeGreaterThan(0);
  });

  it('FIRES on the real 2026-08-03 outage shape', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    const msg = await nudgeFor('/repo/pkg/watchdog.ts', {
      repoRoot: '/repo',
      exists: () => true,
      sizeOf: () => OUTAGE_SHAPE.length,
      readFile: () => OUTAGE_SHAPE,
      loadTs: async () => ts,
    });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/does NOT PARSE/);
    expect(msg).toMatch(/pkg\/watchdog\.ts/);
    // It must name the CONSEQUENCE, not just the syntax — that is why an author acts.
    expect(msg).toMatch(/bundle-host\.sh|ExecStartPre|WORKING TREE/);
  });

  // EI-19457229906581679 — this guard existed on 2026-08-10 and stayed silent while a
  // duplicate `const` crash-looped :3170 fleet-wide. The pair below is the whole fix: the
  // esbuild-fatal code must FIRE, and the noLib noise sharing its 2xxx range must NOT.
  it('FIRES on the 2026-08-10 duplicate-const outage shape (TS2451, above the grammar bound)', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    const msg = await nudgeFor('/repo/pkg/launch-su.ts', {
      repoRoot: '/repo',
      exists: () => true,
      sizeOf: () => DUPLICATE_CONST_SHAPE.length,
      readFile: () => DUPLICATE_CONST_SHAPE,
      loadTs: async () => ts,
    });
    expect(msg, 'a redeclaration esbuild refuses must not be silently filtered as a type error').toBeTruthy();
    expect(msg).toMatch(/does NOT PARSE/);
    expect(msg).toMatch(/sessionId/);
  });

  it('stays SILENT on the noLib-only 2xxx noise the grammar phase raises itself', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    // `noLib: true` makes TS report TS2318 (no global Promise) and TS2584 (no console) for
    // this perfectly ordinary file. Raising the bound instead of enumerating esbuild-fatal
    // codes would nag on every async function in the repo.
    const text = 'export async function f() {\n  console.log(1);\n  return Promise.resolve(2);\n}\n';
    const msg = await nudgeFor('/repo/pkg/ordinary.ts', {
      repoRoot: '/repo',
      exists: () => true,
      sizeOf: () => text.length,
      readFile: () => text,
      loadTs: async () => ts,
    });
    expect(msg, 'noLib artifacts must never produce a nudge').toBeNull();
  });

  it('honors the nearest tsconfig for decorators and import.meta', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    const dir = optionSandbox();
    const config = join(dir, 'tsconfig.json');
    const decoratorText =
      'declare function Inject(token: unknown): ParameterDecorator;\n' +
      'declare const TOKEN: unique symbol;\n' +
      'interface Store {}\n' +
      'class Service { constructor(@Inject(TOKEN) private readonly store: Store) {} }\n';
    const importMetaText = 'const api = import.meta.env.VITE_API_URL; export default api;\n';
    try {
      writeFileSync(config, JSON.stringify({ compilerOptions: { experimentalDecorators: true, module: 'esnext' } }));
      writeFileSync(join(dir, 'pkg/decorators.ts'), decoratorText);
      writeFileSync(join(dir, 'pkg/import-meta.tsx'), importMetaText);

      // Both are valid under the project's actual options. The old standalone
      // checker falsely reported TS1206/TS1343 before it read tsconfig.json.
      expect(await nudgeFor(join(dir, 'pkg/decorators.ts'))).toBeNull();
      expect(await nudgeFor(join(dir, 'pkg/import-meta.tsx'))).toBeNull();

      // Prove the diagnostics are still real when the project config disallows
      // the syntax; this is not a blanket suppression of option-gated errors.
      writeFileSync(config, JSON.stringify({ compilerOptions: { experimentalDecorators: false, module: 'commonjs' } }));
      expect(await nudgeFor(join(dir, 'pkg/decorators.ts'))).toMatch(/TS1206/);
      expect(await nudgeFor(join(dir, 'pkg/import-meta.tsx'))).toMatch(/TS1343/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent when the edited file is outside the protected repository', async () => {
    const { isWithinRepo, nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    expect(isWithinRepo('/repo', '/repo/packages/x/a.ts')).toBe(true);
    expect(isWithinRepo('/repo', '/other-repo/packages/x/a.ts')).toBe(false);

    const msg = await nudgeFor('/other-repo/packages/x/agent.ts', {
      repoRoot: '/repo',
      exists: () => true,
      sizeOf: () => 100,
      readFile: () => {
        throw new Error('outside-repo target must be rejected before reading');
      },
      loadTs: async () => ts,
    });
    expect(msg).toBeNull();
  });

  it('is SILENT on a clean file, a type error, and an unresolved import', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    const base = { repoRoot: '/repo', exists: () => true, sizeOf: () => 100, loadTs: async () => ts };
    for (const text of [
      'export const a: number = 1;\n',
      'const n: number = "nope";\n',
      'import { x } from "./nowhere";\nexport const y = x;\n',
    ]) {
      expect(await nudgeFor('/repo/pkg/a.ts', { ...base, readFile: () => text })).toBeNull();
    }
  });

  it('fails OPEN on an unreadable file, a missing typescript, and an oversized file', async () => {
    const { nudgeFor } = await hookMod();
    const ts = (await import('typescript')).default;
    const base = { repoRoot: '/repo', exists: () => true, sizeOf: () => 100 };
    const boom = () => {
      throw new Error('must not be reached');
    };
    expect(
      await nudgeFor('/repo/pkg/a.ts', { ...base, loadTs: async () => ts, readFile: boom }),
    ).toBeNull();
    expect(
      await nudgeFor('/repo/pkg/a.ts', { ...base, loadTs: async () => null, readFile: () => 'export function f( {\n' }),
    ).toBeNull();
    expect(
      await nudgeFor('/repo/pkg/a.ts', { ...base, sizeOf: () => 99_000_000, loadTs: async () => ts, readFile: boom }),
    ).toBeNull();
  });

  it('only considers TypeScript source paths', async () => {
    const { isCandidateFile } = await hookMod();
    for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.ts']) expect(isCandidateFile(f), f).toBe(true);
    for (const f of ['a.md', 'a.js', 'a.mjs', 'a.json', 'a.sql', 'a.rs']) expect(isCandidateFile(f), f).toBe(false);
  });

  it('passes its own embedded --self-test', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toMatch(/all cases passed/);
  });

  /**
   * EI-19899815073760910 — the hook is ADVISORY, so whether it WORKS is a behavioural
   * question ("does the agent repair the file before the next bundle?"). It used to
   * persist nothing, so that question was unanswerable: occurrence #3 landed ~7.5h after
   * the guard was authored and it was impossible to tell whether the hook had fired and
   * been ignored, or had never been registered. These pin the instrument.
   *
   * The fail-open cases carry the real weight. This runs AFTER an edit has succeeded,
   * so a throwing logger would convert a good edit into a hook error — the guard would
   * start causing the class of harm it exists to prevent.
   */
  describe('firing log (EI-19899815073760910)', () => {
    const HIT: Hit = { line: 3, col: 21, code: 1109, reason: 'Expression expected.' };

    async function fireOnce(deps: Record<string, unknown>) {
      const { nudgeFor } = await hookMod();
      const ts = (await import('typescript')).default;
      return nudgeFor('/repo/pkg/watchdog.ts', {
        repoRoot: '/repo',
        exists: () => true,
        sizeOf: () => OUTAGE_SHAPE.length,
        readFile: () => OUTAGE_SHAPE,
        loadTs: async () => ts,
        ...deps,
      });
    }

    it('reports the firing with the file and the STRUCTURED diagnostic, not just a message', async () => {
      const seen: Array<[string, Hit]> = [];
      const msg = await fireOnce({ onFire: (rel: string, hit: Hit) => seen.push([rel, hit]) });
      expect(msg).toBeTruthy();
      expect(seen).toHaveLength(1);
      const [rel, hit] = seen[0];
      // The path must be the REPO-RELATIVE one, not the absolute input: an absolute path
      // from a foreign checkout is exactly what makes a log unaggregatable later.
      expect(rel).toBe('pkg/watchdog.ts');
      // TS1005 is the MEASURED code for OUTAGE_SHAPE under these options (not 1109, which
      // the filing's prose quoted from a differently-configured run) — pinned deliberately,
      // as this file pins TS2451 elsewhere, so a renumbering surfaces rather than hides.
      expect(hit.code).toBe(1005);
      expect(typeof hit.line).toBe('number');
    });

    it('does NOT report when the hook stays silent — otherwise the log measures edits, not firings', async () => {
      const seen: unknown[] = [];
      const clean = 'export const a = 1;\n';
      const msg = await fireOnce({
        sizeOf: () => clean.length,
        readFile: () => clean,
        onFire: () => seen.push(1),
      });
      expect(msg).toBeNull();
      expect(seen).toHaveLength(0);
    });

    it('a THROWING onFire cannot break the nudge — an instrument must not break what it measures', async () => {
      const msg = await fireOnce({
        onFire: () => {
          throw new Error('logger exploded');
        },
      });
      expect(msg).toBeTruthy();
      expect(msg).toMatch(/does NOT PARSE/);
    });

    it('writes ONE json line carrying ts, file, code and line:col', async () => {
      const { logFiring } = await hookMod();
      const lines: string[] = [];
      logFiring('pkg/watchdog.ts', HIT, {
        mkdir: () => {},
        sizeOf: () => 0,
        rename: () => {},
        append: (_p: string, s: string) => lines.push(s),
        homedir: () => '/tmp/fake-home',
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].endsWith('\n')).toBe(true);
      const rec = JSON.parse(lines[0]);
      expect(rec.file).toBe('pkg/watchdog.ts');
      expect(rec.code).toBe(1109);
      expect(rec.at).toBe('3:21');
      expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('FAILS OPEN when the append throws — the edit already succeeded', async () => {
      const { logFiring } = await hookMod();
      expect(() =>
        logFiring('pkg/watchdog.ts', HIT, {
          mkdir: () => {},
          sizeOf: () => 0,
          rename: () => {},
          append: () => {
            throw new Error('EACCES');
          },
          homedir: () => '/tmp/fake-home',
        }),
      ).not.toThrow();
    });

    it('FAILS OPEN when the log directory cannot be created', async () => {
      const { logFiring } = await hookMod();
      const lines: string[] = [];
      expect(() =>
        logFiring('pkg/watchdog.ts', HIT, {
          mkdir: () => {
            throw new Error('EROFS');
          },
          append: (_p: string, s: string) => lines.push(s),
          homedir: () => '/tmp/fake-home',
        }),
      ).not.toThrow();
      expect(lines).toHaveLength(0);
    });

    it('rotates past 1 MiB, and still appends when the rotation probe throws', async () => {
      const { logFiring } = await hookMod();
      const renamed: Array<[string, string]> = [];
      const lines: string[] = [];
      logFiring('pkg/a.ts', HIT, {
        mkdir: () => {},
        sizeOf: () => (1 << 20) + 1,
        rename: (from: string, to: string) => renamed.push([from, to]),
        append: (_p: string, s: string) => lines.push(s),
        homedir: () => '/tmp/fake-home',
      });
      expect(renamed).toHaveLength(1);
      expect(renamed[0][1]).toBe(`${renamed[0][0]}.1`);
      expect(lines).toHaveLength(1);

      // A missing file (first write) makes the size probe throw; the sibling appends
      // anyway, and so must this — otherwise the log never gets its first line.
      const first: string[] = [];
      logFiring('pkg/a.ts', HIT, {
        mkdir: () => {},
        sizeOf: () => {
          throw new Error('ENOENT');
        },
        rename: () => {},
        append: (_p: string, s: string) => first.push(s),
        homedir: () => '/tmp/fake-home',
      });
      expect(first).toHaveLength(1);
    });

    it('tolerates a null hit rather than throwing on a malformed finding', async () => {
      const { logFiring } = await hookMod();
      const lines: string[] = [];
      expect(() =>
        logFiring('pkg/a.ts', null, {
          mkdir: () => {},
          sizeOf: () => 0,
          rename: () => {},
          append: (_p: string, s: string) => lines.push(s),
          homedir: () => '/tmp/fake-home',
        }),
      ).not.toThrow();
      expect(JSON.parse(lines[0]).at).toBeNull();
    });
  });

  describe('end-to-end through the real hook binary', () => {
    function sandbox() {
      const dir = mkdtempSync(join(tmpdir(), 'tsparse-hook-'));
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      mkdirSync(join(dir, 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"sandbox"}\n');
      symlinkSync(resolve(ROOT, 'node_modules/typescript'), join(dir, 'node_modules/typescript'));
      return dir;
    }
    const run = (payload: Record<string, unknown>, cwd = process.cwd()) =>
      execFileSync('node', [HOOK], {
        cwd,
        input: JSON.stringify({ ...payload, cwd }),
        encoding: 'utf8',
      });

    it('emits PostToolUse additionalContext for a broken edit, and nothing for a clean one', () => {
      const dir = sandbox();
      try {
        writeFileSync(join(dir, 'pkg/broken.ts'), OUTAGE_SHAPE);
        writeFileSync(join(dir, 'pkg/clean.ts'), 'export const a = 1;\n');

        const broken = run({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'pkg/broken.ts') } }, dir);
        const parsed = JSON.parse(broken);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toMatch(/does NOT PARSE/);

        expect(run({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'pkg/clean.ts') } }, dir).trim()).toBe('');
        // A non-edit tool must never be inspected.
        expect(run({ tool_name: 'Read', tool_input: { file_path: join(dir, 'pkg/broken.ts') } }, dir).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays silent for a TypeScript file outside the active repository', () => {
      const activeRepo = sandbox();
      const foreignRepo = sandbox();
      try {
        const foreignFile = join(foreignRepo, 'pkg/foreign.ts');
        writeFileSync(foreignFile, 'const api = import.meta.env.VITE_API_URL; export default api;\n');
        expect(
          run({ tool_name: 'Edit', tool_input: { file_path: foreignFile } }, activeRepo).trim(),
        ).toBe('');
      } finally {
        rmSync(activeRepo, { recursive: true, force: true });
        rmSync(foreignRepo, { recursive: true, force: true });
      }
    });

    it('stays silent (never throws) on malformed stdin and a missing file', () => {
      expect(() => execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8' })).not.toThrow();
      expect(run({ tool_name: 'Edit', tool_input: { file_path: '/nonexistent/x.ts' } }).trim()).toBe('');
      expect(run({ tool_name: 'Edit', tool_input: {} }).trim()).toBe('');
    });
  });
});
