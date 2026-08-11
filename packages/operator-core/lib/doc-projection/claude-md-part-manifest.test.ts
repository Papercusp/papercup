import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — .mjs generator, no type declarations by design (it is a scripts/ tool).
// Keep this import on ONE line: the directive suppresses the error TS reports on the module
// specifier, so wrapping the clause moves that line and the directive reads as unused (TS2578).
import { bootstrapExtent, buildManifest, extractParts, projectionSourceProblem, rangeBoundaryProblems } from '../../../../scripts/gen-claude-md-manifest.mjs';

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
  // A guard that has never failed is a guard that has not been tested.
  //
  // These run against a SYNTHETIC document, never the live CLAUDE.md. That is deliberate and was
  // learned the expensive way twice: re-anchor mode ignores RANGES entirely, so a synthetic doc
  // exercises the real property — and an assertion against the shared file is not a test but a
  // race. The first draft of this very suite asserted `needsReview == []` against live
  // CLAUDE.md and went red within minutes, because a peer edited the file between the manifest
  // being regenerated and the suite running. On this tree that is the normal condition, and a
  // gating test written that way reds the fleet gate daily for no defect at all.
  //
  // The property replaced a line-anchored one (WI-37635 / D-011). The old check refused whenever
  // text MOVED: at the re-anchor it reported 30 drifted ranges while 247 of 252 blocks were
  // byte-identical — a ~6x overstatement, on a file that moves daily.
  const DOC = ['rule one', '', 'rule two', '', 'rule three'].join('\n');

  /** A prior manifest over DOC: real blockShas (via the shipped splitter), hand-assigned kinds. */
  const priorFor = (text: string) => ({
    parts: (extractParts(text) as Array<{ blockSha: string; partKey: string }>).map((p) => ({
      partKey: p.partKey,
      blockSha: p.blockSha,
      kind: 'invariant',
      clientScope: ['all'],
      projectRank: 100,
      expiring: false,
    })),
  });
  const prior = priorFor(DOC);

  it('does NOT fire when blocks merely MOVE', () => {
    // Inserting a paragraph at the top shifts every line. Exactly one block is new, so exactly
    // one block may need review — under the old line-anchored check, ALL of them did.
    const shifted = `a paragraph inserted at the very top\n\n${DOC}`;
    const { needsReview, departed } = buildManifest(shifted, prior) as Reanchor;
    expect(needsReview.map((n) => n.line)).toEqual([1]);
    expect(departed).toEqual([]);
  });

  it('FIRES when a classified block is reworded, and reports the old one as departed', () => {
    const mutant = DOC.replace('rule two', 'rule two, amended');
    expect(mutant).not.toBe(DOC);
    const { needsReview, departed } = buildManifest(mutant, prior) as Reanchor;
    expect(needsReview).toHaveLength(1);
    expect(departed).toHaveLength(1);
  });

  it('leaves a reworded block UNCLASSIFIED rather than inheriting the old verdict', () => {
    const { manifest: rebuilt } = buildManifest(DOC.replace('rule two', 'rule two, amended'), prior) as Reanchor;
    const unclassified = rebuilt.parts.filter((p) => !p.kind);
    expect(unclassified).toHaveLength(1);
    // An unclassified part must never project — that is what stops a silent inherit from
    // pushing unreviewed text into CLAUDE.md.
    for (const p of unclassified) expect(p.clientScope).toEqual([]);
  });

  it('does NOT fire on the unmodified document (calibration)', () => {
    // Without this, every control above would also pass against a checker that always fires.
    const { needsReview, departed, problems } = buildManifest(DOC, prior) as Reanchor;
    expect(problems).toEqual([]);
    expect(needsReview).toEqual([]);
    expect(departed).toEqual([]);
  });

  it('refuses to treat a post-projection client file as canonical source', () => {
    const projected = '<!-- Projected from Postgres: harness_shared.harness_doc_parts (doc_id=claude-md, client=claude). -->\n\nrule one';
    const prior = priorFor(projected);
    const { manifest: rebuilt, problems } = buildManifest(projected, prior) as Reanchor;

    expect(projectionSourceProblem(projected)).toMatch(/generated output/);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Refusing to regenerate the manifest/);
    // The derived parts may still be inspectable for diagnostics, but the CLI must refuse
    // to write them; otherwise the missing prose rows are silently retired.
    expect(rebuilt.summary.needsReview).toBe(0);
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

  it('ships ranges that tile contiguously from line 1', () => {
    // Deliberately NOT asserted against live CLAUDE.md. RANGES is pinned to the snapshot it was
    // drawn on: once the file grows past it, every boundary points at shifted text and the
    // boundary check reports ~28 phantom cuts. A gating test written that way reds the fleet
    // gate daily for no defect, which is the trap this suite already documents elsewhere.
    //
    // Tiling, unlike the boundary shape, is pure line arithmetic — so a synthetic document of
    // the right length exercises it for real, with no dependence on the file's content.
    const synthetic = Array.from({ length: bootstrapExtent() as number }, (_, i) => `line ${i + 1}`).join('\n');
    const { problems } = buildManifest(synthetic, null) as Reanchor;
    expect(problems.filter((p) => /gap:|overlap at|must start at line 1/.test(p))).toEqual([]);
  });
});
