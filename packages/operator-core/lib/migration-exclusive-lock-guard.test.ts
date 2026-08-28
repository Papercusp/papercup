import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCLUSIVE_LOCK_ACK,
  EXCLUSIVE_LOCK_ENFORCED_FROM,
  findUnacknowledgedExclusiveLock,
} from '../../../scripts/lint-migrations.mjs';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';

const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const sql = (file: string) => readFileSync(resolve(SQL_DIR, file), 'utf8');

/**
 * The real 868 shape — the statement pair every new migration in this family is
 * tempted to copy. Kept as a literal rather than read from 868 so the test still
 * means something if that file is ever archived.
 */
const REAL_OFFENCE = [
  'ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;',
  "UPDATE harness_shared.work_items SET payload = payload || '{}'::jsonb;",
  'ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;',
].join('\n');

/**
 * PERMANENT FALSIFIABILITY CONTROL (never delete).
 *
 * The obvious implementation of this guard is a bare regex over the raw file. It
 * is WRONG, and wrong in the direction that matters: migration 1020 documents in
 * PROSE why it deliberately does NOT disable triggers, so a comment-blind guard
 * reds the one migration in the tree that got this right. Keeping the naive
 * version here as a control means the mask is verified rather than assumed — if
 * someone "simplifies" findUnacknowledgedExclusiveLock into this shape, the
 * `is not comment-blind` case below fails instead of the tree going red.
 */
function naiveCommentBlindDetector(sqlText: string): boolean {
  return /ALTER\s+TABLE[\s\S]*?DISABLE\s+TRIGGER/i.test(sqlText);
}

