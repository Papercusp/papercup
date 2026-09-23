/**
 * P-012 (review-system-rework-reduction-2026-09-23): the Claude statusline no longer issues its
 * own coord:glance RPC while the PostToolUse activity hook's bundle glance is fresh — it prints
 * that cached glance's server-rendered `display` block instead. Two contracts make the reuse
 * correct, and each lives in a different language, so neither a typecheck nor the statusline's
 * own fixture tests can see a drift:
 *
 *  1. The bundle's glance leg must render `display` from the SAME activity window the statusline
 *     asked for (`ACTIVITY_WINDOW`). `renderStatusDisplay` derives the peer chip from those rows
 *     before `display_only` blanks them, so a smaller window silently turns the reused line "solo".
 *  2. All three readers/writers of the bundle cursor must name the file the same way, or the
 *     statusline silently falls back to one RPC per render (the volume this item removed).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_BUNDLE_GLANCE_ACTIVITY_LIMIT } from './hook-bundle';

const HOOKS = join(__dirname, '..', '..', '..', '..', '..', 'apps', 'operator', 'scripts', 'hooks', 'cc');
const read = (name: string) => readFileSync(join(HOOKS, name), 'utf8');

function statuslineActivityWindow(src: string): number | null {
  const m = /^ACTIVITY_WINDOW\s*=\s*(\d+)\b/m.exec(src);
  return m ? Number(m[1]) : null;
}

/** The bundle filename template each hook builds, normalised to `<prefix>{owner}.json`. */
function bundleFileTemplates(src: string): string[] {
  return [...src.matchAll(/f'(activity-hook-bundle-)\{[a-z_]+\}(\.json)'/g)].map((m) => `${m[1]}{owner}${m[2]}`);
}

/** The owner-normalisation regex + length cap applied before the filename is built. */
function ownerNormalisations(src: string): string[] {
  return [...src.matchAll(/re\.sub\(r'(\[\^A-Za-z0-9\._-\])', '_', [a-z_]+\)\[:(\d+)\]/g)].map((m) => `${m[1]}:${m[2]}`);
}

describe('hook-bundle glance ↔ Claude statusline parity (P-012)', () => {
  const statusline = read('statusline-fleet.sh');
  const writer = read('posttooluse-activity-report.sh');
  const titleReader = read('posttooluse-objective-title.sh');

  it('positive control: the extractors find the statusline window and every bundle filename', () => {
    expect(statuslineActivityWindow(statusline)).toBeGreaterThan(0);
    for (const src of [statusline, writer, titleReader]) {
      expect(bundleFileTemplates(src)).toContain('activity-hook-bundle-{owner}.json');
    }
    // Calibration: a window the extractor must reject, and a mismatched template it must not equate.
    expect(statuslineActivityWindow('ACTIVITY_WINDOW_X = 3')).toBeNull();
    expect(bundleFileTemplates("f'activity-hook-bundles-{owner}.json'")).toEqual([]);
  });

  it('the bundle glance renders display from the statusline activity window', () => {
    expect(HOOK_BUNDLE_GLANCE_ACTIVITY_LIMIT).toBe(statuslineActivityWindow(statusline));
  });

  it('the pre-fix bundle window (0) would be caught', () => {
    expect(0).not.toBe(statuslineActivityWindow(statusline));
  });

  it('writer and both readers normalise the owner key identically', () => {
    const writerNorm = ownerNormalisations(writer);
    expect(writerNorm).toContain('[^A-Za-z0-9._-]:120');
    expect(ownerNormalisations(statusline)).toContain('[^A-Za-z0-9._-]:120');
    expect(ownerNormalisations(titleReader)).toContain('[^A-Za-z0-9._-]:120');
  });
});
