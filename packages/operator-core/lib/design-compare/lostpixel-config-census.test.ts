/**
 * A build-time pin on the Lost Pixel configuration census.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-004).
 *
 * D-010, D-014 and D-015 all rest on claims about how Lost Pixel is configured
 * in this repo — that no config selects `compareEngine`, that none defines
 * `configureBrowser`, that every one points at a relative `storybook-static`.
 * Those claims are binding on P-006 and P-008, and they describe code, so under
 * the repo's derived-truth rule they must be derived, pinned or attested rather
 * than hand-maintained in prose. This file is the pin.
 *
 * It exists because the census was WRONG ONCE, in this plan, in a recorded
 * decision. D-014 was written asserting three config files after grepping the
 * three paths a prior note happened to name; there are five, and the fourth
 * surfaced only because CI referenced it. D-015 carries that correction. A
 * decision that names a population is exactly the kind of claim that rots
 * silently, so the population is measured here instead of remembered.
 *
 * What this pin is NOT: a test of Lost Pixel. It asserts nothing about whether
 * visual regression passes. It asserts that the FACTS the plan's decisions rest
 * on are still facts — so a sixth workspace, or a config that starts selecting
 * an engine, fails the build next to the decisions it invalidates rather than
 * quietly making them false.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  // Green-candidate checkouts of this same tree. Counting them would inflate
  // the census with copies of files already counted.
  '.papercusp',
  '.git',
  'dist',
  'build',
  'storybook-static',
  'coverage',
]);

const CONFIG_NAMES = new Set([
  'lostpixel.config.ts',
  'lostpixel.config.js',
  'lostpixel.config.cjs',
  'lostpixel.config.mjs',
]);

/**
 * Every canonical Lost Pixel config, found by walking rather than by glob.
 *
 * Deliberately no glob library: operator-core does not declare one, and
 * reaching through a transitive copy is the same borrowing this plan refused
 * for the browser driver. One filename does not justify a dependency.
 */
function findConfigs(directory = REPO_ROOT, relative = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...findConfigs(path.join(directory, entry.name), path.join(relative, entry.name)));
    } else if (CONFIG_NAMES.has(entry.name)) {
      found.push(path.join(relative, entry.name));
    }
  }
  return found.sort();
}

describe('Lost Pixel configuration census (pins D-010, D-014, D-015)', () => {
  it('finds the five configured workspaces the decisions name', () => {
    // If this list changes, the decisions that cite it must be re-read before
    // the list here is updated — the point is to force that read, not to
    // rubber-stamp whatever is currently on disk.
    expect(findConfigs()).toEqual([
      'apps/operator/lostpixel.config.ts',
      'libs/agent-chat/lostpixel.config.ts',
      'libs/generic/papergrid/grid-core/lostpixel.config.ts',
      'libs/generic/ui-primitives/lostpixel.config.ts',
      'libs/marketplace-public-ui/lostpixel.config.ts',
    ]);
  });

  it('finds at least one config, so a broken glob cannot pass vacuously', () => {
    // Without this, a glob that silently matched nothing would satisfy every
    // "none of them does X" assertion below.
    expect(findConfigs().length).toBeGreaterThan(0);
  });

  describe.each(findConfigs())('%s', (relativePath) => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

    it('does not select a comparison engine (D-010 consequence 1)', () => {
      // D-010: lost-pixel's dispatcher falls through to odiff unless a loaded
      // config sets `compareEngine`. The P-005 adapter therefore bypasses the
      // dispatcher entirely and calls pixelmatch directly. If a config starts
      // setting this, that reasoning needs re-reading.
      expect(source).not.toMatch(/compareEngine/);
    });

    it('does not define configureBrowser (D-014 disqualifier 2)', () => {
      // This hook is the ONLY route to a device scale factor, colour scheme or
      // any other browser-context setting in lost-pixel's shot pipeline. Its
      // absence everywhere is why that pipeline cannot carry a contracted
      // capture environment.
      expect(source).not.toMatch(/configureBrowser/);
    });

    it('points storybookShots at a relative storybook-static path (D-015)', () => {
      // A relative path becomes a `file://` URL, under which Storybook 10.3.6's
      // preview never boots and lost-pixel's collector times out after 30s with
      // no cause attached. Recorded so P-008 serves over HTTP instead.
      expect(source).toMatch(/storybookUrl:\s*'\.\/storybook-static'/);
    });
  });
});
