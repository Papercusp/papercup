/**
 * posttooluse-cli-entry-nudge — the recurrence guard for the hand-rolled ESM
 * CLI-entry CLASS (EI-22085994981415983; 3rd occurrence in 3 days after
 * WI-1398269 on 08-30 and EI-21985446777087608 on 08-31).
 *
 * Mirrors posttooluse-mjs-import-declaration-nudge.test.ts's shape: the point of
 * this file is not "the hook is well-formed" but that it agrees with the REAL
 * `findGuards` / `ALLOW_COUNTS` / `STANDALONE_ENTRY_EXEMPTIONS` from
 * scripts/check-no-hand-rolled-cli-entry.mjs, exercised on the actual idioms
 * that reddened the gate — not a stand-in. The hook's own `--self-test` drives a
 * marker-based fake detector (OFFEND_A / OFFEND_B), which proves the hook's
 * plumbing but says nothing about whether it agrees with the gate on real
 * syntax. That agreement is the whole reason the hook reuses the detector, so it
 * is what this file measures.
 *
 * WHY REAL REPO PATHS RATHER THAN A TEMP TREE
 *   The hook resolves the repo root by walking up for the detector, and keys its
 *   allowance lookups on the repo-relative path. Using REAL paths with INJECTED
 *   content therefore exercises the real root-resolution and the real
 *   path-keyed allowance table, while writing nothing to the shared tree — the
 *   in-tree mutation this repo forbids (git-sync would commit it). Only the two
 *   boundaries that cannot be truthful here are injected: `readFile` (the
 *   hypothetical edit) and `showHead` (its "before").
 *
 * ⚠ This file is a `.test.ts`, which the detector's own walk() excludes, so the
 *   idiom strings below can never become findings of the tree-wide gate. The
 *   masker would strip them anyway (they are string literals), but the
 *   exclusion is what makes that belt-and-braces rather than load-bearing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-cli-entry-nudge.mjs');

type NudgeFor = (
  filePath: string,
  deps?: {
    readFile?: (p: string) => string;
    showHead?: (root: string, rel: string) => string | null;
    loadDetector?: (root: string) => Promise<unknown>;
  },
) => Promise<string | null>;

async function hook(): Promise<{ nudgeFor: NudgeFor; isScannedPath: (p: string) => boolean }> {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: NudgeFor;
    isScannedPath: (p: string) => boolean;
  };
}

/** A real, scanned path whose identity the allowance table has no entry for. */
const SCANNED = resolve(ROOT, 'scripts/check-no-deployed-liveness-read.mjs');

/** The three spellings the gate rejects, exactly as they appeared in the field. */
const IDIOMS: ReadonlyArray<readonly [string, string]> = [
  [
    'path-to-file-url',
    'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
  ],
  ['file-template', 'if (import.meta.url === `file://${process.argv[1]}`) main();'],
  [
    'file-url-to-path',
    'const direct = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));',
  ],
];

/** The sanctioned repair — must be silent. */
const FIXED = [
  "import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';",
  'if (isCliEntry(import.meta.url)) main();',
].join('\n');

