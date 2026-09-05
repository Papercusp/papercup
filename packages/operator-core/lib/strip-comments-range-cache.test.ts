/**
 * The content-addressed range cache inside `scripts/lib/strip-comments-and-strings.mjs`
 * (EI-20068047132832988).
 *
 * WHY THIS FILE EXISTS. That module is the ONE stripper behind ~48 guard scripts, several of
 * them REPO_WIDE_INVARIANT_GUARDS that run on essentially every `test:affected` and every gate
 * tick. Measured 2026-09-05 over 17,655 files / 387.5 MB: `readFileSync` 1.29s, sha256 0.72s,
 * the parse 82.4s. The cache trades the 82s for the 0.72s on unchanged input — which is a very
 * good trade right up until a stale or corrupt entry masks the wrong bytes, and a guard that
 * reports clean on an offending line is the worst failure this class has.
 *
 * So the cases below are not "does the cache work" — they are the four ways it could be WRONG
 * while still looking green:
 *   1. a warm hit that differs from the uncached answer at all,
 *   2. an entry written under a DIFFERENT implementation being read back by this one,
 *   3. a truncated / garbage entry being decoded as ranges instead of re-parsed,
 *   4. two inputs that share a hash bucket but not a ScriptKind or flag set.
 *
 * Every case runs TWO module instances in ONE process (distinct import query strings; ESM keys
 * by resolved URL) so the uncached and cached answers are computed from the IDENTICAL string.
 * The module's own docstring warns that the obvious two-run A/B gives a confident WRONG answer
 * on this swept shared tree, because ~40 agents commit during the gap.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The subject, overridable by path. That override is what makes `scripts/mutation-probe.sh`
 * usable here at TIER 2 (mutate a COPY outside the tree): without it the only way to prove
 * these assertions can fail would be to mutate the real shared module in place, which on this
 * swept checkout can be committed by git-sync mid-probe even when nothing goes wrong.
 */
const MODULE_PATH =
  process.env.STRIP_MODULE_UNDER_TEST ||
  path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../scripts/lib/strip-comments-and-strings.mjs',
  );

type Stripper = {
  stripCommentsOnly: (text: string, fileName?: string) => string;
  stripCommentsAndStrings: (text: string, fileName?: string) => string;
};

let tmpRoot: string;
let instance = 0;

/**
 * A FRESH module instance whose cache is pointed at `dir` (or disabled when `dir` is null).
 * The module reads the env lazily and memoises the result, so the env must be set BEFORE the
 * instance's first strip call — which is why each instance is forced to initialise here.
 */
async function loadStripper(dir: string | null): Promise<Stripper> {
  const prevDir = process.env.PAPERCUSP_STRIP_CACHE_DIR;
  const prevOff = process.env.PAPERCUSP_STRIP_CACHE;
  if (dir === null) {
    process.env.PAPERCUSP_STRIP_CACHE = '0';
    delete process.env.PAPERCUSP_STRIP_CACHE_DIR;
  } else {
    delete process.env.PAPERCUSP_STRIP_CACHE;
    process.env.PAPERCUSP_STRIP_CACHE_DIR = dir;
  }
  instance += 1;
  const mod = (await import(`${MODULE_PATH}?cachetest=${instance}`)) as Stripper;
  mod.stripCommentsOnly('const forceLazyInit = 1;', 'init.ts'); // pins the env choice
  if (prevDir === undefined) delete process.env.PAPERCUSP_STRIP_CACHE_DIR;
  else process.env.PAPERCUSP_STRIP_CACHE_DIR = prevDir;
  if (prevOff === undefined) delete process.env.PAPERCUSP_STRIP_CACHE;
  else process.env.PAPERCUSP_STRIP_CACHE = prevOff;
  return mod;
}

/** Every entry file the cache has written under `dir`, newest-agnostic. */
function cacheEntries(dir: string): string[] {
  const out: string[] = [];
  for (const salt of fs.readdirSync(dir)) {
    const saltDir = path.join(dir, salt);
    if (!fs.statSync(saltDir).isDirectory()) continue;
    for (const shard of fs.readdirSync(saltDir)) {
      const shardDir = path.join(saltDir, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const name of fs.readdirSync(shardDir))
        out.push(path.join(shardDir, name));
    }
  }
  return out;
}

