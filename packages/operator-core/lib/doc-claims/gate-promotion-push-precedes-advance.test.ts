/**
 * CLAUDE.md's scoped promotion claim must stay true of green-checkpoint.ts
 * (EI-20626763969105622; sibling of `gate-candidate-ref.test.ts`, which pins the OTHER
 * half of the very same box — that the candidate is cut from the LOCAL branch).
 *
 * The two guards are deliberately a pair. The box makes one claim about the gate's INPUT
 * (candidate selection ignores origin) and one about its OUTPUT (promotion depends on
 * origin). Reading the first as covering both is what EI-20626763969105622 measured, so
 * each half now has its own executable pin.
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each
 * fixture reproduces a shape that MUST be caught — including the wrapped-receiver form
 * that a naive `deps.advance(` matcher would silently miss.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeGatePromotionPush } from './gate-promotion-push-precedes-advance';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GREEN_CHECKPOINT = join(ROOT, 'apps/operator/lib/release/green-checkpoint.ts');

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(120)}`;

/** A correctly-shaped helper: publishes, and rethrows so no success path can run. */
const RETHROWING_HELPER = `
async function pushGreenCandidateOrThrow(cfg, deps, candidate, baseSha) {
  try {
    await deps.push(cfg.releaseRef, baseSha, candidate);
  } catch (error) {
    deps.log('push failed');
    throw error;
  }
}
`;

describe('CLAUDE.md gate-promotion push-precedes-advance claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a push helper that swallows the failure instead of rethrowing', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
async function pushGreenCandidateOrThrow(cfg, deps, candidate, baseSha) {
  try {
    await deps.push(cfg.releaseRef, baseSha, candidate);
  } catch (error) {
    deps.log('push failed, continuing anyway');
  }
}
async function promote() {
  await pushGreenCandidateOrThrow(cfg, deps, tip, lastReady);
  const adv = await deps.advance(tip);
}
        `),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.pushHelperRethrows).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no longer rethrows/);
    });

    it('catches an advance with no preceding push — promotion without publishing', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
${RETHROWING_HELPER}
async function promote() {
  const adv = await deps.advance(candidate);
}
        `),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.unguardedAdvanceSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/advances the green pin with no preceding push/);
    });

    it('catches a call site whose .catch swallows the push rejection', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
${RETHROWING_HELPER}
async function promote() {
  await pushGreenCandidateOrThrow(cfg, deps, candidate, lastReady).catch(() => {});
  const adv = await deps.advance(candidate);
}
        `),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.swallowedPushSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/swallows a push rejection/);
    });

    /**
     * THE CALIBRATION THAT MATTERS. `await deps\n  .advance(candidate)` is the real
     * formatting of one of the two live promotion paths. A detector matching
     * `deps.advance(` scores this fixture as having NO advance site at all, reports
     * `ok: true`, and is thereby vacuous on half the production file while looking
     * healthy. If this test ever starts passing the fixture, the guard has regressed.
     */
    it('SEES an advance whose receiver is on the previous line (wrapped by the formatter)', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
${RETHROWING_HELPER}
async function promote() {
  repairPromotionAdvance = await deps
    .advance(candidate)
    .catch((error) => {
      throw error;
    });
}
        `),
      );
      expect(verdict.advanceSites).toHaveLength(1);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no preceding push/);
    });

    it('does NOT fire on a correctly-ordered two-path promotion (over-fire calibration)', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
${RETHROWING_HELPER}
async function promotePrefix() {
  if (!noPush) {
    await pushGreenCandidateOrThrow(cfg, deps, prefixTip, lastReady);
  }
  const adv = await deps.advance(prefixTip);
}
async function promoteRepair() {
  if (!opts.noPush) {
    await pushGreenCandidateOrThrow(cfg, deps, candidate, lastReady).catch(
      (error) => {
        stampPromotion(false, 'push-failed');
        throw error;
      },
    );
  }
  repairPromotionAdvance = await deps
    .advance(candidate)
    .catch((error) => {
      throw error;
    });
}
        `),
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.advanceSites).toHaveLength(2);
      expect(verdict.pushSites).toHaveLength(2);
    });

    it('REFUSES a short read rather than reporting it as a clean pass', () => {
      expect(() => judgeGatePromotionPush('const unrelated = 1;')).toThrow(/Refusing to judge/);
    });

    it('does NOT credit a rethrow that lives in a comment', () => {
      const verdict = judgeGatePromotionPush(
        pad(`
async function pushGreenCandidateOrThrow(cfg, deps, candidate, baseSha) {
  try {
    await deps.push(cfg.releaseRef, baseSha, candidate);
  } catch (error) {
    // we used to throw error here, but it was noisy
    deps.log('push failed');
  }
}
async function promote() {
  await pushGreenCandidateOrThrow(cfg, deps, tip, lastReady);
  const adv = await deps.advance(tip);
}
        `),
      );
      expect(verdict.pushHelperRethrows).toBe(false);
      expect(verdict.ok).toBe(false);
    });
  });

  describe('the live claim', () => {
    const source = readFileSync(GREEN_CHECKPOINT, 'utf8');

    it('holds against green-checkpoint.ts', () => {
      const verdict = judgeGatePromotionPush(source, 500);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.pushHelperRethrows).toBe(true);
    });

    /**
     * Non-vacuity: the live file really does contain BOTH promotion paths, and one of
     * them is the wrapped-receiver form. Asserting the count here is what stops the
     * clean verdict above from being a clean verdict over a single path the detector
     * happened to see.
     */
    it('sees BOTH live promotion paths, wrapped receiver included', () => {
      const verdict = judgeGatePromotionPush(source, 500);
      expect(verdict.advanceSites.length).toBeGreaterThanOrEqual(2);
      expect(verdict.pushSites.length).toBeGreaterThanOrEqual(2);
      expect(verdict.unguardedAdvanceSites).toEqual([]);
      expect(verdict.swallowedPushSites).toEqual([]);
    });
  });
});
