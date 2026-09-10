/**
 * CLAUDE.md's "the queue re-tests that head itself" promise must stay true of
 * green-checkpoint.ts (P-007 / R-7 of green-gate-zero-wait-convergence-2026-09-08).
 *
 * Three halves, each an independent pin:
 *   - EXECUTABLE: the queue module really does write a durable retest marker on admission
 *     and really does classify a judged head against it (`refire` / `settled` / `none`);
 *   - SOURCE: the gate consumes that marker and self-refires in-process, bounded;
 *   - DOC: the sentence is still in CLAUDE.md, so the code pins are guarding a live claim.
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion is green it stops being evidence that the detector works. Each fixture is a
 * shape the detector MUST catch, including the split-receiver call form.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NO_CRON_WAIT_DOC_PHRASE,
  docStillMakesNoCronWaitClaim,
  judgeNoCronWaitRepairPath,
} from './gate-repair-latency-no-cron-wait';
import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairAdmitted,
  settleFrozenRepairRetestRequest,
} from '../release/frozen-candidate-repair-queue';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GREEN_CHECKPOINT = join(ROOT, 'apps/operator/lib/release/green-checkpoint.ts');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(120)}`;

const CONSUME = `
  const consumed = await deps.consumeFrozenRepairRetestRequest({ judgedRepairHead });
`;
const REFIRE_IN_PROCESS_BOUNDED = `
  if (consumed?.kind === "refire" && consumed.request) {
    if (admissionRefires < MAX_ADMISSION_REFIRE_ATTEMPTS) {
      return runGreenCheckpoint(cfg, deps, { ...opts, candidate: consumed.request.repairHead });
    }
  }
`;

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;

describe('CLAUDE.md no-cron-wait repair claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('refuses a stub too short to be the gate', () => {
      expect(judgeNoCronWaitRepairPath('const x = 1;')).toEqual({ ok: false, missing: ['source-too-short'], found: {} });
    });

    it('catches a gate that never consumes the retest marker', () => {
      const verdict = judgeNoCronWaitRepairPath(pad(REFIRE_IN_PROCESS_BOUNDED));
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toEqual(['consume-call']);
    });

    it('does not count a consume call that lives only in a comment', () => {
      const verdict = judgeNoCronWaitRepairPath(
        pad(`// await deps.consumeFrozenRepairRetestRequest({ judgedRepairHead });\n${REFIRE_IN_PROCESS_BOUNDED}`),
      );
      expect(verdict.missing).toContain('consume-call');
    });

    it('catches a gate that consumes the marker but parks a refire for the next cron tick', () => {
      const verdict = judgeNoCronWaitRepairPath(
        pad(`${CONSUME}
  if (consumed?.kind === "refire" && consumed.request) {
    deps.log("newer repair head admitted; the next scheduled tick will judge it");
    return finalResult;
  }
`),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toEqual(['in-process-refire', 'bounded-refire']);
    });

    it('catches an in-process refire with no attempt bound', () => {
      const verdict = judgeNoCronWaitRepairPath(
        pad(`${CONSUME}
  if (consumed?.kind === "refire" && consumed.request) {
    return runGreenCheckpoint(cfg, deps, { ...opts, candidate: consumed.request.repairHead });
  }
`),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toEqual(['bounded-refire']);
    });

    it('catches a gate with no refire branch at all', () => {
      const verdict = judgeNoCronWaitRepairPath(pad(`${CONSUME}\n  if (consumed?.kind === "settled") { finalResult = consumed.queue; }`));
      expect(verdict.missing).toEqual(['refire-branch', 'in-process-refire', 'bounded-refire']);
    });

    it('sees the split-receiver call form the sibling guard was burned by', () => {
      const verdict = judgeNoCronWaitRepairPath(
        pad(`
  const consumed = await deps
    .consumeFrozenRepairRetestRequest({ judgedRepairHead });
${REFIRE_IN_PROCESS_BOUNDED}`),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.found['consume-call']).toBeGreaterThan(0);
    });

    it('accepts the correctly-shaped path and reports where each property lives', () => {
      const verdict = judgeNoCronWaitRepairPath(pad(`${CONSUME}${REFIRE_IN_PROCESS_BOUNDED}`));
      expect(verdict).toMatchObject({ ok: true, missing: [] });
      expect(Object.keys(verdict.found).sort()).toEqual(
        ['bounded-refire', 'consume-call', 'in-process-refire', 'refire-branch'].sort(),
      );
    });
  });

  describe('executable half — the queue module', () => {
    const fresh = () =>
      createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: ['lib/a.test.ts'], nowMs: T0 });
    const admitted = () =>
      markFrozenRepairAdmitted(fresh(), {
        atMs: T0 + 1,
        actor: 'su-fixer',
        source: { ref: 'staging', sha: C1 },
        fromRepairHead: C,
        toRepairHead: C1,
        paths: ['lib/a.test.ts'],
        unchanged: [],
        blobs: { 'lib/a.test.ts': 'blob-a' },
      });

    it('an admission writes the durable retest marker naming the new head', () => {
      expect(admitted().retestRequested).toEqual({ candidate: C, repairHead: C1, requestedAtMs: T0 + 1 });
    });

    it('a run that judged an OLDER head is told to refire, and the marker survives for it', () => {
      const decision = settleFrozenRepairRetestRequest(admitted(), C);
      expect(decision.kind).toBe('refire');
      expect(decision.request?.repairHead).toBe(C1);
      expect(decision.queue.retestRequested).toBeDefined();
    });

    it('a run that judged the admitted head settles the marker and consumes it', () => {
      const decision = settleFrozenRepairRetestRequest(admitted(), C1);
      expect(decision.kind).toBe('settled');
      expect(decision.queue.retestRequested).toBeUndefined();
    });

    it('a queue with no outstanding admission has nothing to settle', () => {
      expect(settleFrozenRepairRetestRequest(fresh(), C).kind).toBe('none');
    });
  });

  describe('live pins', () => {
    it('green-checkpoint.ts consumes the marker and self-refires in-process, bounded', () => {
      const verdict = judgeNoCronWaitRepairPath(readFileSync(GREEN_CHECKPOINT, 'utf8'));
      expect(verdict.missing).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it(`CLAUDE.md still says "${NO_CRON_WAIT_DOC_PHRASE}"`, () => {
      expect(docStillMakesNoCronWaitClaim(readFileSync(CLAUDE_MD, 'utf8'))).toBe(true);
    });
  });
});
