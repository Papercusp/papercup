/**
 * EI-20218215840085630 — `work_items:checkpoint`'s description must not tell
 * callers a big plain shrink is stopped when the code retries it as a safe append.
 *
 * The FIXTURE CONTROLS are load-bearing, for the reason the doc-claims siblings
 * state: once the live assertion goes green it stops being evidence that the
 * detector works at all. Each fixture reproduces a shape that MUST be caught —
 * including the exact pre-fix wording this item was filed against.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import checkpointTool from '../agent-tools/work_items/checkpoint';
import { judgeCheckpointShrinkClaim, hasShrinkRetry } from './checkpoint-shrink-claim';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CHECKPOINT_SRC = join(REPO_ROOT, 'packages/operator-core/lib/agent-tools/work_items/checkpoint.ts');

/** A source shape that HAS the auto-append retry (EI-20232176364474286). */
const WITH_RETRY = `
  if (res.blockedReason?.includes('plain replace would shrink') && isPlainReplace && !wantsConfirmShrink) {
    preservePriorOnShrink = true;
    res = await setWorkItemCheckpointWithPrior(ref, body, { transform });
  }
`;

/** The same file with the retry taken out — a plain shrink would fail the call. */
const WITHOUT_RETRY = `
  if (res.blockedReason) {
    return { ok: false, errorCode: 'shrink_blocked' };
  }
`;

describe('EI-20218215840085630: checkpoint shrink claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact pre-fix wording: retry present, description says BLOCK', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'Writes verify-read and block suspicious shrink; peer-held/terminal-item writes are refused while explicit clears remain allowed.',
        WITH_RETRY,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.retryPresent).toBe(true);
      expect(verdict.blockedClaims).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/retries a refused plain shrink/);
    });

    it('catches the deployed wording too ("a suspicious shrink can be BLOCKED")', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'Writes are verify-read — a suspicious shrink can be BLOCKED; see `returns`.',
        WITH_RETRY,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.blockedClaims).toHaveLength(1);
    });

    it('catches the REVERSE drift: retry removed while the description still promises preservation', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'Writes verify-read; a big shrink keeps prior under your note; peer-held writes are refused.',
        WITHOUT_RETRY,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.retryPresent).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no longer detectable/);
    });

    it('accepts a description that matches the code (retry present, preservation claimed)', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'Writes verify-read; a big shrink keeps prior under your note; peer-held/terminal-item writes are refused while explicit clears remain allowed.',
        WITH_RETRY,
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.preserveClaims).toHaveLength(1);
    });

    it('accepts a blocked claim when the code really does block (no retry)', () => {
      const verdict = judgeCheckpointShrinkClaim('Writes verify-read and block suspicious shrink.', WITHOUT_RETRY);
      expect(verdict.ok).toBe(true);
    });

    it('does not read an unrelated "refused" clause as a claim about shrink', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'A big shrink keeps prior under your note; peer-held writes are refused.',
        WITH_RETRY,
      );
      expect(verdict.blockedClaims).toHaveLength(0);
      expect(verdict.ok).toBe(true);
    });

    it('does not treat `confirmShrink:true` in the replacement recipe as a shrink claim', () => {
      const verdict = judgeCheckpointShrinkClaim(
        'Full body+rows replacement requires `append:false, rowsMode:"replace", confirmShrink:true, confirmRetire:true`.',
        WITH_RETRY,
      );
      expect(verdict.shrinkClauses).toHaveLength(0);
      expect(verdict.ok).toBe(true);
    });

    it('is not fooled by a retry that exists only in COMMENTS', () => {
      const commentOnly = `
        // The refused write used to set preservePriorOnShrink = true when
        // blockedReason included 'plain replace would shrink'. That retry is gone.
        return { ok: false, errorCode: 'shrink_blocked' };
      `;
      expect(hasShrinkRetry(commentOnly)).toBe(false);
    });

    it('requires BOTH halves of the retry — the trigger alone is not enough', () => {
      expect(hasShrinkRetry("if (res.blockedReason?.includes('plain replace would shrink')) return fail();")).toBe(
        false,
      );
      expect(hasShrinkRetry('preservePriorOnShrink = true;')).toBe(false);
    });
  });

  describe('live', () => {
    const source = readFileSync(CHECKPOINT_SRC, 'utf8');

    it('calibration: the real checkpoint.ts still carries the auto-append retry', () => {
      expect(hasShrinkRetry(source)).toBe(true);
    });

    it("the live tool's description agrees with what the code does to a big shrink", () => {
      const verdict = judgeCheckpointShrinkClaim(checkpointTool.description ?? '', source);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });
});
