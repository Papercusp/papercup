/**
 * P-017 — the D-001 routing contract, pinned to the live guidance surfaces.
 *
 * Sibling of `gate-candidate-ref.test.ts` / `retired-surfaces.test.ts`, and it
 * follows their discipline for the same reason: once the live assertion goes
 * green it stops being evidence that the detector works at all. Every fixture
 * below reproduces a shape that MUST be caught — including the two routes that
 * were genuinely live in shipped guidance when P-017 opened.
 *
 * The false-positive controls matter as much as the catches here. A banned tool
 * name appears in CORRECT guidance (the "not" column, the ⚠ warning), so a
 * presence-based detector would flag the fix and reward deleting the warning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeCodeIntelRouting,
  formatRoutingViolations,
  BANNED_ROUTES,
} from './code-intel-routing-authority';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The surfaces a choosing agent actually reads before picking a code-intel tool. */
const GUIDANCE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
] as const;

describe('D-001 code-intelligence routing authority', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact CLAUDE.md row P-017 removed — gitnexus.query as the code-graph authority', () => {
      const verdict = judgeCodeIntelRouting(
        [
          '| you want | use | not |',
          '|---|---|---|',
          '| code graph / call sites | `gitnexus.query` (dot, not colon) | a hand-walk of the tree |',
        ].join('\n'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]!.tool).toBe('gitnexus.query');
      expect(verdict.violations[0]!.position).toBe('authority-cell');
      expect(verdict.violations[0]!.reason).toMatch(/UNRANKED NOISE/);
    });

    it('catches the exact su-playbook bullet P-017 removed — raw repomix.pack advertised as high-value', () => {
      const verdict = judgeCodeIntelRouting(
        '- **`repomix.pack`** — pack a repo (subset) into one LLM-friendly document.',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]!.tool).toBe('repomix.pack');
      expect(verdict.violations[0]!.position).toBe('recommendation-bullet');
      expect(verdict.violations[0]!.instead).toBe('code:pack');
    });

    it('catches a banned route in a TWO-column authority table (the su playbook shape)', () => {
      const verdict = judgeCodeIntelRouting(
        ['| the question | the authority |', '|---|---|', '| call chains | `gitnexus.query` |'].join(
          '\n',
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.position).toBe('authority-cell');
    });

    it('catches a banned route in a row whose EARLIER cell contains an escaped pipe', () => {
      // Regression pin: splitting on a bare /\|/ shifts cells left, so the judge
      // would inspect the "not" column and vacuously pass. This row is the shape
      // that breaks a naive splitter — the `plans:list` enum spelling.
      const verdict = judgeCodeIntelRouting(
        "| a \\| b \\| c | `gitnexus.query` | not this |",
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.tool).toBe('gitnexus.query');
    });
  });

  describe('false-positive controls (correct guidance must NOT be flagged)', () => {
    it('does not flag a banned tool named in the "not" column — that IS the fix', () => {
      const verdict = judgeCodeIntelRouting(
        '| call chains | `gitnexus.context` / `gitnexus.impact` | `gitnexus.query` — UNRANKED NOISE, not empty (D-021) |',
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.positionsChecked).toBeGreaterThan(0);
    });

    it('does not flag a banned tool named in a ⚠ prose warning', () => {
      const verdict = judgeCodeIntelRouting(
        '⚠ Two raw backends are deliberately NOT the route. `gitnexus.query` returns UNRANKED NOISE, and raw `repomix.pack` skips the pinned version.',
      );
      expect(verdict.ok).toBe(true);
    });

    it('does not flag the sanctioned authorities', () => {
      const verdict = judgeCodeIntelRouting(
        [
          '| the question | the authority |',
          '|---|---|',
          '| definition, references, type truth | `lsp:query` |',
          '| call chains, impact radius | `gitnexus.context` / `gitnexus.impact` |',
          '| a syntax pattern or codemod | `code:structural` |',
          '| packaging evidence for a reader | `code:pack` |',
        ].join('\n'),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.positionsChecked).toBe(4);
    });
  });

  describe('the live guidance surfaces', () => {
    for (const rel of GUIDANCE_FILES) {
      it(`${rel} routes no question class to a raw backend`, () => {
        const source = readFileSync(join(ROOT, rel), 'utf8');
        const verdict = judgeCodeIntelRouting(source);

        // A zero-inspection verdict is vacuous, not clean: if the parser stopped
        // matching (a table reformatted, a bullet style changed) this file would
        // report ok:true forever while nothing was actually judged.
        expect(
          verdict.positionsChecked,
          `${rel}: judged ZERO recommendation positions — the detector is not reading this file, so its green is vacuous`,
        ).toBeGreaterThan(5);

        expect(
          verdict.ok,
          verdict.ok ? '' : `\n${formatRoutingViolations(rel, verdict.violations)}\n`,
        ).toBe(true);
      });
    }

    it('every banned route names a concrete replacement and a measured reason', () => {
      expect(BANNED_ROUTES.length).toBeGreaterThan(0);
      for (const banned of BANNED_ROUTES) {
        expect(banned.instead, `${banned.tool} must name what to use instead`).toBeTruthy();
        expect(banned.instead).not.toBe(banned.tool);
        // The reason must cite the decision that measured it, so a future reader
        // can re-check the evidence rather than trusting the prohibition.
        expect(banned.reason, `${banned.tool} must cite the measuring decision`).toMatch(
          /D-\d{3}/,
        );
      }
    });
  });
});
