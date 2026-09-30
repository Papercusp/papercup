/**
 * Source-integrity lint — no raw NUL byte may appear in operator source.
 *
 * A NUL in a text source file is always corruption, never intent: no language
 * here needs one, and every tool that meets it degrades SILENTLY rather than
 * erroring. `git grep`/`grep` reclassify the file as binary and stop matching it
 * (so a later audit sweeps straight past the file), `git diff` renders "Binary
 * files differ" instead of a reviewable hunk, and the parser happily accepts the
 * byte inside a string literal — so the damage lands at RUNTIME, not build time.
 *
 * That is exactly how it bit: /adv/HUD's "all fleets" sentinel is the string
 * ' all' (a leading space — deliberately not a valid kebab slug). HudBoard.tsx
 * had its copy's leading space corrupted to a NUL, so HudView's
 * `slug === ALL_FLEETS` never matched and clicking "all fleets" pushed a junk
 * slug into the filter — emptying the board instead of clearing the filter. The
 * corruption was invisible in review (a NUL renders as nothing), invisible to
 * grep (binary), and invisible to tsc (a legal string character). Only a
 * byte-level check like this one sees it.
 *
 * The sentinel now has a single exported definition, which stops THAT drift; this
 * lint is the class guard, so the next silently-corrupted file fails a test
 * instead of shipping a dead code path.
 *
 * ── How to VERIFY absence — NOT with grep (EI-19393869052335703) ────────────
 * Checking by hand whether some ref is clean? Do NOT reach for
 * `git grep -lIP '\x00'`. `-I` skips files it classifies as binary, and a raw
 * NUL is precisely what makes a file binary — so the flag excludes exactly the
 * population that would match. It returns empty on a tree that provably
 * contains one, and empty reads as a confident "clean". Measured against
 * candidate 060ea000 (2 NUL bytes in contested-fold.ts): the `-I` form found
 * nothing, the same query without `-I` found the file. It fired fleet-wide
 * once — an agent verified a candidate that way, reported GREEN, and told five
 * agents to stand down and expect a green that could not happen.
 *
 * Sound instead: this test; `node scripts/check-no-nul-in-source.mjs`;
 * `git grep -lP '\x00' <ref>` (same query, no -I); or
 * `git show <ref>:<file> | tr -dc '\000' | wc -c`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * WHOLE TRACKED TREE, not a directory list (EI-18744004858454166).
 *
 * This lint was originally scoped to `apps/operator/app` + `apps/operator-vite/src`
 * — the two dirs the HUD bug lived in. That scope is exactly why it then MISSED
 * the next four instances: three in `packages/operator-core/lib/**` and one in
 * the very agent-insights doc that documents this class. A class guard whose
 * scope is the site of the last incident only ever catches the last incident.
 *
 * `git ls-files` is used rather than a directory walk because it is the same
 * definition of "our source" that review and CI use: it skips node_modules,
 * build output and untracked scratch for free, and it cannot silently drift out
 * of date the way a hand-maintained SOURCE_DIRS list did.
 */
const TEXT_FILE_RE = /\.(?:tsx?|jsx?|mjs|cjs|css|md|mdx|json|ya?ml|sql|sh|toml)$/;

/** A NUL is legitimate inside a deliberate binary/encoding fixture. */
const SKIP_RE = /(?:^|\/)(?:fixtures?|__fixtures__|snapshots?|__snapshots__)\//;

const NUL = String.fromCharCode(0);

/**
 * `--recurse-submodules` IS LOAD-BEARING, not a tidy-up (WI-6559 fallout).
 *
 * A plain `git ls-files` reports a submodule as a single GITLINK entry and never
 * descends into it, so every file under `libs/generic/*` — where the borrowable
 * libs live, `@papercusp/sync` among them — was invisible to this guard: 0 of
 * `libs/generic/sync/src/**` listed, and 19,964 paths tree-wide against 25,392
 * with recursion. That is ~5,400 files, 21% of the tree, silently unscanned.
 *
 * The skip was not even reachable as a failure: the gitlink path is a DIRECTORY,
 * so `readFileSync` throws and the loop's `catch { continue }` swallows it — the
 * guard reported green over a fifth of the repo.
 *
 * It bit exactly as the header predicts: `query-fetcher.ts` (the sync layer's
 * central fetcher) carried a raw NUL in its cache-key delimiter, which made the
 * WHOLE FILE binary to grep. Searching it for `sendOne` / `gate` / `timeout`
 * returned nothing — grep prints "binary file matches" on STDERR and no lines —
 * so an audit of the very code path under investigation swept straight past it
 * and read as "that code does not exist".
 */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--recurse-submodules'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split(NUL)
    .filter((p) => p && TEXT_FILE_RE.test(p) && !SKIP_RE.test(p))
    // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
    .filter((p) => existsSync(resolve(REPO_ROOT, p)));
}

describe('source integrity', () => {
  it('contains no raw NUL bytes in tracked text sources', () => {
    const offenders: string[] = [];

    for (const rel of trackedTextFiles()) {
      let text: string;
      try {
        text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // deleted-but-tracked, submodule gitlink, unreadable
      }
      if (!text.includes(NUL)) continue;
      const line = text.split('\n').findIndex((l) => l.includes(NUL)) + 1;
      offenders.push(`${rel}:${line}`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Raw NUL byte(s) found in text source:\n  ${offenders.join('\n  ')}\n\n` +
          'A NUL here is corruption, not intent — it makes the file "binary" to grep/diff ' +
          'and survives typecheck, so it breaks behaviour silently. Re-write the affected ' +
          'literal (a whitespace-ish sentinel belongs in ONE exported constant, imported ' +
          'everywhere else) rather than pasting the byte back.\n\n' +
          'If you MEANT a NUL — the common case is a composite Map key joined on a ' +
          'delimiter that cannot occur in the data — keep the intent but write the ESCAPE: ' +
          '`${a}\\x00${b}`, never the raw byte. They are byte-identical at runtime; only ' +
          'the escape leaves the file greppable.\n\n' +
          'NOTE: you cannot fix this with the Edit tool — the Read tool renders a NUL as a ' +
          'SPACE, so there is no exact text to match and the edit fails "not found". ' +
          'Repair mechanically: node scripts/check-no-nul-in-source.mjs --fix',
    ).toEqual([]);
  });
});
