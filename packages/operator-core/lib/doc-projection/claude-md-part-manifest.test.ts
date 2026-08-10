import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — .mjs generator, no type declarations by design (it is a scripts/ tool)
import { buildManifest, rangeBoundaryProblems } from '../../../../scripts/gen-claude-md-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

type Part = {
  partKey: string;
  ordinal: number;
  kind: string;
  clientScope: string[];
  targetSection: string | null;
  projectRank: number;
  blockSha: string;
  chars: number;
};
type Manifest = {
  schema: string;
  docId: string;
  contentMode: string;
  snapshotChars: number;
  snapshotBytes: number;
  summary: { projectedChars: number; totalParts: number };
  parts: Part[];
};

const manifest: Manifest = JSON.parse(readFileSync(resolve(HERE, 'claude-md-part-manifest.json'), 'utf8'));

/**
 * P-014, plan claude-md-projection-from-pg-2026-08-10.
 *
 * WHAT THIS SUITE DELIBERATELY DOES **NOT** DO: assert that the classification still matches
 * the CURRENT CLAUDE.md.
 *
 * That assertion was written first and removed before it ever ran in CI, because CLAUDE.md is
 * edited continuously by the whole fleet — it grew 678 bytes and 8 lines during the 40 minutes
 * between the P-002 classification and this file being authored. A drift assertion here would
 * therefore red the green-checkpoint gate within about a day and keep it red, blocking EVERY
 * agent's deploys over an entirely normal edit. A test that fails on routine activity does not
 * protect an invariant; it trains people to ignore the suite.
 *
 * Drift is checked where it actually matters — at LOAD time, by the generator:
 *   npm run gen:claude-md-manifest:check      (exit 1 + names the ranges to re-review)
 * P-003 must run that before loading, and the generator refuses to emit a manifest built on a
 * drifted classification.
 *
 * So this suite pins the two things that ARE invariants: the shape of the committed manifest,
 * and the fact that the drift detector can still fire (proven against synthetic mutants, never
 * against the shared file).
 */
describe('claude-md part manifest (committed artifact)', () => {
  it('is the expected schema and declares itself composed (D-010)', () => {
    expect(manifest.schema).toBe('claude-md-part-manifest/1');
    expect(manifest.docId).toBe('claude-md');
    // parts are canonical, the file is projector output — migration 781's content_mode
    expect(manifest.contentMode).toBe('composed');
  });

  it('gives every part a unique, strictly kebab-case key', () => {
    const keys = manifest.parts.map((p) => p.partKey);
    expect(new Set(keys).size).toBe(keys.length);
    const malformed = keys.filter((k) => !/^[a-z0-9-]+$/.test(k));
    expect(malformed).toEqual([]);
  });

  it('numbers parts contiguously in file order', () => {
    expect(manifest.parts.map((p) => p.ordinal)).toEqual(manifest.parts.map((_, i) => i + 1));
  });

  // ── the CHECK constraints migration 781 enforces in Postgres, asserted here too, so a bad
  //    manifest fails in CI rather than at INSERT time halfway through the load ──

  it('never projects prose (harness_doc_parts_prose_never_projects)', () => {
    const leaked = manifest.parts.filter((p) => p.kind === 'prose' && p.clientScope.length > 0);
    expect(leaked.map((p) => p.partKey)).toEqual([]);
  });

  it('gives every projected part a target section (harness_doc_parts_projected_needs_section)', () => {
    const homeless = manifest.parts.filter((p) => p.clientScope.length > 0 && !p.targetSection);
    expect(homeless.map((p) => p.partKey)).toEqual([]);
  });

  it('uses only the four kinds migration 781 accepts (harness_doc_parts_kind_check)', () => {
    expect([...new Set(manifest.parts.map((p) => p.kind))].sort()).toEqual([
      'invariant',
      'pointer',
      'prose',
      'recipe',
    ]);
  });

  it('ranks every projected kind ahead of prose, so a D-008 budget cut spares the rules', () => {
    const worstProjected = Math.max(...manifest.parts.filter((p) => p.clientScope.length).map((p) => p.projectRank));
    const bestProse = Math.min(...manifest.parts.filter((p) => p.kind === 'prose').map((p) => p.projectRank));
    expect(worstProjected).toBeLessThan(bestProse);
  });

  it('records bytes and characters as separate, named quantities', () => {
    // `wc -c` (bytes) and String.length disagree by ~1.5k here — the file is dense with
    // multibyte glyphs — and D-008's budget threshold is expressed in CHARACTERS. Conflating
    // the two misjudges the budget by about a percent, silently.
    expect(manifest.snapshotBytes).toBeGreaterThan(manifest.snapshotChars);
  });

  it('moves the majority out and projects a minority', () => {
    const projected = manifest.summary.projectedChars / manifest.snapshotChars;
    expect(projected).toBeGreaterThan(0.3);
    expect(projected).toBeLessThan(0.55);
  });
});

