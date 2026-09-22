/**
 * AUTO-BAR-R-7-P-009 — the published tool-delivery doc must state the MEASURED
 * before/after bytes alongside the two corrections (callers-not-calls; three tiers not
 * two). Sibling of `gate-candidate-ref.test.ts`, same doc-claims family.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each
 * fixture reproduces a shape that MUST be caught — above all the "impressive numbers that
 * do not reconcile" case, because that is what a hand-updated doc looks like after the
 * generator has moved underneath it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeToolDeliveryDoc } from './tool-delivery-doc-measurements';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(
  ROOT,
  'apps/operator-docs/src/content/docs/agent-insights/how-tool-definition-delivery-is-decided.mdx',
);

/** A minimal body that PASSES, used as the base each control mutates one way. */
const GOOD = `
Rank by distinct callers, not by raw invocation count.
There are three tiers: full, compact and deferred.
\`\`\`
WIRE_BYTES       full=1599477  compact=649761  savedByCompact=949716
GUIDANCE_BYTES   full=334797   summary=81030   savedBySummary=253767
DEFINITION_BYTES  full=369616  compact=100418  savedByCompact=269198
DEFINITION_TOKENS full=109945  compact=38329   savedByCompact=71616
\`\`\`
The byte figure is an UPPER BOUND on the context actually saved.
`;

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('CALIBRATION: the passing fixture really passes, so the controls are not vacuous', () => {
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('catches a doc that boasts a saving whose arithmetic does not reconcile', () => {
    // THE case this guard exists for: the generator moved, someone refreshed one number
    // by hand, and the doc still reads authoritatively.
    const v = judgeToolDeliveryDoc(GOOD.replace('savedByCompact=949716', 'savedByCompact=900000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a stale guidance saving independently of the wire saving', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('savedBySummary=253767', 'savedBySummary=253000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('guidance-bytes-do-not-reconcile');
    // the wire half must still be judged clean — the two are measured separately (D-011)
    expect(v.violations).not.toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a doc that states a saving with no before/after to check it against', () => {
    const v = judgeToolDeliveryDoc(`
      Rank by distinct callers, not by raw invocation count.
      There are three tiers: full, compact and deferred.
      The compact tier saves about 59% of the wire.
    `);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-wire-bytes-measurement');
  });

  it('catches a doc that drops the callers-not-calls correction', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace(/Rank by distinct callers.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-callers-not-calls-correction');
  });

  it('catches a doc that drops the three-tier correction', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('There are three tiers: full, compact and deferred.', ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-three-tiers-correction');
  });

  it('catches a doc that states bytes but NO token figure', () => {
    // The specific gap this clause was added for: every byte triple reconciles, the doc
    // reads as fully measured, and it is silent on the only unit the provider bills.
    const v = judgeToolDeliveryDoc(GOOD.replace(/DEFINITION_TOKENS.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-definition-token-measurement');
  });

  it('catches a token triple whose arithmetic does not reconcile', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('savedByCompact=71616', 'savedByCompact=80000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('definition-tokens-do-not-reconcile');
    // the byte halves must still be judged clean — they are separate measurements
    expect(v.violations).not.toContain('definition-bytes-do-not-reconcile');
    expect(v.violations).not.toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a doc that drops the UPPER BOUND label', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace(/The byte figure is an UPPER BOUND.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-upper-bound-label');
  });

  it('catches numbers that no longer SUPPORT the upper-bound label', () => {
    // THE case the label alone cannot catch: the prose still says "upper bound" while the
    // doc's own numbers now show the token saving overtaking the byte saving. A stale
    // claim that was once true is exactly what a prose-only check preserves.
    const v = judgeToolDeliveryDoc(
      GOOD.replace('DEFINITION_TOKENS full=109945  compact=38329   savedByCompact=71616',
                   'DEFINITION_TOKENS full=109945  compact=10000   savedByCompact=99945'),
    );
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('byte-saving-not-an-upper-bound');
  });

  it('CALIBRATION: the passing fixture really does satisfy the upper-bound arithmetic', () => {
    // Without this, the control above could pass because the detector is broken in the
    // other direction — flagging everything, including a correct doc.
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).not.toContain('byte-saving-not-an-upper-bound');
    // and the relationship it asserts is real on the published numbers: 65.1% < 72.8%
    const tokenSaving = (109945 - 38329) / 109945;
    const byteSaving = (369616 - 100418) / 369616;
    expect(tokenSaving).toBeLessThan(byteSaving);
  });

  it('does NOT confuse the wire `full` with the guidance `full` (both lines carry one)', () => {
    // The scoping bug this guards: a document-wide lookup returns the WIRE full for the
    // guidance identity, so a correct doc reports as broken — a false positive, which is
    // how a guard gets weakened rather than fixed.
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).not.toContain('guidance-bytes-do-not-reconcile');
    // and the parser did see four distinct `full` pairs, so the risk was real — each of
    // the four measurement lines carries one, which is why every lookup is line-scoped
    expect(v.pairs.filter((p) => p.key === 'full').map((p) => p.value)).toEqual([
      1599477, 334797, 369616, 109945,
    ]);
  });
});

describe('the published doc satisfies AUTO-BAR-R-7-P-009', () => {
  const body = readFileSync(DOC, 'utf8');

  it('exists and is not a stub (a vacuous green is worse than a red)', () => {
    expect(body.length).toBeGreaterThan(2000);
  });

  it('states both corrections and both reconciling before/after measurements', () => {
    const v = judgeToolDeliveryDoc(body);
    expect(v.violations, v.violations.join(', ')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('names the budget the measurements are judged against', () => {
    // A saving with no ceiling is not a decision. D-009 unified all three agent kinds
    // DOWN onto the tightest of the three live budgets.
    expect(body).toMatch(/budget=100000/);
  });
});