describe('migration ACCESS EXCLUSIVE acknowledgment guard (EI-21698566084995732)', () => {
  it('CALIBRATION: detects the real 868-shape offence', () => {
    // Without this, every "reads clean" case below could pass simply because the
    // detector never fires at all.
    const hits = findUnacknowledgedExclusiveLock(REAL_OFFENCE);
    expect(hits.map((h) => h.action)).toEqual(['DISABLE', 'ENABLE']);
    expect(hits.every((h) => h.table === 'harness_shared.work_items')).toBe(true);
    expect(hits.every((h) => h.hot)).toBe(true);
  });

  it('CONTROL: the naive comment-blind detector fires on the real offence too', () => {
    // Proves the control is a working instrument, so its silence below is meaningful.
    expect(naiveCommentBlindDetector(REAL_OFFENCE)).toBe(true);
  });

  it('accepts the offence once acknowledged', () => {
    const acknowledged = `-- EXCLUSIVE-LOCK: one-shot repair, table is empty on every live install\n${REAL_OFFENCE}`;
    expect(EXCLUSIVE_LOCK_ACK.test(acknowledged)).toBe(true);
    expect(findUnacknowledgedExclusiveLock(acknowledged)).toEqual([]);
  });

  it('is not comment-blind: prose ABOUT the statement reads clean', () => {
    const prose = [
      '-- NOTE: deliberately NO `ALTER TABLE ... DISABLE TRIGGER USER`, unlike 868.',
      '-- That statement needs ACCESS EXCLUSIVE on harness_shared.work_items.',
      "UPDATE harness_shared.work_items SET payload = payload || '{}'::jsonb;",
    ].join('\n');

    expect(findUnacknowledgedExclusiveLock(prose)).toEqual([]);
    // The control disagrees — which is the whole point of keeping it.
    expect(naiveCommentBlindDetector(prose)).toBe(true);
  });

  it('is not string-blind: the statement inside a string literal reads clean', () => {
    const literal =
      "INSERT INTO harness_shared.audit_log(note) VALUES ('ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER');";
    expect(findUnacknowledgedExclusiveLock(literal)).toEqual([]);
  });

  it('sees into DO $$ bodies, where the statement really executes', () => {
    const inBody = [
      'DO $body$',
      'BEGIN',
      '  ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;',
      'END $body$;',
    ].join('\n');
    const hits = findUnacknowledgedExclusiveLock(inBody);
    expect(hits).toHaveLength(1);
    expect(hits[0].action).toBe('DISABLE');
  });

  it('matches the ONLY / IF EXISTS / named-trigger spellings', () => {
    const variants = [
      'ALTER TABLE ONLY harness_shared.work_items DISABLE TRIGGER USER;',
      'ALTER TABLE IF EXISTS harness_shared.plan_items DISABLE TRIGGER ALL;',
      'ALTER TABLE harness_shared.work_items DISABLE TRIGGER emit_change_notify_trg;',
    ].join('\n');
    expect(findUnacknowledgedExclusiveLock(variants)).toHaveLength(3);
  });

  it('flags a cold table too, but does not call it hot', () => {
    const cold = 'ALTER TABLE harness_shared.migration_reservations DISABLE TRIGGER USER;';
    const hits = findUnacknowledgedExclusiveLock(cold);
    expect(hits).toHaveLength(1);
    expect(hits[0].hot).toBe(false);
  });

  it('an empty ack line does NOT satisfy the marker', () => {
    expect(EXCLUSIVE_LOCK_ACK.test('-- EXCLUSIVE-LOCK:')).toBe(false);
    expect(EXCLUSIVE_LOCK_ACK.test('-- EXCLUSIVE-LOCK:   ')).toBe(false);
  });

  describe('pre-apply refusal (boot apply and db:migrate)', () => {
    const args = (filename: string, sqlText: string) => ({
      filename,
      sqlText,
      sqlDir: SQL_DIR,
      isAncestorOfHead: () => true,
    });

    it('refuses an unacknowledged offence at or above the floor', () => {
      expect(() =>
        assertMigrationPassesPreApplyLints(args(`${EXCLUSIVE_LOCK_ENFORCED_FROM}-bad.sql`, REAL_OFFENCE)),
      ).toThrow(/EXCLUSIVE-LOCK/);
    });

    it('applies it once acknowledged', () => {
      expect(() =>
        assertMigrationPassesPreApplyLints(
          args(
            `${EXCLUSIVE_LOCK_ENFORCED_FROM}-ok.sql`,
            `-- EXCLUSIVE-LOCK: table is empty on every live install\n${REAL_OFFENCE}`,
          ),
        ),
      ).not.toThrow();
    });

    it('grandfathers applied history below the floor', () => {
      expect(() =>
        assertMigrationPassesPreApplyLints(args(`${EXCLUSIVE_LOCK_ENFORCED_FROM - 1}-legacy.sql`, REAL_OFFENCE)),
      ).not.toThrow();
    });
  });

  describe('the tree as it actually stands', () => {
    it('1020 reads clean — it documents the hazard in prose and does not take the lock', () => {
      const text = sql('1020-retire-cross-harness-legacy-needs-human-residue.sql');
      expect(text).toMatch(/DISABLE TRIGGER/); // the prose really is present
      expect(findUnacknowledgedExclusiveLock(text)).toEqual([]);
    });

    it('868 really does take the lock, and is below the floor', () => {
      const text = sql('868-preserve-legacy-human-park-status.sql');
      expect(findUnacknowledgedExclusiveLock(text).length).toBeGreaterThan(0);
      expect(868).toBeLessThan(EXCLUSIVE_LOCK_ENFORCED_FROM);
    });

    it('the floor sits above every migration carrying the shape, so nothing on disk is retro-red', () => {
      // Guards the boundary choice itself: if someone lowers the floor, this names
      // the applied-and-immutable files that would go red.
      const retroRed = readFileSync(resolve(SQL_DIR, '868-preserve-legacy-human-park-status.sql'), 'utf8');
      expect(findUnacknowledgedExclusiveLock(retroRed).length).toBeGreaterThan(0);
      expect(EXCLUSIVE_LOCK_ENFORCED_FROM).toBeGreaterThan(1021);
    });
  });
});