type Reanchor = {
  problems: string[];
  needsReview: Array<{ partKey: string; blockSha: string; line: number }>;
  departed: Array<{ partKey: string; blockSha: string; kind: string }>;
  manifest: Manifest;
};

describe('re-anchoring carries classification by CONTENT, not by line', () => {
  // A guard that has never failed is a guard that has not been tested. These run against
  // synthetic mutants built in memory — the shared CLAUDE.md is never read for a verdict here
  // and never written at all.
  //
  // The property under test replaced a line-anchored one (WI-37635 / D-011). The old check
  // refused whenever text MOVED: at the re-anchor it reported 30 drifted ranges while 247 of 252
  // blocks were byte-identical — a ~6x overstatement, on a file that moves daily.
  const CLAUDE_MD = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8');

  it('does NOT fire when blocks merely MOVE', () => {
    // A peer inserting a paragraph at the top shifts every line in the file. Exactly one block
    // is new, so exactly one block may need review.
    const shifted = `An unrelated paragraph a peer added at the very top.\n\n${CLAUDE_MD}`;
    const { needsReview, departed } = buildManifest(shifted, manifest) as Reanchor;
    expect(needsReview.map((n) => n.line)).toEqual([1]);
    expect(departed).toHaveLength(0);
  });

  it('FIRES when a classified block is reworded', () => {
    const NEEDLE = '## Almost all state should be in nuqs';
    // If the anchor ever stops matching, this control would silently compare the file to
    // itself and pass while testing nothing — the classic vacuous mutation control.
    expect(CLAUDE_MD.includes(NEEDLE), `mutation anchor ${JSON.stringify(NEEDLE)} no longer present`).toBe(true);
    const mutant = CLAUDE_MD.replace(
      'Prefer `parseAsStringEnum`',
      'Always prefer `parseAsStringEnum`',
    );
    expect(mutant).not.toBe(CLAUDE_MD);

    const { needsReview, departed } = buildManifest(mutant, manifest) as Reanchor;
    expect(needsReview.length).toBeGreaterThan(0);
    // and the block it replaced is reported as gone, rather than silently keeping its verdict
    expect(departed.length).toBeGreaterThan(0);
  });

  it('leaves a reworded block UNCLASSIFIED rather than inheriting the old verdict', () => {
    const mutant = CLAUDE_MD.replace('Prefer `parseAsStringEnum`', 'Always prefer `parseAsStringEnum`');
    const { manifest: rebuilt } = buildManifest(mutant, manifest) as Reanchor;
    const unclassified = rebuilt.parts.filter((p) => !p.kind);
    expect(unclassified.length).toBeGreaterThan(0);
    // An unclassified part must never project — that is what stops a silent inherit from
    // pushing unreviewed text into CLAUDE.md.
    for (const p of unclassified) expect(p.clientScope).toEqual([]);
  });

  it('does NOT fire on the unmodified file the manifest was generated from', () => {
    // The calibration case. Without it, the controls above would also pass if the detector
    // simply reported everything as needing review.
    const { needsReview, departed, problems } = buildManifest(CLAUDE_MD, manifest) as Reanchor;
    expect(problems).toEqual([]);
    expect(needsReview).toEqual([]);
    expect(departed).toEqual([]);
  });
});

describe('the RANGES bootstrap may not cut a block in half', () => {
  // Exactly one such boundary existed — after L181, inside "Never kill by name" — and it split
  // one paragraph into two parts whose shas no whole-file reader can reproduce. Harmless while
  // parts were addressed by line; not once blockSha carries the classification.
  const lines = ['rule one', '', 'a paragraph that', 'runs across lines', '', 'rule two'];

  it('FIRES on a boundary that lands mid-paragraph', () => {
    // ends at line 3, but lines 3 and 4 are one paragraph
    const problems = rangeBoundaryProblems(lines, [[1, 3, 'INV'], [4, 6, 'INV']]);
    expect(problems.join('\n')).toMatch(/mid-paragraph/);
  });

  it('FIRES on a boundary inside a fenced code block', () => {
    const fenced = ['```bash', 'echo one', '', 'echo two', '```'];
    const problems = rangeBoundaryProblems(fenced, [[1, 3, 'REC'], [4, 5, 'REC']]);
    expect(problems.join('\n')).toMatch(/fenced code block/);
  });

  it('does NOT fire when boundaries land on blank lines', () => {
    // The calibration case: without it, both controls pass against a checker that always fires.
    expect(rangeBoundaryProblems(lines, [[1, 2, 'INV'], [3, 6, 'INV']])).toEqual([]);
  });

  it('holds for the ranges actually shipped', () => {
    // The regression this exists to prevent, asserted against the real bootstrap data.
    const snapshot = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8').split('\n');
    const { problems } = buildManifest(snapshot.join('\n'), null) as Reanchor;
    expect(problems.filter((p) => /mid-paragraph|fenced code block/.test(p))).toEqual([]);
  });
});
