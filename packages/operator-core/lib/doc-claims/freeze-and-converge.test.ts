/**
 * CLAUDE.md's freeze-and-converge claims must stay true of the queue's own module
 * (frozen-candidate-compliance-enforcement-2026-08-30 P-009; sibling of
 * `gate-candidate-ref.test.ts`, same doc-claims family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. The first
 * fixture reproduces the exact design that was proposed on this plan and retracted —
 * fast-forwarding the frozen candidate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeFreezeAndConverge, stripComments } from './freeze-and-converge';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const QUEUE = join(ROOT, 'packages/operator-core/lib/release/frozen-candidate-repair-queue.ts');
// P-001 / D-010 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the ONE door a
// fix enters the frozen lineage through. `converge-repair-head.ts` (the fast-forward plan) is
// gone; what remains of it is the read-only containment probe in `judged-sha-containment.ts`.
const ADMIT = join(ROOT, 'packages/operator-core/lib/release/repair-head-admission.ts');

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('catches a fast-forward of the frozen candidate — the retracted design', () => {
    const verdict = judgeFreezeAndConverge(`
      const advanced = { ...queue, candidate: stagingTip, repairHead: stagingTip };
    `);
    expect(verdict.ok).toBe(false);
    expect(verdict.candidateWriteSites).toHaveLength(1);
    expect(verdict.violations.join('\n')).toMatch(/does not move/);
  });

  it('catches the mechanism going missing entirely', () => {
    const verdict = judgeFreezeAndConverge('const x = 1;');
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toMatch(/mechanism the prose describes is absent/);
  });

  it('accepts the correct shape: repairHead moves, candidate does not', () => {
    const verdict = judgeFreezeAndConverge(`
      const converged = { ...queue, repairHead: decision.newRepairHead };
    `);
    expect(verdict.ok).toBe(true);
  });

  it('does not count a doc comment as a candidate write', () => {
    const verdict = judgeFreezeAndConverge(`
      /** never do { ...queue, candidate: tip } — the candidate is immutable */
      const converged = { ...queue, repairHead: tip };
    `);
    expect(verdict.candidateWriteSites).toHaveLength(0);
    expect(verdict.ok).toBe(true);
  });

  it('stripComments removes block and line comments but keeps code', () => {
    expect(stripComments('/* a */ const x = 1; // b')).toContain('const x = 1;');
    expect(stripComments('/* a */ const x = 1; // b')).not.toContain('// b');
  });
});

describe('the live claim', () => {
  it('does not count a projection that spreads a queue IDENTITY and copies candidate through', () => {
    const verdict = judgeFreezeAndConverge(
      'return { ...identity, candidate: queue.candidate, repairHead: queue.repairHead };',
    );
    expect(verdict.candidateWriteSites).toHaveLength(0);
  });

  it('the queue module advances repairHead and never rewrites candidate', () => {
    const verdict = judgeFreezeAndConverge(readFileSync(QUEUE, 'utf8'));
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('the P-001 admit route (the one door) also leaves the candidate alone', () => {
    const verdict = judgeFreezeAndConverge(readFileSync(ADMIT, 'utf8'));
    expect(verdict.candidateWriteSites).toEqual([]);
  });

  it('the queue module still documents the candidate as immutable', () => {
    // The prose half of the pair: if this wording goes, CLAUDE.md's claim has lost its
    // in-code counterpart and the next reader has only the doc to trust.
    expect(readFileSync(QUEUE, 'utf8')).toMatch(/immutable/i);
  });
});
