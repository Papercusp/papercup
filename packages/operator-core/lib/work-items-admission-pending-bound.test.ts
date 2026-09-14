import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  ADMISSION_CREATE_BYPASSES,
  ADMISSION_FAIL_OPEN_TICKS,
  DEFAULT_PROMOTER_TICK_MINUTES,
  admissionFailOpenSec,
  admissionPendingCreateRemedy,
  admissionPendingExplanation,
  admissionPromoterTickSec,
  admissionPromoterUnhealthy,
} from './work-items-admission';

/**
 * EI-21973318733042066 — the `admission-pending` claim floor is a WAIT, and it has to say so
 * with a number.
 *
 * A launched independent reviewer was briefed to claim a review work-item created seconds
 * earlier as its first act. `work_items:claim` refused twice with `not_claimable /
 * admission-pending`, whose whole explanation was "wait for admitted/unreviewed" — no bound,
 * no remedy. MEASURED on this box: the promoter is a 30-minute durable cron, and across 289
 * items admitted in the 48h before the report, pending→admitted ran p50 978s / p95 2003s /
 * max 4531s. The reporter's own item sat pending 22.5 minutes, which outlived the entire
 * 9-minute lifetime of the agent it was created for — so "retry until it clears" was never
 * available to the one agent that would ever touch it.
 *
 * These tests pin the two properties that make the refusal actionable, and both are pinned
 * as DERIVATIONS rather than as text: a hand-written "30 minutes" in the explanation is a
 * second copy of a truth the routine owns, and would drift the first time the cadence moved.
 */
describe('admission-pending states a bound, derived from the promoter cadence', () => {
  it('the explanation derives BOTH numbers from the tick — it does not restate them', () => {
    // The parametrised call is the whole point: a hardcoded "30-minute" survives the default
    // assertion below and fails here, which is the only difference that matters.
    const sevenMinuteTick = admissionPendingExplanation(7);
    expect(sevenMinuteTick).toContain('7-minute');
    expect(sevenMinuteTick).toContain(`${ADMISSION_FAIL_OPEN_TICKS * 7} min`);
    expect(sevenMinuteTick).not.toContain('30-minute');

    const live = admissionPendingExplanation();
    expect(live).toContain(`${DEFAULT_PROMOTER_TICK_MINUTES}-minute`);
    expect(live).toContain(`${ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES} min`);
  });

  it('it says the floor CLEARS ON ITS OWN — the distinction the reporter could not make', () => {
    const live = admissionPendingExplanation();
    // "not yet" vs "never" is the actual decision a refused caller has to make. Every other
    // permanent floor (observation-lane, federation-detector, already-completed) reads the
    // same shape, so the temporal ones have to say which they are.
    expect(live).toMatch(/CLEARS ON ITS\s+OWN/);
    expect(live).toContain('not a permanent');
    // And it must not be silently reassuring: waiting out most of a tick is usually wrong for
    // a short-lived agent, which is exactly what the reporter discovered the expensive way.
    expect(live).toMatch(/outlives|wrong move/);
  });

  it('the two second-bounds agree with the constants they are derived from', () => {
    expect(admissionPromoterTickSec()).toBe(DEFAULT_PROMOTER_TICK_MINUTES * 60);
    expect(admissionFailOpenSec()).toBe(ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES * 60);
    // Parametrised, so a fixed return value cannot satisfy both rows.
    expect(admissionPromoterTickSec(7)).toBe(420);
    expect(admissionFailOpenSec(7)).toBe(ADMISSION_FAIL_OPEN_TICKS * 420);
  });

  /**
   * ADMISSION_FAIL_OPEN_TICKS is a claim ABOUT `runAdmissionFailOpen`, which computes its own
   * cutoff. Rung 2 of the derived-truth ladder: the honest bound we publish to a refused
   * caller cannot be a number someone remembered — if that runner starts admitting after a
   * different number of ticks, this fails and forces the constant to follow it.
   */
  it('the fail-open ceiling matches the cutoff the runner actually applies', () => {
    const runner = fs.readFileSync(new URL('./work-items-admission-promoter.ts', import.meta.url), 'utf8');
    expect(
      runner,
      'runAdmissionFailOpen must still cut off at ADMISSION_FAIL_OPEN_TICKS * tickMinutes — if it ' +
        'changed, update ADMISSION_FAIL_OPEN_TICKS rather than this assertion, because the claim ' +
        "path publishes that number to callers as the wait's ceiling",
    ).toContain(`${ADMISSION_FAIL_OPEN_TICKS} * tickMinutes * 60_000`);
  });
});

