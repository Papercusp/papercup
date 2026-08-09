/**
 * P-004 (knowledge-at-symptom-time-2026-08-09) — docs:search cross-surface probe.
 *
 * The incident this guards: an su searched the `harness` surface for an agent-insights page, got 37
 * confident but entirely irrelevant hits, and re-derived from scratch a diagnosis that was already
 * written down in `agent-insights/inference-gateway-three-rate-signals-not-one`. The response already
 * carried the proof it had failed — `legs.semantic.status: 'ran'` with `candidates: 0` — and merely
 * footnoted a suggestion to retry elsewhere.
 *
 * The property under test is the DISCRIMINATION, not the plumbing: exactly which `legs.semantic.status`
 * values earn a second corpus read. Getting that wrong is expensive in both directions — too narrow and
 * the probe never fires when it matters, too broad and every docs:search on a box with a dead embedder
 * doubles its work forever.
 */
import { describe, it, expect } from 'vitest';
import { shouldProbeSiblingSurface } from './search';

type Leg = { status?: string; candidates?: number } | undefined;
const ask = (over: Partial<{ surface: 'harness' | 'engineering' | 'project'; isSuperuser: boolean; semanticLeg: Leg }> = {}) =>
  shouldProbeSiblingSurface({
    surface: 'harness',
    isSuperuser: true,
    semanticLeg: { status: 'ran', candidates: 0 },
    ...over,
  });

describe('shouldProbeSiblingSurface', () => {
  it('FIRES on the measured incident shape: semantic leg ran on the harness surface and matched nothing', () => {
    // Verbatim shape from the 2026-08-09 docs:search response that triggered this work.
    expect(ask({ surface: 'harness', isSuperuser: true, semanticLeg: { status: 'ran', candidates: 0 } })).toBe(true);
  });

  it('fires on the project surface too — it has the same corpus gap as harness', () => {
    expect(ask({ surface: 'project' })).toBe(true);
  });

  // ── The control that separates "this corpus has nothing" from "the embedder is broken" ──────────
  // A dead embedder degrades EVERY query identically, so a second corpus read buys nothing and would
  // double every docs:search on the box. This is the case a naive implementation gets wrong.
  it('does NOT fire when the semantic leg was BLOCKED (dead embedder — says nothing about the corpus)', () => {
    expect(ask({ semanticLeg: { status: 'blocked', candidates: 0 } })).toBe(false);
  });

  it('does NOT fire when the semantic leg never ran (lexical-only was requested)', () => {
    expect(ask({ semanticLeg: { status: 'not-run', candidates: 0 } })).toBe(false);
  });

  it('does NOT fire when the leg is absent entirely', () => {
    expect(ask({ semanticLeg: undefined })).toBe(false);
  });

  // ── Corpus actually matched something ───────────────────────────────────────────────────────────
  it('does NOT fire when the semantic leg found real candidates — this corpus does have the topic', () => {
    expect(ask({ semanticLeg: { status: 'ran', candidates: 3 } })).toBe(false);
  });

  // ── Gates ───────────────────────────────────────────────────────────────────────────────────────
  it('does NOT fire on the engineering surface itself (that would be a self-query)', () => {
    expect(ask({ surface: 'engineering' })).toBe(false);
  });

  it('does NOT fire for a non-superuser — the probe must not be a side door around the D-005/P-016 gate', () => {
    expect(ask({ isSuperuser: false })).toBe(false);
  });
});

/**
 * FALSIFIABILITY CONTROL — kept permanently, per the repo's "proving a guard is falsifiable" rule
 * (mutate a copy, never the shared tree).
 *
 * `naiveShouldProbe` is the implementation a reasonable person writes first: "the semantic leg found
 * nothing, so look elsewhere." It ignores `status`, so it cannot tell an empty corpus from a broken
 * embedder. If the real implementation ever regresses to this shape, the blocked/not-run cases above
 * start passing when they should fail — and this block asserts the two genuinely DISAGREE, so the
 * suite above is proven to be discriminating rather than trivially green.
 */
function naiveShouldProbe(input: { surface: string; isSuperuser: boolean; semanticLeg: Leg }): boolean {
  if (input.surface === 'engineering') return false;
  if (!input.isSuperuser) return false;
  return (input.semanticLeg?.candidates ?? 0) === 0;
}

describe('falsifiability control', () => {
  it('the naive candidates-only rule DISAGREES with the real one exactly on the embedder-fault cases', () => {
    const embedderFaults: Leg[] = [{ status: 'blocked', candidates: 0 }, { status: 'not-run', candidates: 0 }, undefined];

    for (const leg of embedderFaults) {
      const real = shouldProbeSiblingSurface({ surface: 'harness', isSuperuser: true, semanticLeg: leg });
      const naive = naiveShouldProbe({ surface: 'harness', isSuperuser: true, semanticLeg: leg });
      expect(real).toBe(false);
      // If this ever equals `real`, the status-discrimination has been lost and the tests above went
      // vacuous — they would pass against an implementation that probes on every degraded query.
      expect(naive).toBe(true);
    }
  });

  it('the two AGREE on the incident shape — so the control is not merely inverting everything', () => {
    const leg: Leg = { status: 'ran', candidates: 0 };
    expect(shouldProbeSiblingSurface({ surface: 'harness', isSuperuser: true, semanticLeg: leg })).toBe(true);
    expect(naiveShouldProbe({ surface: 'harness', isSuperuser: true, semanticLeg: leg })).toBe(true);
  });
});