describe('posttooluse-cli-entry-nudge', () => {
  it('fires on every spelling the real detector rejects', async () => {
    const { nudgeFor } = await hook();
    for (const [kind, idiom] of IDIOMS) {
      const msg = await nudgeFor(SCANNED, {
        readFile: () => `${idiom}\n`,
        showHead: () => FIXED,
      });
      expect(msg, `expected a nudge for ${kind}`).toBeTruthy();
      expect(msg).toContain(kind);
      expect(msg).toContain('scripts/check-no-deployed-liveness-read.mjs');
    }
  });

  it('is silent on the sanctioned isCliEntry repair', async () => {
    const { nudgeFor } = await hook();
    const msg = await nudgeFor(SCANNED, {
      readFile: () => FIXED,
      showHead: () => `${IDIOMS[0][1]}\n`,
    });
    expect(msg).toBeNull();
  });

  it('names the fix and forbids growing ALLOW_COUNTS', async () => {
    const { nudgeFor } = await hook();
    const msg = await nudgeFor(SCANNED, {
      readFile: () => `${IDIOMS[0][1]}\n`,
      showHead: () => '',
    });
    expect(msg).toContain('isCliEntry(import.meta.url)');
    expect(msg).toContain('Do NOT add this to ALLOW_COUNTS');
    // The confirm command must be the gate's own entrypoint, not a paraphrase.
    expect(msg).toContain('node scripts/check-no-hand-rolled-cli-entry.mjs');
  });

  it('short-circuits a file with no import.meta.url without consulting git', async () => {
    const { nudgeFor } = await hook();
    const msg = await nudgeFor(SCANNED, {
      readFile: () => 'export const x = 1;\n',
      showHead: () => {
        throw new Error('showHead must not be called');
      },
    });
    expect(msg).toBeNull();
  });

  it('stays silent when the edit introduces nothing new', async () => {
    const { nudgeFor } = await hook();
    const unchanged = `${IDIOMS[0][1]}\n`;
    expect(await nudgeFor(SCANNED, { readFile: () => unchanged, showHead: () => unchanged })).toBeNull();
    // A pre-existing occurrence plus an unrelated line is still not an introduction.
    expect(
      await nudgeFor(SCANNED, {
        readFile: () => `${unchanged}// unrelated tweak\n`,
        showHead: () => unchanged,
      }),
    ).toBeNull();
  });

  it('respects the REAL shrink-only baseline for a file that carries one', async () => {
    const { nudgeFor } = await hook();
    // scripts/lint-tsc.mjs is measured at path-to-file-url -> 1 in ALLOW_COUNTS.
    const baselined = resolve(ROOT, 'scripts/lint-tsc.mjs');
    const one = `${IDIOMS[0][1]}\n`;
    expect(await nudgeFor(baselined, { readFile: () => one, showHead: () => '' })).toBeNull();
    // ...but exceeding the measured count is exactly what the gate fails on.
    const two = `${IDIOMS[0][1]}\n${IDIOMS[0][1]}\n`;
    expect(await nudgeFor(baselined, { readFile: () => two, showHead: () => one })).toBeTruthy();
  });

  it('never fires for a path the gate does not scan', async () => {
    const { isScannedPath } = await hook();
    expect(isScannedPath('scripts/foo.mjs')).toBe(true);
    expect(isScannedPath('apps/operator/scripts/lint-tests.ts')).toBe(true);
    // Outside SOURCE_ROOTS, excluded extensions, tests, and skipped dirs.
    expect(isScannedPath('papercusp-desktop/bin/x.mjs')).toBe(false);
    expect(isScannedPath('scripts/foo.test.mjs')).toBe(false);
    expect(isScannedPath('packages/operator-core/lib/x.d.ts')).toBe(false);
    expect(isScannedPath('scripts/node_modules/p/x.mjs')).toBe(false);
    expect(isScannedPath('apps/_retired/x.mjs')).toBe(false);
  });

  it('fails open when the detector cannot be loaded', async () => {
    const { nudgeFor } = await hook();
    const msg = await nudgeFor(SCANNED, {
      readFile: () => `${IDIOMS[0][1]}\n`,
      showHead: () => '',
      loadDetector: async () => null,
    });
    expect(msg).toBeNull();
  });

  it('passes its own --self-test', () => {
    const out = execFileSync(process.execPath, [HOOK, '--self-test'], { encoding: 'utf-8' });
    expect(out).toContain('all cases passed');
  });

  it('does not itself contain a hand-rolled guard the gate would reject', async () => {
    // The hook is a scanned .mjs under apps/, so it must satisfy the very rule it
    // advertises. Ask the REAL detector about the hook's own source.
    const detector = (await import(
      `file://${resolve(ROOT, 'scripts/check-no-hand-rolled-cli-entry.mjs')}`
    )) as { findGuards: (src: string, name: string) => unknown[] };
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(HOOK, 'utf-8');
    expect(detector.findGuards(src, 'posttooluse-cli-entry-nudge.mjs')).toEqual([]);
  });
});
