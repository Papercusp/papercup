/**
 * P-010: pin the ratified-design-evidence operator manual to the code it
 * describes (sibling of `gate-candidate-ref.test.ts`, same doc-claims family).
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings state: once
 * the live assertion goes green it stops being evidence that the detector works
 * at all. Each fixture reproduces a drift shape that MUST be caught.
 *
 * There is also a CALIBRATION case. A control proves the judge can say NO; only
 * a calibration case proves it can still say YES to a page that is genuinely
 * correct. Without one, a judge broken so that everything fails would pass every
 * control and look strong — the exact failure D-021 caught in the calibration
 * itself, one level up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS } from '@papercusp/flags';
import {
  judgeDesignEvidenceDoc,
  extractInlineCodeTokens,
  NON_VOCABULARY_TOKENS,
  type DesignEvidenceCodeFacts,
} from './design-evidence-doc-claims';
import { INVALID_REASONS, REFERENCE_CLASSES } from '../design-compare/contract';
import { VERB_REFUSAL_CODES } from '../design-compare/verbs';
import { DESIGN_GATE_FAILURE_REASONS } from '../design-compare/gate';
import { explainPolicy } from '../design-compare/policy';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(
  ROOT,
  'apps/operator-docs/src/content/docs/agent-insights/ratified-design-evidence-operations.mdx',
);
const CI = join(ROOT, '.github/workflows/test.yml');
const PKG = join(ROOT, 'package.json');

const NPM_SCRIPTS = ['design:evidence-report', 'design:evidence-calibrate'] as const;

/**
 * Harvest every kebab token that occurs verbatim in the sources this page
 * describes. Derived, not curated — see `knownElsewhere` for why.
 */
function knownElsewhereTokens(): ReadonlySet<string> {
  // NOTE the deliberate exclusions: `contract.ts` and `verbs.ts` DEFINE the
  // pinned vocabularies, and their prose discusses those constants at length.
  // Harvesting from them would let a constant that was DELETED from its array —
  // but left behind in a neighbouring comment — vouch for itself, which is
  // exactly the drift the backward check exists to catch. Only files on other
  // axes may clear a token.
  const sources = [
    CI,
    PKG,
    join(ROOT, '.gitignore'),
    join(ROOT, 'packages/operator-core/lib/design-compare/report-cli.ts'),
  ];
  const found = new Set<string>();
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/[a-z]+(?:-[a-z]+)+/g)) found.add(match[0]);
  }
  return found;
}

function liveCodeFacts(): DesignEvidenceCodeFacts {
  const eligibility = new Map<string, string>();
  for (const cls of REFERENCE_CLASSES) {
    const derived = explainPolicy(cls);
    eligibility.set(cls, derived ? derived.policy.eligibility : 'absent');
  }

  const ci = readFileSync(CI, 'utf8');
  // The retention on the design-evidence upload step specifically, not the first
  // `retention-days:` in a 1000-line workflow.
  const stepIndex = ci.indexOf('name: design-evidence-report');
  expect(stepIndex, 'the design-evidence upload step must still exist in CI').toBeGreaterThan(-1);
  const retentionMatch = ci.slice(stepIndex).match(/retention-days:\s*(\d+)/);
  expect(retentionMatch, 'the upload step must still declare an explicit retention').not.toBeNull();

  return {
    refusalCodes: VERB_REFUSAL_CODES,
    invalidReasons: INVALID_REASONS,
    referenceClasses: REFERENCE_CLASSES,
    gateFailureReasons: DESIGN_GATE_FAILURE_REASONS,
    flagNames: [FLAGS.DESIGN_EVIDENCE_GATE, FLAGS.DESIGN_EVIDENCE_GATE_ENFORCING],
    eligibility,
    ciRetentionDays: Number(retentionMatch![1]),
    npmScripts: NPM_SCRIPTS,
    knownElsewhere: knownElsewhereTokens(),
    cliFlags: cliFlagsReadByReportCli(),
  };
}

