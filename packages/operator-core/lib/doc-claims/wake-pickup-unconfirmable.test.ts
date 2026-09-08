/**
 * A wake fan cannot report that its target picked up (EI-22733985246154315) — sibling of
 * `gate-candidate-ref.test.ts`, same P-004 doc-claims family.
 *
 * WHAT WENT WRONG. `WakeRecipientsResult.pickupConfirmed` was typed `boolean` while every
 * producer returned the literal `false` — necessarily, because `wakeRecipients` returns at
 * ENQUEUE time, before the target could take a turn. `release:checkpoint-run` nonetheless
 * gated a gate-ownership stand-down on `wake.pickupConfirmed === true`, and a unit test
 * mocked that value to exercise it. So the branch was unreachable in production AND green in
 * CI: the mock manufactured the only input that could enter it. The wake substrate has no
 * execution handshake, so callers can only observe pickup afterwards (a fresh lastActiveAt /
 * checkpoint / lastProgressAt that post-dates the wake).
 *
 * THE FIXTURE CONTROLS ARE LOAD-BEARING. Once the live assertions below go green they stop
 * being evidence that the detector works — a broken judge and a clean tree produce the same
 * passing run. Each control reproduces a shape that MUST be caught, including the exact two
 * that shipped together here. They also let this guard prove itself without mutating the
 * shared tree (the tier-2 row of the mutation-probe table in CLAUDE.md).
 *
 * SCOPE, STATED HONESTLY: this pins the three files where the defect actually lived. It is not
 * a repo-wide sweep, and a `pickupConfirmed === true` comparison introduced in some other module
 * would not be caught here — the narrowed `false` type is what covers that case, by making the
 * comparison a compile error wherever it is written.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeWakePickupUnconfirmable } from './wake-pickup-unconfirmable';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const INBOX_WAKE = 'packages/operator-core/lib/agent-tools/coordination/inbox-wake.ts';
const CHECKPOINT_RUN = 'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts';
const CHECKPOINT_RUN_TEST = 'packages/operator-core/lib/agent-tools/release/checkpoint-run.test.ts';

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('wake pickup is unconfirmable at the enqueue seam', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the widened `boolean` declaration that permits the dead branch', () => {
      const v = judgeWakePickupUnconfirmable(`
        export interface WakeRecipientsResult {
          woken: number;
          pickupConfirmed?: boolean;
        }
      `);
      expect(v.ok).toBe(false);
      expect(v.booleanDeclSites).toHaveLength(1);
      expect(v.violations.join('\n')).toMatch(/typed as the literal `false`/);
    });

    it('catches the `=== true` comparison — the branch production can never enter', () => {
      const v = judgeWakePickupUnconfirmable(`
        if (wake.pickupConfirmed === true && !criticalProgressLease.expired) {
          return standDown();
        }
      `);
      expect(v.ok).toBe(false);
      expect(v.confirmedComparisonSites).toHaveLength(1);
      expect(v.violations.join('\n')).toMatch(/dead branch/);
    });

    it('catches the comparison written in reverse (`true === wake.pickupConfirmed`)', () => {
      const v = judgeWakePickupUnconfirmable('if (true === wake.pickupConfirmed) standDown();');
      expect(v.ok).toBe(false);
      expect(v.confirmedComparisonSites).toHaveLength(1);
    });

    it('catches the test mock that made the dead branch look tested', () => {
      const v = judgeWakePickupUnconfirmable(`
        const wakeRecipients = vi.fn(async () => ({
          woken: 1,
          pickupConfirmed: true,
        }));
      `);
      expect(v.ok).toBe(false);
      expect(v.confirmedLiteralSites).toHaveLength(1);
      expect(v.violations.join('\n')).toMatch(/manufactures an input production cannot produce/);
    });

    it('reports the offending line number and names the subject', () => {
      const v = judgeWakePickupUnconfirmable('const a = 1;\nif (r.pickupConfirmed === true) {}\n', {
        subject: 'some/file.ts',
      });
      expect(v.confirmedComparisonSites[0]?.line).toBe(2);
      expect(v.violations[0]).toContain('some/file.ts: line 2');
    });

    it('does NOT flag the honest shapes: a `false` literal, a `false` type, or a falsy read', () => {
      const v = judgeWakePickupUnconfirmable(`
        pickupConfirmed?: false;
        const out = { woken, pickupConfirmed: false };
        const confirmed = r.pickupConfirmed ?? false;
        if (!wake.pickupConfirmed) proceed();
      `);
      expect(v.violations).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it('ignores the forbidden shapes when they appear in PROSE, not code', () => {
      // The rule cannot be explained without quoting what it forbids — including in the
      // very files it judges, whose comments cite the removed branch verbatim.
      const v = judgeWakePickupUnconfirmable(`
        // Do not gate on pickupConfirmed === true; no producer returns pickupConfirmed: true.
        /* The field was once declared pickupConfirmed?: boolean, which is what allowed it. */
        const out = { pickupConfirmed: false };
      `);
      expect(v.ok).toBe(true);
    });
  });

  describe('the live tree', () => {
    it(`${INBOX_WAKE} types pickupConfirmed as \`false\` and returns only that`, () => {
      const v = judgeWakePickupUnconfirmable(read(INBOX_WAKE), { subject: INBOX_WAKE });
      expect(v.violations).toEqual([]);
    });

    it(`${CHECKPOINT_RUN} has no confirmed-pickup stand-down branch`, () => {
      const v = judgeWakePickupUnconfirmable(read(CHECKPOINT_RUN), { subject: CHECKPOINT_RUN });
      expect(v.violations).toEqual([]);
    });

    it(`${CHECKPOINT_RUN_TEST} never mocks a confirmed pickup`, () => {
      const v = judgeWakePickupUnconfirmable(read(CHECKPOINT_RUN_TEST), { subject: CHECKPOINT_RUN_TEST });
      expect(v.violations).toEqual([]);
    });

    it('the declaration really is the literal type, not merely free of `boolean`', () => {
      // Guards against a repair that deletes the field instead of narrowing it: the type is
      // what makes an `=== true` comparison a compile error anywhere in the tree.
      expect(read(INBOX_WAKE)).toMatch(/pickupConfirmed\?:\s*false;/);
    });

    it('the wake fan still reports the queue count it CAN answer', () => {
      // The fix must not have thrown out the honest signal alongside the dishonest one:
      // `woken`/`queued` remain real (durable deliveries enqueued), they just are not pickup.
      const src = read(INBOX_WAKE);
      expect(src).toMatch(/queued:\s*woken/);
      expect(src).toMatch(/pickupConfirmed:\s*false/);
    });
  });
});
