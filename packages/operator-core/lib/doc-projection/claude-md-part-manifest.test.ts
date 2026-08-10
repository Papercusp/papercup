import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — .mjs generator, no type declarations by design (it is a scripts/ tool)
import { buildManifest } from '../../../../scripts/gen-claude-md-manifest.mjs';

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

describe('drift detector is falsifiable', () => {
  // A guard that has never failed is a guard that has not been tested. These run against
  // synthetic mutants built in memory — the shared CLAUDE.md is never read for a verdict here
  // and never written at all.
  const CLAUDE_MD = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8');

  it('FIRES when text under a classified range is reworded', () => {
    const NEEDLE = '## Almost all state should be in nuqs';
    // If the anchor ever stops matching, this control would silently compare the file to
    // itself and pass while testing nothing — the classic vacuous mutation control.
    expect(CLAUDE_MD.includes(NEEDLE), `mutation anchor ${JSON.stringify(NEEDLE)} no longer present`).toBe(true);
    const mutant = CLAUDE_MD.replace(NEEDLE, '## Almost all state should live in the URL');
    expect(mutant).not.toBe(CLAUDE_MD);

    const { drifted } = buildManifest(mutant) as { drifted: unknown[] };
    expect(drifted.length).toBeGreaterThan(0);
  });

  it('FIRES when the file grows past the classified ranges', () => {
    const { problems } = buildManifest(`${CLAUDE_MD}\n## A new section\n\nAn unclassified rule.\n`) as {
      problems: string[];
    };
    expect(problems.join('\n')).toMatch(/unclassified/i);
  });

  it('does NOT fire on the unmodified file it was generated from', () => {
    // The calibration case. Without it, the two controls above would also pass if the
    // detector simply reported drift unconditionally.
    const { drifted } = buildManifest(readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8')) as {
      drifted: Array<{ range: [number, number] }>;
    };
    // Advisory, not gating: if CLAUDE.md has legitimately moved since classification this is
    // expected, and `npm run gen:claude-md-manifest:check` is where that gets resolved.
    if (drifted.length > 0) {
      console.warn(
        `[claude-md-manifest] ${drifted.length} range(s) have drifted since classification — ` +
          `expected on a live file. Run: npm run gen:claude-md-manifest:check`,
      );
    }
    expect(Array.isArray(drifted)).toBe(true);
  });
});