describe('EI-22166155287498355: the retry bound is promoter-health-aware, and always fail-open', () => {
  it('an empty workspaceId short-circuits to false without touching the DB', async () => {
    await expect(admissionPromoterUnhealthy('')).resolves.toBe(false);
  });

  it('a DB/query problem never throws — it resolves false (fail-open, same posture as loadOwnAuthorPubkeys)', async () => {
    // No testcontainers DB is wired up in this plain unit file, so getOrgPg()/the query
    // itself is expected to fail here. The whole point of this test is that the failure
    // is swallowed rather than propagated: an unreadable health signal must never make
    // an admission-pending refusal look WORSE than the caller already sees.
    await expect(admissionPromoterUnhealthy('some-workspace-id')).resolves.toBe(false);
  });
});

describe('admission-pending names the create-time remedy that already existed', () => {
  it('scopes duplicate screening to the work-item claim instead of inventing an agent-launch delay', () => {
    const explanation = admissionPendingExplanation();
    expect(explanation).toContain('WORK-ITEM CLAIM');
    expect(explanation).toContain('does not block opening an agent or fleet process');
    expect(explanation).toContain('launch and queue admission are separate capabilities');
    expect(explanation).toContain('still needs claimable or validly pre-assigned work');
  });

  it('the remedy is rendered from the bypass record, so a new bypass cannot be left out', () => {
    const remedy = admissionPendingCreateRemedy();
    for (const bypass of ADMISSION_CREATE_BYPASSES) {
      expect(remedy, `${bypass.reason} is a live create-time bypass but the remedy omits it`).toContain(
        bypass.condition,
      );
    }
  });

  it('assign_to is in the record — the reporter proposed it as a NEW mechanism', () => {
    // The report's own suggested fix was "an item whose creator names a specific intended owner
    // could bypass screening". That is bypass:explicit-assignment, which already existed and was
    // the second most-used admission path on this box (235 uses in the 3 days before the report).
    // Nothing on the refusal path said so. This is the negative control for the loop above: with
    // an empty record every `for` assertion passes vacuously.
    expect(ADMISSION_CREATE_BYPASSES.length).toBeGreaterThanOrEqual(4);
    const reasons = ADMISSION_CREATE_BYPASSES.map((b) => b.reason);
    expect(reasons).toContain('bypass:explicit-assignment');
    expect(admissionPendingCreateRemedy()).toContain('assign_to');
  });

  it('routes plan fleets and fixed ad-hoc work without overstating assign_to authority', () => {
    const remedy = admissionPendingCreateRemedy();
    expect(remedy).toContain('plans:start then fleet:launch-on-plan');
    expect(remedy).toContain('capability:launch-agent');
    expect(remedy).toContain('create-time admission bypasses, not blanket authority');
    expect(remedy).toContain('live fleet scope');
    expect(remedy).toContain('files the item unassigned');
    expect(remedy).toContain('ALREADY-pending item');
    expect(remedy).not.toContain('re-file it');
  });

  it('every recorded reason is still minted by the create path', () => {
    // The `AdmissionBypassReason` type already fails compilation if _create-core drops a reason
    // the record declares. This catches the other direction — a reason RENAMED in the record
    // while the create path keeps writing the old durable `admitted_by` string.
    const createCore = fs.readFileSync(
      new URL('./agent-tools/work_items/_create-core.ts', import.meta.url),
      'utf8',
    );
    for (const bypass of ADMISSION_CREATE_BYPASSES) {
      expect(createCore, `${bypass.reason} is declared but never minted by the create path`).toContain(
        `'${bypass.reason}'`,
      );
    }
  });
});
