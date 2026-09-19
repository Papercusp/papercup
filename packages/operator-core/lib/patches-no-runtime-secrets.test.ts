/**
 * EI-22165824068092618 fallout guard — a patch file must never carry runtime state.
 *
 * `npx patch-package <pkg>` diffs the WHOLE installed package directory against a
 * clean copy, and verdict-cli writes its per-session daemon state — port, pid and a
 * live BEARER TOKEN — into `node_modules/verdict-cli/.verdict-data/sessions/<sid>/`.
 * Regenerating that patch without an exclude therefore sweeps every OTHER agent's
 * live daemon credentials into `patches/verdict-cli+0.1.1.patch`, which is tracked
 * and which git-sync commits within minutes.
 *
 * This was caught in the working tree once and never reached a commit (verified:
 * every committed revision of the patch carries zero token/session hunks).
 *
 * REGENERATE VIA THE SCRIPT, NOT A HAND-TYPED FLAG:
 *   npm run patch:regen -- verdict-cli
 *
 * EI-22171603060331947: the flag form this comment used to recommend
 * (`--exclude '(^|/)\.verdict-data/'`) is subtly WRONG on its own. patch-package
 * builds its filter as `makeRegExp(argv.exclude, "exclude", /^package\.json$/)`
 * (node_modules/patch-package/dist/index.js) — a supplied `--exclude` REPLACES
 * the default rather than adding to it, so that command silently starts sweeping
 * each package's `package.json` into the patch. `patch:regen` carries both
 * alternatives in one regex, which is the whole reason to have a script: the
 * safe invocation is the one you can actually remember to type.
 *
 * This test is the DETECTOR, and a detector alone was not enough here: git-sync
 * commits the tree on a ~3-minute timer while this only fails at the next test
 * run, so a swept token would already be pushed by the time it went red. The
 * script is the PREVENTION.
 *
 * The guard is deliberately about SHAPE, not about one package: any patch that
 * starts carrying tokens or per-session runtime directories fails here.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const patchesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'patches');
const { parsePatchFile } = createRequire(import.meta.url)('patch-package/dist/patch/parse.js');

/** Secret/runtime shapes that have no business in a dependency patch. */
const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'a bearer/daemon token value', pattern: /"token"\s*:\s*"[^"]{8,}"/ },
  { label: 'a per-session runtime data directory', pattern: /\.verdict-data\// },
  { label: 'a captured daemon pid+port state blob', pattern: /"pid"\s*:\s*\d+\s*,\s*"started"\s*:/ },
];

describe('dependency patches carry no runtime state (EI-22165824068092618)', () => {
  it('has patch files to check', async () => {
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch'));
    // A positive control: if this ever reads zero files the assertions below
    // would all pass vacuously, which is the exact false-green shape this
    // whole guard exists to prevent.
    expect(entries.length).toBeGreaterThan(0);
  });

  it('contains no tokens, pids or per-session data directories', async () => {
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch'));
    const offenders: string[] = [];

    for (const entry of entries) {
      const body = await readFile(join(patchesDir, entry), 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(body)) offenders.push(`${entry}: ${label}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a planted secret, so the check above cannot pass by being broken', () => {
    // Calibration. Built from fragments so the literal never sits in a tracked
    // file as a scannable secret (the tree secrets-guard and the pot-git publish
    // guard both match on assembled token shapes).
    const planted = `+  {"port":1234,"${'token'}":"${'8d283a06'}-ab1c-4034-bba2-4cbd0c98be16"}`;
    const caught = FORBIDDEN.some(({ pattern }) => pattern.test(planted));
    expect(caught).toBe(true);
  });
});

describe('committed dependency patches parse with the installer', () => {
  it('accepts every committed patch without a hunk integrity error', async () => {
    const entries = (await readdir(patchesDir)).filter((entry) => entry.endsWith('.patch'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const body = await readFile(join(patchesDir, entry), 'utf8');
      expect(() => parsePatchFile(body), entry).not.toThrow();
      expect(parsePatchFile(body).length, entry).toBeGreaterThan(0);
    }
  });

  it('rejects an extra blank hunk line that its declared lengths do not cover', () => {
    // patch-package treats this extra empty line as context. The old tsx patch
    // therefore failed even though its one deletion and one insertion looked valid.
    const valid = [
      'diff --git a/node_modules/example/index.js b/node_modules/example/index.js',
      '--- a/node_modules/example/index.js',
      '+++ b/node_modules/example/index.js',
      '@@ -1,1 +1,1 @@',
      '-before',
      '+after',
      '',
    ].join('\n');
    expect(parsePatchFile(valid)).toHaveLength(1);
    expect(() => parsePatchFile(`${valid}\n`)).toThrow('hunk header integrity check failed');
  });
});
