/**
 * owner-directive-disposition-readback.integration.test.ts — real-PG proof for P-005 of
 * plan `turn-start-memory-two-class-2026-09-21`, covering the four clauses that item
 * actually owns once the D-035 clause clobber was repaired (see D-039):
 *
 *   AUTO-BAR-R-3-P-005 "A freshly captured directive reads back in a state that is distinct
 *                       from the promoted, dismissed and finished states."
 *                      (This quote was STALE until 2026-09-22: it still carried the clause's
 *                       pre-rev-8 text about promote/dismiss existing and a dismissed row
 *                       staying queryable. That older sentence describes R-6's subject, and
 *                       leaving it here is what got the case below mislabelled `R-3:`.)
 *   AUTO-BAR-R-4-P-005 "Promoting a captured directive leaves it readable in the open
 *                       standing state."
 *   AUTO-BAR-R-5-P-005 "A dismissal submitted with an absent or empty reason is refused
 *                       and leaves the directive in the state it already had."
 *   AUTO-BAR-R-6-P-005 "After a directive is dismissed with a reason, a read still returns
 *                       that directive, in the dismissed state, carrying the reason given."
 *
 * WHY THIS FILE EXISTS, given resolve-pending.test.ts already passes 11/11.
 * That file is a MOCK-level proof and says so in its own docstring: it asserts
 * `dismissOwnerDirective` was never called as a PROXY for "leaves the directive in the
 * state it already had", because the absence of a write is not observable on the returned
 * envelope. A proxy is the right call there — it has no database. But it means the claim
 * every one of these four clauses actually makes, which is about what a subsequent READ
 * returns, was never once observed. Every clause here says "…is readable / a read still
 * returns / leaves it in the state it had". None of that is an assertion about a return
 * value; all of it is an assertion about durable state.
 *
 * So this file deliberately does NOT re-test the handler's refusal logic (proven, mocked,
 * fast). It tests only what a mock cannot reach: that the row in Postgres afterwards is
 * what the clause says it is.
 *
 * WHAT IT DOES NOT COVER (disclosed rather than implied):
 *  - The tool-handler boundary itself. R-5's empty/whitespace refusal lives in the
 *    `orders:resolve-pending` handler, and `dismissOwnerDirective` beneath it does no
 *    reason validation at all — resolve-pending.test.ts owns that half and is the reason
 *    the whitespace case is not duplicated here. What this file adds for R-5 is the other
 *    half of the sentence, at the layer where "the state it already had" is a real thing:
 *    a rejected write leaves the stored row byte-for-byte as it was.
 *  - Reason-content validation at the store layer. There is none by design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  dismissOwnerDirective,
  dispositionOwnerDirective,
  getOwnerDirective,
  listOwnerDirectives,
  ownerDirectiveState,
  promoteOwnerDirective,
  recordOwnerDirective,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive disposition read-back (P-005)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-readback-ws';

  async function recordPending(turnRef: string, text: string): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-readback',
        sourceTurnRef: turnRef,
        verbatimText: text,
        recordedBy: 'su-readback-test',
        captureStatus: 'pending',
      },
      db.adminSql,
    );
    return row.id;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('R-3 / CALIBRATION: a freshly captured row reads back in a state DISTINCT from promoted, dismissed and finished', async () => {
    const id = await recordPending('turn-calibration', 'a freshly captured owner turn');
    const row = await getOwnerDirective(id, db.adminSql);
    expect(row).not.toBeNull();
    // The whole file compares a state BEFORE a transition with the state AFTER it. If the
    // starting state were already the target state, every assertion below would pass
    // without the transition doing anything at all.
    expect(ownerDirectiveState(row!)).toBe('pending');
    // AUTO-BAR-R-3-P-005 is "reads back in a state DISTINCT from the promoted, dismissed and
    // finished states" — distinctness is the claim, so assert it rather than inferring it
    // from the single equality above. Naming the three states explicitly also means this
    // case fails, instead of silently weakening, if 'pending' is ever merged into one of
    // them or a fourth decided state is added without revisiting R-3.
    expect(['open', 'dismissed', 'finished']).not.toContain(ownerDirectiveState(row!));
  });

  it('R-4: promoting a captured directive leaves it READABLE in the open standing state', async () => {
    const id = await recordPending('turn-promote', 'please carry out the thing');
    expect(ownerDirectiveState((await getOwnerDirective(id, db.adminSql))!)).toBe('pending');

    const result = await promoteOwnerDirective(
      { id, promotedBy: 'su-readback-test', note: '  carried under WI-readback  ' },
      db.adminSql,
    );
    expect(result.ok).toBe(true);

    // The clause says "readable", so the proof is a SECOND, independent read — not the row
    // handed back by the writer, which would still pass if the write were never committed.
    const readBack = await getOwnerDirective(id, db.adminSql);
    expect(readBack).not.toBeNull();
    expect(ownerDirectiveState(readBack!)).toBe('open');
    expect(readBack!.capturePromotedAtMs).toBeGreaterThan(0);
    expect(readBack!.capturePromotedBy).toBe('su-readback-test');
    // Migration 1189 storage: the promotion note survives the round trip, TRIMMED.
    expect(readBack!.capturePromotedNote).toBe('carried under WI-readback');
  });

  it('R-6: after a dismissal with a reason, a read still returns the directive, dismissed, CARRYING the reason', async () => {
    const id = await recordPending('turn-dismiss', 'thinking out loud, not an order');
    const reason = 'owner was musing; no action implied';

    expect((await dismissOwnerDirective({ id, reason, dismissedBy: 'su-readback-test' }, db.adminSql)).ok).toBe(
      true,
    );

    const readBack = await getOwnerDirective(id, db.adminSql);
    expect(readBack).not.toBeNull();
    expect(ownerDirectiveState(readBack!)).toBe('dismissed');
    // "carrying the reason given" is the half that makes a dismissal auditable rather than
    // a silent delete. A dismissal that forgot its reason would still read as 'dismissed'.
    expect(readBack!.captureDismissalReason).toBe(reason);
    expect(readBack!.captureDismissedBy).toBe('su-readback-test');
    // The verbatim owner text is never destroyed by a dismissal.
    expect(readBack!.verbatimText).toBe('thinking out loud, not an order');
  });

  // Labelled R-6, not R-3: "a dismissed row stays queryable rather than being deleted" is
  // R-6's subject (a dismissed directive stays READABLE). It sat under `R-3:` because the
  // header above quoted R-3's pre-rev-8 clause text; R-3 is now proved by the first case.
  // This is the LIST-read half of R-6 and is deliberately kept separate from the by-id half.
  it('R-6 (list read): a dismissed row stays QUERYABLE through the list read rather than being deleted', async () => {
    const id = await recordPending('turn-still-listed', 'a turn that will be dismissed');
    expect(
      (await dismissOwnerDirective({ id, reason: 'not a directive', dismissedBy: 'su-readback-test' }, db.adminSql))
        .ok,
    ).toBe(true);

    // The distinction that matters is deletion vs. state change, and only a LIST read can
    // tell them apart: getOwnerDirective(id) returning a row proves the row exists, but an
    // agent discovers directives through the list, so a row absent from it is functionally
    // deleted even while present in the table.
    const listed = await listOwnerDirectives({ workspaceId, limit: 200 }, db.adminSql);
    const found = listed.find((r) => r.id === id);
    expect(found, 'dismissed directive must remain in the list read').toBeDefined();
    expect(ownerDirectiveState(found!)).toBe('dismissed');
  });

  it('R-5: a REFUSED transition leaves the stored row exactly in the state it already had', async () => {
    const id = await recordPending('turn-refused', 'a turn resolved exactly once');
    const firstReason = 'the original, durable reason';
    expect(
      (await dismissOwnerDirective({ id, reason: firstReason, dismissedBy: 'su-readback-test' }, db.adminSql)).ok,
    ).toBe(true);

    const before = await getOwnerDirective(id, db.adminSql);

    // A second resolution is refused because the row is no longer pending. The clause's
    // load-bearing half is what the STORE looks like afterwards: a refusal that had already
    // written, then reported an error, would satisfy `ok:false` and still be the regression
    // that matters.
    const second = await dismissOwnerDirective(
      { id, reason: 'a different reason that must never be stored', dismissedBy: 'su-other-agent' },
      db.adminSql,
    );
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe('not_pending');

    const promoteAfter = await promoteOwnerDirective({ id, promotedBy: 'su-other-agent' }, db.adminSql);
    expect(promoteAfter.ok).toBe(false);
    expect(promoteAfter.ok === false && promoteAfter.error).toBe('not_pending');

    const after = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(after!)).toBe('dismissed');
    expect(after!.captureDismissalReason).toBe(firstReason);
    expect(after!.captureDismissedBy).toBe('su-readback-test');
    expect(after!.captureDismissedAtMs).toBe(before!.captureDismissedAtMs);
    // Nothing leaked from the refused promotion either.
    expect(after!.capturePromotedAtMs ?? null).toBeNull();
  });

  /**
   * DISPOSITION MUST RESOLVE A PENDING CAPTURE — the deadlock guard.
   *
   * dispositionOwnerDirective once wrote only the disposition_* columns. Because
   * deriveState() gives capture_status priority, a directive captured pending and then
   * dispositioned read back as state='pending' forever, and the obligation provider
   * (which selects on capture_status alone) re-emitted "[DUE] promote or dismiss" into
   * every agent's Orientation in the workspace.
   *
   * It was UNRECOVERABLE, which is what makes it worth a durable guard rather than a
   * tidy-up: promoteOwnerDirective and dismissOwnerDirective both carry
   * `AND dispositioned_at IS NULL`, so the only two verbs able to resolve a capture
   * could never match the row again. Every agent that followed the obligation's own
   * instruction was told to run a tool that provably could not work. Observed live on
   * papercusp-workspace directives #86/#87 (answered 2026-09-22T14:58Z, still nagging
   * 5.5h later); migration 1196 releases the rows that reached that state beforehand.
   */
  it('DEADLOCK GUARD: dispositioning a still-PENDING capture resolves it, so the row cannot strand', async () => {
    const id = await recordPending('turn-disposition-unsticks', 'please go and do the thing');
    // Calibration, per this file's convention: prove the starting state is the one whose
    // transition is under test, or the assertions below could pass without it happening.
    expect(ownerDirectiveState((await getOwnerDirective(id, db.adminSql))!)).toBe('pending');

    const result = await dispositionOwnerDirective(
      { id, status: 'done', note: 'carried out under the readback test', dispositionedBy: 'su-readback-test' },
      db.adminSql,
    );
    expect(result.ok).toBe(true);

    const readBack = await getOwnerDirective(id, db.adminSql);
    // The regression this guards: state stuck at 'pending' despite a recorded disposition.
    expect(ownerDirectiveState(readBack!)).not.toBe('pending');
    expect(readBack!.dispositionStatus).toBe('done');
    // The capture was resolved by PROMOTION, not dismissal: acting on an order asserts it
    // was genuine, whereas 'dismissed' would claim it was never a directive at all.
    expect(readBack!.captureStatus).toBe('open');
    expect(readBack!.capturePromotedAtMs).toBeGreaterThan(0);
    expect(readBack!.capturePromotedBy).toBe('su-readback-test');
    // The owner's words are never touched by any of this.
    expect(readBack!.verbatimText).toBe('please go and do the thing');
  });

  it('DEADLOCK GUARD: a DECLINED directive promotes too — refusing an order is not denying it was one', async () => {
    const id = await recordPending('turn-declined-unsticks', 'do the risky thing right now');
    expect(ownerDirectiveState((await getOwnerDirective(id, db.adminSql))!)).toBe('pending');

    expect(
      (
        await dispositionOwnerDirective(
          { id, status: 'declined', note: 'consciously refused: out of scope', dispositionedBy: 'su-readback-test' },
          db.adminSql,
        )
      ).ok,
    ).toBe(true);

    const readBack = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(readBack!)).not.toBe('pending');
    // 'declined' is a conscious refusal of a REAL order, so the capture is promoted, not
    // dismissed — collapsing the two would erase the distinction the audit trail exists for.
    expect(readBack!.captureStatus).toBe('open');
    expect(readBack!.captureDismissalReason ?? null).toBeNull();
  });

  it('DEADLOCK GUARD: dispositioning never overwrites a capture that was ALREADY resolved', async () => {
    const id = await recordPending('turn-already-promoted', 'a turn promoted before it was closed');
    expect((await promoteOwnerDirective({ id, promotedBy: 'su-first-promoter', note: 'promoted first' }, db.adminSql)).ok).toBe(true);
    const before = await getOwnerDirective(id, db.adminSql);

    expect(
      (
        await dispositionOwnerDirective(
          { id, status: 'done', note: 'closed afterwards', dispositionedBy: 'su-later-closer' },
          db.adminSql,
        )
      ).ok,
    ).toBe(true);

    // The CASE guards must be inert on an already-resolved capture: the original promoter
    // and timestamp are provenance, and a disposition silently restamping them would
    // misattribute who judged the turn genuine.
    const after = await getOwnerDirective(id, db.adminSql);
    expect(after!.capturePromotedBy).toBe('su-first-promoter');
    expect(after!.capturePromotedNote).toBe('promoted first');
    expect(after!.capturePromotedAtMs).toBe(before!.capturePromotedAtMs);
    expect(after!.dispositionStatus).toBe('done');
  });
});
