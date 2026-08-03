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
  findParseError: (ts: unknown, fileName: string, text: string) => Hit | null;
  isCandidateFile: (f: string) => boolean;
  nudgeFor: (f: string, deps?: Record<string, unknown>) => Promise<string | null>;
  formatNudge: (rel: string, hit: Hit) => string;
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

  describe('end-to-end through the real hook binary', () => {
    function sandbox() {
      const dir = mkdtempSync(join(tmpdir(), 'tsparse-hook-'));
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      mkdirSync(join(dir, 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"sandbox"}\n');
      symlinkSync(resolve(ROOT, 'node_modules/typescript'), join(dir, 'node_modules/typescript'));
      return dir;
    }
    const run = (payload: unknown) =>
      execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });

    it('emits PostToolUse additionalContext for a broken edit, and nothing for a clean one', () => {
      const dir = sandbox();
      try {
        writeFileSync(join(dir, 'pkg/broken.ts'), OUTAGE_SHAPE);
        writeFileSync(join(dir, 'pkg/clean.ts'), 'export const a = 1;\n');

        const broken = run({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'pkg/broken.ts') } });
        const parsed = JSON.parse(broken);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toMatch(/does NOT PARSE/);

        expect(run({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'pkg/clean.ts') } }).trim()).toBe('');
        // A non-edit tool must never be inspected.
        expect(run({ tool_name: 'Read', tool_input: { file_path: join(dir, 'pkg/broken.ts') } }).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays silent (never throws) on malformed stdin and a missing file', () => {
      expect(() => execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8' })).not.toThrow();
      expect(run({ tool_name: 'Edit', tool_input: { file_path: '/nonexistent/x.ts' } }).trim()).toBe('');
      expect(run({ tool_name: 'Edit', tool_input: {} }).trim()).toBe('');
    });
  });
});
