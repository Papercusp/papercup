/**
 * owner-directive-capture-provenance.integration.test.ts — real-PG proof for P-003 of plan
 * `turn-start-memory-two-class-2026-09-21` (migration 1187).
 *
 * WHY THIS FILE EXISTS. Migration 1186 gave owner_directives its pending|open|dismissed
 * lifecycle, and it was tempting to call P-003 satisfied there — the lifecycle worked, and
 * "was this captured by the hook?" LOOKED answerable from `capture_status = 'pending'`.
 *
 * It is answerable only until the row is promoted, which is the exact moment the question
 * starts mattering. Promotion overwrites 'pending' with 'open', and an agent-recorded row
 * is ALSO 'open' — so after promotion the two are byte-identical in every column that
 * existed. The audit trail was lost precisely when the directive became actionable.
 *
 * So the load-bearing assertion here is not "the column stores a boolean" — it is the
 * CONTROL in the third test: after promotion, `capture_status` is provably identical for a
 * hook-captured and an agent-recorded row, while `captured_by_hook` still separates them.
 * Delete migration 1187's column and derive it from `capture_status` instead, and that
 * control fails — which is what makes this a test of the requirement rather than of the
 * implementation that happens to satisfy it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  dismissOwnerDirective,
  getOwnerDirective,
  promoteOwnerDirective,
  recordOwnerDirective,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive capture provenance (migration 1187)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-capture-provenance-ws';

  beforeAll(async () => {
    db = await createOrgTestDb();
  });

  afterAll(async () => {
    await db?.cleanup?.();
  });

  /** A hook-shaped capture: pending, flagged, carrying the turn ref the hook derives. */
  async function captureViaHook(turnRef: string) {
    return recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-hook',
        sourceTurnRef: turnRef,
        verbatimText: 'ship the thing now',
        recordedBy: 'su-hook-caller',
        captureStatus: 'pending',
        capturedByHook: true,
      },
      db.adminSql,
    );
  }

  /** An agent-shaped record: straight to open, never touched by the hook. */
  async function recordViaAgent(turnRef: string) {
    return recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-agent',
        sourceTurnRef: turnRef,
        verbatimText: 'ship the thing now',
        recordedBy: 'su-agent-caller',
      },
      db.adminSql,
    );
  }

  it('flags a hook capture and leaves an agent-recorded row unflagged', async () => {
    const hooked = await captureViaHook('turn-flagged-1');
    const recorded = await recordViaAgent('turn-unflagged-1');

    expect(hooked.capturedByHook).toBe(true);
    expect(hooked.captureStatus).toBe('pending');

    // The default must be false, not null/undefined: the column is NOT NULL DEFAULT false
    // so an unflagged row is a positive "not the hook", never an absence of information.
    expect(recorded.capturedByHook).toBe(false);
    expect(recorded.captureStatus).toBe('open');
  });

  it('records when and by whom a pending capture was promoted', async () => {
    const row = await captureViaHook('turn-promoted-1');
    expect(row.capturePromotedAtMs ?? null).toBeNull();
    expect(row.capturePromotedBy ?? null).toBeNull();

    const promoted = await promoteOwnerDirective(
      { id: row.id, promotedBy: 'su-promoter' },
      db.adminSql,
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    expect(promoted.row.captureStatus).toBe('open');
    expect(promoted.row.capturePromotedBy).toBe('su-promoter');
    expect(typeof promoted.row.capturePromotedAtMs).toBe('number');
    expect(promoted.row.capturePromotedAtMs!).toBeGreaterThanOrEqual(promoted.row.createdAtMs);

    // Re-read rather than trusting the RETURNING row: the point of the column is that the
    // fact is DURABLE, not that the UPDATE echoed it back once.
    const reread = await getOwnerDirective(row.id, db.adminSql);
    expect(reread?.capturePromotedBy).toBe('su-promoter');
    expect(reread?.capturePromotedAtMs).toBe(promoted.row.capturePromotedAtMs);
  });

  // P-005 / D-014: the `note?` on promote was the plan's single un-waived gap. Before
  // migration 1189 orders:resolve-pending accepted `reason` for BOTH actions but
  // promoteOwnerDirective was called with only { id, promotedBy }, so a note supplied
  // alongside action:'promote' validated and was then SILENTLY DROPPED. These two cases
  // are a matched pair: the first proves the note is stored, the second proves that
  // storage is conditional on a note actually being supplied. Without the second, a
  // column wired to a constant would pass the first.
  it('persists a note supplied at promotion time', async () => {
    const row = await captureViaHook('turn-promoted-note');
    expect(row.capturePromotedNote ?? null).toBeNull();

    const promoted = await promoteOwnerDirective(
      { id: row.id, promotedBy: 'su-promoter', note: 'acting on this now; scoped to the migration only' },
      db.adminSql,
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.row.capturePromotedNote).toBe('acting on this now; scoped to the migration only');

    // Re-read: the column exists so the note is DURABLE, not merely echoed by RETURNING.
    const reread = await getOwnerDirective(row.id, db.adminSql);
    expect(reread?.capturePromotedNote).toBe('acting on this now; scoped to the migration only');
  });

  it('CONTROL: promoting without a note leaves capture_promoted_note NULL', async () => {
    const row = await captureViaHook('turn-promoted-no-note');

    const promoted = await promoteOwnerDirective(
      { id: row.id, promotedBy: 'su-promoter' },
      db.adminSql,
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.row.capturePromotedNote ?? null).toBeNull();

    const reread = await getOwnerDirective(row.id, db.adminSql);
    expect(reread?.capturePromotedNote ?? null).toBeNull();
    // The promotion itself still happened — a null note is not a failed promote.
    expect(reread?.captureStatus).toBe('open');
  });

  it('treats a whitespace-only promotion note as no note', async () => {
    const row = await captureViaHook('turn-promoted-blank-note');

    const promoted = await promoteOwnerDirective(
      { id: row.id, promotedBy: 'su-promoter', note: '   ' },
      db.adminSql,
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    // Stored as NULL, not as a blank string: a reader must not have to distinguish
    // "no note" from "a note made of spaces".
    expect(promoted.row.capturePromotedNote ?? null).toBeNull();
  });

  it('CONTROL: after promotion capture_status cannot tell hook from agent, but the flag can', async () => {
    const hooked = await captureViaHook('turn-control-hook');
    const recorded = await recordViaAgent('turn-control-agent');

    const promoted = await promoteOwnerDirective(
      { id: hooked.id, promotedBy: 'su-promoter' },
      db.adminSql,
    );
    expect(promoted.ok).toBe(true);

    const a = await getOwnerDirective(hooked.id, db.adminSql);
    const b = await getOwnerDirective(recorded.id, db.adminSql);

    // The control: the pre-1187 signal has collapsed. If this assertion ever FAILS, the two
    // rows became distinguishable by capture_status again and this column may be redundant
    // — read that as a prompt to re-derive, not as a flake to silence.
    expect(a?.captureStatus).toBe(b?.captureStatus);
    expect(a?.captureStatus).toBe('open');

    // ...and 1187 is what still answers the question.
    expect(a?.capturedByHook).toBe(true);
    expect(b?.capturedByHook).toBe(false);
  });

  it('keeps hook provenance on a dismissed capture, so dismissals stay auditable', async () => {
    const row = await captureViaHook('turn-dismissed-1');
    const dismissed = await dismissOwnerDirective(
      { id: row.id, reason: 'machine-injected wake, not an owner turn', dismissedBy: 'su-dismisser' },
      db.adminSql,
    );
    expect(dismissed.ok).toBe(true);
    if (!dismissed.ok) return;

    expect(dismissed.row.captureStatus).toBe('dismissed');
    expect(dismissed.row.capturedByHook).toBe(true);
    // A dismissal is not a promotion — the promotion columns must stay empty.
    expect(dismissed.row.capturePromotedAtMs ?? null).toBeNull();
    expect(dismissed.row.capturePromotedBy ?? null).toBeNull();
  });
});
