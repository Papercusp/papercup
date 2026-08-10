/**
 * WI-37605 — the guard that keeps green-checkpoint narration from impersonating itself.
 *
 * The invariant, and why the pre-existing guard could not see the violation, are documented on
 * scripts/check-green-checkpoint-tag.mjs. The short version: the gate's own suites drive
 * production code paths, vitest captures their stdout verbatim into the persisted verdict log, so
 * a HARDCODED production tag emits a line indistinguishable from a real gate decision.
 *
 * ⚠ FALSIFIABILITY IS PROVED AGAINST A FIXTURE TREE IN os.tmpdir(), NEVER BY MUTATING THE SHARED
 * CHECKOUT. git-sync commits the whole working tree every few minutes, so a probe that mutates a
 * tracked file and restores it afterwards races the sweep — that is how `db6d7b02b1` committed an
 * inert mutant of verify-tauri-headless.sh. `findViolations` takes its root as a parameter
 * precisely so this test can point it somewhere harmless (tier 2 of the mutation-probe rule).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  findViolations,
  stripComments,
  productionTag,
  GC_TAG_SOURCE_ROOTS,
  ALLOWLIST,
} from '../../../scripts/check-green-checkpoint-tag.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TAG = productionTag();

/** Build a throwaway source tree OUTSIDE the repo and scan it. */
function scanFixture(files: Record<string, string>): ReturnType<typeof findViolations> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-tag-guard-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return findViolations(dir, ['src']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('WI-37605: no hardcoded green-checkpoint production tag in executable code', () => {
  // ---- the ratchet -----------------------------------------------------------------------
  it('the tree is currently clean', () => {
    const violations = findViolations(REPO_ROOT);
    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.text}`),
      'narrate via orchestratorStdoutTag(); a log() site must not add the prefix at all',
    ).toEqual([]);
  });

  // ---- CONTROLS: the detector must actually catch both measured routes --------------------
  // Without these the ratchet above is unfalsifiable — it would pass just as happily against a
  // detector that never matches anything.

  it('⭐ CONTROL — catches Route B: a direct console.* site with a hardcoded prefix', () => {
    const hits = scanFixture({
      'src/emitter.ts': ['export function f(e: string) {', `  console.warn(\`${TAG} boom: \${e}\`);`, '}'].join('\n'),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('src/emitter.ts');
    expect(hits[0].line).toBe(2);
  });

  it('⭐ CONTROL — catches Route A: a log() site that re-adds the prefix log() already prepends', () => {
    // This is the shape the constants-level guard could never see: the emitted line ends up
    // carrying the FIXTURE tag and the PRODUCTION tag at once, so it still answers a plain grep.
    // Measured 6 such lines in each of the 4 newest verdict logs before the fix.
    const hits = scanFixture({ 'src/orch.ts': `log(\`${TAG} quarantine read failed\`);` });
    expect(hits).toHaveLength(1);
  });

  it('CALIBRATION — properly-tagged narration is NOT flagged', () => {
    // Without this, the two controls above could be passing because the detector flags everything.
    const hits = scanFixture({
      'src/ok.ts': [
        'import { orchestratorStdoutTag } from "./tags";',
        'console.warn(`${orchestratorStdoutTag()} boom`);',
        'log(`quarantine read failed`);',
      ].join('\n'),
    });
    expect(hits).toEqual([]);
  });

  it('does not flag a doc-comment that QUOTES the tag, in either comment style', () => {
    const hits = scanFixture({
      'src/doc.ts': [
        `/** the habit every reader has — grepping ${TAG} — keeps working. */`,
        `// see ${TAG} above`,
        'export const x = 1;',
      ].join('\n'),
    });
    expect(hits).toEqual([]);
  });

  it('does not flag a test file, which may legitimately construct fixture lines', () => {
    expect(scanFixture({ 'src/a.test.ts': `const line = \`${TAG} candidate=deadbeef\`;` })).toEqual([]);
  });

  it('skips the ONE allowlisted file — the module that defines the tag', () => {
    expect([...ALLOWLIST]).toEqual(['packages/operator-core/lib/release/checkpoint-log-tags.ts']);
  });

  // ---- the false-NEGATIVE control that a naive comment-stripper fails ---------------------

  it('⭐ a `//` inside a STRING does not hide a real emit later on the same line', () => {
    // A naive strip-to-end-of-line on `//` would blank the rest of this line and report clean —
    // a false negative, the direction that matters for a guard. Same family as the form-blind
    // detectors documented in CLAUDE.md, which matched a spelling instead of the property.
    const line = `console.warn("see https://x.test/docs", \`${TAG} boom\`);`;
    expect(stripComments(line)).toContain(TAG);
    expect(scanFixture({ 'src/url.ts': line })).toHaveLength(1);
  });

  it('stripComments preserves line numbering so reported lines are true', () => {
    const src = ['/* a\n   multi-line\n   banner */', 'const x = 1;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  // ---- scope is asserted, not assumed ------------------------------------------------------

  it('scans the roots that actually contain gate narration', () => {
    expect(GC_TAG_SOURCE_ROOTS).toEqual(['packages/operator-core/lib', 'apps/operator/lib']);
  });
});