/** Harvest the flags `report-cli.ts` actually reads, from its `argValue` calls. */
function cliFlagsReadByReportCli(): readonly string[] {
  const src = readFileSync(
    join(ROOT, 'packages/operator-core/lib/design-compare/report-cli.ts'),
    'utf8',
  );
  const flags = [...src.matchAll(/argValue\(\s*'([a-z][a-z-]*)'/g)].map((m) => m[1]);
  expect(flags.length, 'report-cli must still parse its flags via argValue()').toBeGreaterThan(0);
  return [...new Set(flags)];
}

/** A minimal page that satisfies every rule — the base every fixture mutates. */
function correctDoc(code: DesignEvidenceCodeFacts): string {
  const vocab = [...code.refusalCodes, ...code.invalidReasons, ...code.gateFailureReasons]
    .map((v) => `\`${v}\``)
    .join(' · ');
  const classRows = [...code.eligibility]
    .filter(([, e]) => e !== 'absent')
    .map(([cls, e]) => `| \`${cls}\` | ${e} | measured |`)
    .join('\n');
  const absentClasses = [...code.eligibility]
    .filter(([, e]) => e === 'absent')
    .map(([cls]) => `| \`${cls}\` | not in the calibration artifact |`)
    .join('\n');
  return [
    '# Ratified design evidence',
    vocab,
    classRows,
    absentClasses,
    code.flagNames.map((f) => `\`${f}\``).join(' and '),
    `retention-days: ${code.ciRetentionDays}`,
    code.npmScripts.map((s) => `npm run ${s}`).join('\n'),
    code.cliFlags.map((f) => `\`--${f}=\``).join(' '),
  ].join('\n\n');
}

describe('design-evidence doc claims', () => {
  const code = liveCodeFacts();

  describe('calibration (the judge must still be able to say YES)', () => {
    it('passes a page that documents every live constant', () => {
      const doc = correctDoc(code);
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        code,
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });

  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a NEW invalid reason the doc never explains', () => {
      const doc = correctDoc(code);
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, invalidReasons: [...code.invalidReasons, 'viewport-drifted'] },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missingFromDoc).toContain('viewport-drifted');
      expect(verdict.violations.join('\n')).toMatch(/not documented/);
    });

    it('catches prose left behind by a rename — the stale-authority case', () => {
      // The control is only as strong as this token being genuinely absent from
      // every source; assert that rather than assuming it, so a future addition
      // to the harvest list cannot quietly defang this case.
      expect(code.knownElsewhere.has('engine-exploded')).toBe(false);
      const doc = `${correctDoc(code)}\n\nSee also \`engine-exploded\` for details.`;
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        code,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.staleInDoc).toContain('engine-exploded');
      expect(verdict.violations.join('\n')).toMatch(/renamed and the prose was left behind/);
    });

    it('clears a token that names something real on another axis', () => {
      // The derivation's whole job: `continue-on-error` is a workflow key, not
      // stale prose. Accusing it would be a false positive, and a doc-claims
      // test that cries wolf gets ignored — which costs more than it saves.
      expect(code.knownElsewhere.has('continue-on-error')).toBe(true);
      const doc = `${correctDoc(code)}\n\nThe step sets \`continue-on-error\`.`;
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        code,
      );
      expect(verdict.staleInDoc).not.toContain('continue-on-error');
      expect(verdict.ok).toBe(true);
    });

    it('does not let the harvest launder a live vocabulary member', () => {
      // Live constants are cleared by the `live` set BEFORE knownElsewhere is
      // consulted, so the derivation can never be what excuses a real code.
      for (const value of [...code.refusalCodes, ...code.invalidReasons]) {
        expect(NON_VOCABULARY_TOKENS.has(value)).toBe(false);
      }
    });

    it('catches a class silently promoted to gateable', () => {
      // policy now gates raster-mockup; the doc still calls it advisory-only.
      const doc = correctDoc(code);
      const promoted = new Map(code.eligibility);
      promoted.set('raster-mockup', 'gateable');
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, eligibility: promoted },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/GATEABLE but the doc does not say so/);
    });

    it('catches a class silently demoted to advisory-only', () => {
      const doc = correctDoc(code);
      const demoted = new Map(code.eligibility);
      demoted.set('artifact-capture', 'advisory-only');
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, eligibility: demoted },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/ADVISORY-ONLY but the doc does not say so/);
    });

    it('catches a renamed feature flag, so the disable path stays followable', () => {
      const doc = correctDoc(code);
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, flagNames: [...code.flagNames, 'papercusp-design-evidence-gate-v2'] },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/disable path cannot be followed/);
    });

    it('catches a CLI flag that exists only in the source', () => {
      const doc = correctDoc(code);
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, cliFlags: [...code.cliFlags, 'shard'] },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/cannot discover a flag that only exists/);
    });

    it('catches a documented flag the CLI would silently ignore', () => {
      const doc = `${correctDoc(code)}\n\nPass \`--strict=\` to fail hard.`;
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        code,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/never reads it/);
    });

    it('catches a changed CI retention the doc still states the old value for', () => {
      const doc = correctDoc(code);
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        { ...code, ciRetentionDays: code.ciRetentionDays + 1 },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/artifact retention/);
    });

    it('does not fire on a code sample — fenced blocks are not claims', () => {
      const doc = `${correctDoc(code)}\n\n\`\`\`ts\nconst x = \`totally-made-up\`;\n\`\`\`\n`;
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(doc), docText: doc },
        code,
      );
      expect(verdict.staleInDoc).not.toContain('totally-made-up');
      expect(verdict.ok).toBe(true);
    });
  });

  describe('the live page', () => {
    const markdown = readFileSync(DOC, 'utf8');

    it('documents every refusal code, invalid reason, class and flag in the code', () => {
      const verdict = judgeDesignEvidenceDoc(
        { docTokens: extractInlineCodeTokens(markdown), docText: markdown },
        code,
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('states the report-only posture rather than implying the gate blocks today', () => {
      expect(markdown).toMatch(/REPORT-ONLY/);
      expect(markdown).toContain(FLAGS.DESIGN_EVIDENCE_GATE_ENFORCING);
    });

    it('carries D-020: identical captures across different surfaces are a bypass', () => {
      expect(markdown).toMatch(/indistinguishablePairs/);
      expect(markdown.toLowerCase()).toMatch(/bypass/);
    });

    it("carries D-021's same-host scope limit, the reason enforcement is still off", () => {
      expect(markdown).toMatch(/same-host/);
      expect(markdown.toLowerCase()).toMatch(/host-to-host|cross-host/);
    });

    it('warns that an advisory-only maxDiffRatio of 0 is not a strict threshold', () => {
      // The single most inverted-on-first-read number in the subsystem.
      expect(markdown).toMatch(/`maxDiffRatio: 0`/);
      expect(markdown).toMatch(/does NOT mean zero tolerance/i);
    });

    it('keeps the curated allowlist small, because the rest is derived', () => {
      // Anything that is a real identifier somewhere is cleared by the derived
      // `knownElsewhere` set, so this list should only ever hold English
      // compounds. If it is growing, the backward check is being widened by
      // hand — the failure mode this module is meant to prevent.
      expect(NON_VOCABULARY_TOKENS.size).toBeLessThanOrEqual(6);
    });
  });

  describe('the disable path is real, not just described', () => {
    it('is pinned by a test that proves the gate is never consulted when off', () => {
      const gateTest = readFileSync(
        join(ROOT, 'packages/operator-core/lib/agent-tools/work_items/design-evidence-gate.test.ts'),
        'utf8',
      );
      // Asserting only the returned status would still pass if the gate ran the
      // whole evaluation and discarded the answer. The throwing evaluator is
      // what makes "never consulted" the thing under test — so the doc's claim
      // depends on that shape, not merely on that test existing.
      expect(gateTest).toMatch(/the gate was consulted while disabled/);
      expect(readFileSync(DOC, 'utf8')).toMatch(/the gate was consulted while disabled/);
    });
  });
});
