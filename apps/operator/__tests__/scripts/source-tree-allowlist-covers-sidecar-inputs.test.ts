/**
 * The public source cut (scripts/source-preview.mjs) ships exactly the top-level
 * entries in SOURCE_TREE_ALLOWLIST (papercusp-desktop/bin/lib/source-tree-selection.sh).
 * The installer build (papercusp-desktop/bin/build-desktop-sidecar.sh) reads
 * top-level inputs as "$REPO_ROOT/<top>". Any such input missing from the
 * allowlist makes a fresh public clone unable to build its own installer:
 * measured 2026-09-30 on Papercusp/papercusp-app@b9851864, where
 * build-linux-local.sh died with "first-party goal-packages dir not found"
 * (plan open-source-release-2026-09-29, R-15).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SELECTION_LIB = join(REPO_ROOT, 'papercusp-desktop/bin/lib/source-tree-selection.sh');
const SIDECAR_BUILD = join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh');

/** Produced by `npm ci` on the fresh clone, never shipped in the cut. */
const INSTALL_PRODUCED = new Set(['node_modules']);

function allowlist(): Set<string> {
  const out = execFileSync('bash', ['-c', '. "$1"; printf "%s\\n" $SOURCE_TREE_ALLOWLIST', '_', SELECTION_LIB], {
    encoding: 'utf8',
  });
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

export function repoRootTops(script: string): string[] {
  const tops = new Set<string>();
  for (const m of script.matchAll(/\$\{?REPO_ROOT\}?\/([A-Za-z0-9_.-]+)/g)) tops.add(m[1]);
  return [...tops].sort();
}

describe('SOURCE_TREE_ALLOWLIST covers every top-level input of the installer build', () => {
  it('extracts $REPO_ROOT/<top> references (calibration)', () => {
    expect(repoRootTops('a "$REPO_ROOT/goal-packages" b ${REPO_ROOT}/rubrics/x')).toEqual(['goal-packages', 'rubrics']);
  });

  it('a deliberately-short allowlist is caught (control)', () => {
    const tops = repoRootTops(readFileSync(SIDECAR_BUILD, 'utf8'));
    const shortList = new Set([...allowlist()].filter((t) => t !== 'goal-packages'));
    expect(tops.filter((t) => !shortList.has(t) && !INSTALL_PRODUCED.has(t))).toContain('goal-packages');
  });

  it('ships every top-level path build-desktop-sidecar.sh reads', () => {
    const allow = allowlist();
    const tops = repoRootTops(readFileSync(SIDECAR_BUILD, 'utf8'));
    expect(tops.length).toBeGreaterThan(3);
    expect(tops.filter((t) => !allow.has(t) && !INSTALL_PRODUCED.has(t))).toEqual([]);
  });
});