/**
 * Sources chosen for the constructs that make this module's history: a regex literal holding a
 * quote (the false-POSITIVE defect), a `//` inside a string (the false-NEGATIVE one), a block
 * comment whose deletion would shift line numbers, JSX text that is neither comment nor literal,
 * and a template literal with a live `${...}` expression.
 */
const CASES: Array<{ file: string; src: string }> = [
  {
    file: 'regex-and-string.ts',
    src: [
      "const quoteInRegex = /['\"]/;",
      '// a comment naming setInterval( which must be blanked',
      'console.warn("see https://example.com/x", tag);',
      'const live = setInterval(fn, 10);',
    ].join('\n'),
  },
  {
    file: 'block-comment.ts',
    src: ['/* line one', '   line two */', 'const after = 1;'].join('\n'),
  },
  {
    file: 'jsx-text.tsx',
    src: [
      'export const V = () => (',
      '  <p>see https://example.com/y</p>',
      ');',
      '{/* a jsx comment naming kettle */}',
    ].join('\n'),
  },
  {
    file: 'template.ts',
    src: 'const t = `head ${ compute(1) } tail`; // trailing',
  },
  { file: 'empty.ts', src: '' },
  { file: 'no-comments.ts', src: 'const plain = 1;\n' },
];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-range-cache-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('strip-comments-and-strings range cache', () => {
  it('returns byte-identical output cold, warm, and uncached — for both variants', async () => {
    const uncached = await loadStripper(null);
    const cached = await loadStripper(tmpRoot);

    for (const variant of [
      'stripCommentsOnly',
      'stripCommentsAndStrings',
    ] as const) {
      for (const { file, src } of CASES) {
        const base = uncached[variant](src, file);
        const cold = cached[variant](src, file); // miss: parses, then writes
        const warm = cached[variant](src, file); // hit: decodes the entry
        expect(cold, `${variant} cold ${file}`).toBe(base);
        expect(warm, `${variant} warm ${file}`).toBe(base);
        // The contract the whole module rests on: blanking never changes length.
        expect(warm.length).toBe(src.length);
      }
    }
    expect(cacheEntries(tmpRoot).length).toBeGreaterThan(0);
  });

  it('never reads an entry written by a DIFFERENT implementation', async () => {
    // The salt is sha256 of the module's own bytes, and it is the DIRECTORY name. Simulating a
    // prior implementation is therefore exactly: an entry under some other salt directory.
    const cached = await loadStripper(tmpRoot);
    const src = CASES[0]!.src;
    const expected = cached.stripCommentsOnly(src, CASES[0]!.file);

    const salts = fs.readdirSync(tmpRoot);
    expect(salts).toHaveLength(1);
    const stale = path.join(tmpRoot, 'deadbeefdeadbeef');
    fs.cpSync(path.join(tmpRoot, salts[0]!), stale, { recursive: true });
    // Poison every entry in the stale tree with ranges that would blank the whole file.
    for (const entry of fs
      .readdirSync(stale)
      .flatMap((shard) =>
        fs.statSync(path.join(stale, shard)).isDirectory()
          ? fs
              .readdirSync(path.join(stale, shard))
              .map((n) => path.join(stale, shard, n))
          : [],
      )) {
      const buf = Buffer.alloc(8);
      buf.writeInt32LE(0, 0);
      buf.writeInt32LE(src.length, 4);
      fs.writeFileSync(entry, buf);
    }

    const fresh = await loadStripper(tmpRoot);
    expect(fresh.stripCommentsOnly(src, CASES[0]!.file)).toBe(expected);
  });

  it('re-parses instead of trusting a truncated or garbage entry', async () => {
    const uncached = await loadStripper(null);
    const cached = await loadStripper(tmpRoot);
    const { file, src } = CASES[0]!;
    const expected = uncached.stripCommentsOnly(src, file);
    expect(cached.stripCommentsOnly(src, file)).toBe(expected);

    for (const corruption of [
      Buffer.alloc(0), // empty: decodes to zero ranges, which would leave comments UNMASKED
      Buffer.from([1, 2, 3]), // not a multiple of 8: a torn write
    ]) {
      for (const entry of cacheEntries(tmpRoot))
        fs.writeFileSync(entry, corruption);
      const retry = await loadStripper(tmpRoot);
      expect(retry.stripCommentsOnly(src, file), 'corrupt entry').toBe(expected);
    }
  });

  it('keys on ScriptKind and on the strings/regex flags, not on content alone', async () => {
    const uncached = await loadStripper(null);
    const cached = await loadStripper(tmpRoot);
    // `<T>(x)` parses as a type assertion in .ts and as JSX in .tsx — same bytes, different
    // ranges. A cache keyed on content alone would serve the first answer for both.
    const src = 'const f = <T>(x: T) => x; /* c */ const s = "a";';
    for (const name of ['kind.ts', 'kind.tsx']) {
      expect(cached.stripCommentsOnly(src, name), `only ${name}`).toBe(
        uncached.stripCommentsOnly(src, name),
      );
      expect(cached.stripCommentsAndStrings(src, name), `both ${name}`).toBe(
        uncached.stripCommentsAndStrings(src, name),
      );
    }
    // Same file, both variants: the strings/regex flags must not collide.
    expect(cached.stripCommentsOnly(src, 'kind.ts')).not.toBe(
      cached.stripCommentsAndStrings(src, 'kind.ts'),
    );
  });

  /**
   * The reclaim policy, which is the one part of this cache that can degrade SILENTLY.
   *
   * `papercusp-release` runs green `main` while the shared checkout is on `staging`, so two
   * different byte-versions of the stripper — two different salts — run side by side for as
   * long as any change to it is in flight. A "new salt wipes every sibling" policy makes those
   * two thrash: each side's next process re-creates its own tree and deletes the other's, both
   * run permanently cold, and NOTHING goes red because a miss only ever costs a parse. The
   * cache would simply stop working while every test stayed green. Hence: reclaim on IDLENESS.
   */
  it('reclaims an IDLE sibling salt tree but leaves a live one alone', async () => {
    const live = path.join(tmpRoot, 'aaaaaaaaaaaaaaaa');
    const idle = path.join(tmpRoot, 'bbbbbbbbbbbbbbbb');
    for (const dir of [live, idle]) {
      fs.mkdirSync(path.join(dir, 'ab'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ab', 'entry.bin'), Buffer.alloc(8));
      fs.writeFileSync(path.join(dir, '.last-used'), '');
    }
    // Backdate ONLY the idle tree's marker past the 7-day reclaim threshold.
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(path.join(idle, '.last-used'), eightDaysAgo, eightDaysAgo);

    // A first init in this root is `fresh`, which is what triggers the reclaim sweep.
    await loadStripper(tmpRoot);

    expect(fs.existsSync(live), 'live sibling must survive').toBe(true);
    expect(fs.existsSync(path.join(live, 'ab', 'entry.bin'))).toBe(true);
    expect(fs.existsSync(idle), 'idle sibling must be reclaimed').toBe(false);
  });

  it('stamps its own salt tree as in use on every init', async () => {
    await loadStripper(tmpRoot);
    const salts = fs.readdirSync(tmpRoot);
    expect(salts).toHaveLength(1);
    const marker = path.join(tmpRoot, salts[0]!, '.last-used');
    expect(fs.existsSync(marker), 'no marker means this tree looks idle to peers').toBe(
      true,
    );
    // Without a refresh on every init, a long-lived salt would be reclaimed by a peer while
    // still in daily use — the same silent-degradation shape as the thrash above.
    const before = fs.statSync(marker).mtimeMs;
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(marker, old, old);
    await loadStripper(tmpRoot);
    expect(fs.statSync(marker).mtimeMs).toBeGreaterThan(
      Math.min(before, old.getTime()),
    );
  });

  it('writes nothing when PAPERCUSP_STRIP_CACHE=0', async () => {
    const off = await loadStripper(null);
    for (const { file, src } of CASES) off.stripCommentsOnly(src, file);
    // The disabled instance never resolved a directory, so tmpRoot stays untouched.
    expect(fs.readdirSync(tmpRoot)).toHaveLength(0);
  });
});
