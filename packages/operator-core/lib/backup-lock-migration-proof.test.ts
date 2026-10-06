import { describe, expect, it } from 'vitest';
import { describeConflicts, findBackupLockConflicts, normalizeMigrationSql } from './backup-lock-migration-proof';

// WI-10003357 — the relation-scoped proof that lets boot apply pending
// migrations while a backup still holds the migration rendezvous. A false
// "safe" here would let DDL collide with a running pg_dump, so every case
// that must WAIT is pinned explicitly.
describe('findBackupLockConflicts', () => {
  const pending = (sqlText: string) => [{ file: '1228-x.sql', sqlText }];

  it('is safe when the migration names no locked relation (the 2026-09-26 incident shape)', () => {
    expect(
      findBackupLockConflicts(
        pending('ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;'),
        ['session_turns', 'session_events'],
      ),
    ).toEqual([]);
  });

  it('conflicts when the migration names a locked table, schema-qualified or quoted', () => {
    for (const sql of [
      'ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;',
      'ALTER TABLE "harness_shared"."trigger_bindings" ADD COLUMN note text;',
      'ALTER TABLE Trigger_Bindings ADD COLUMN note text;',
    ]) {
      expect(findBackupLockConflicts(pending(sql), ['trigger_bindings'])).toEqual([
        { file: '1228-x.sql', subject: 'trigger_bindings', reason: 'names-locked-relation' },
      ]);
    }
  });

  it('matches whole identifiers only — a longer name sharing a prefix is not a conflict', () => {
    expect(
      findBackupLockConflicts(pending('CREATE TABLE harness_shared.session_turns_archive (id int);'), ['session_turns']),
    ).toEqual([]);
  });

  it('conflicts on a locked INDEX name (DROP INDEX locks its table without naming it)', () => {
    expect(
      findBackupLockConflicts(pending('DROP INDEX harness_shared.session_turns_owner_idx;'), [
        'session_turns',
        'session_turns_owner_idx',
      ]).map((c) => c.subject),
    ).toEqual(['session_turns_owner_idx']);
  });

  it('ignores a relation mentioned only in a comment', () => {
    expect(
      findBackupLockConflicts(
        pending('-- unlike session_turns, this is tiny\n/* session_turns */ CREATE TABLE a (id int);'),
        ['session_turns'],
      ),
    ).toEqual([]);
  });

  const ticketTriggers = (action = 'FUNCTION') =>
    ['data_sources', 'admission_rules', 'work_admissions'].map((table) => `
      CREATE OR REPLACE TRIGGER emit_change_notify_trg
        AFTER INSERT OR UPDATE OR DELETE ON harness_shared.${table}
        FOR EACH ROW EXECUTE ${action} harness_shared.emit_change_notify();
    `).join('\n');

  it.each(['FUNCTION', 'PROCEDURE'])('does not call a static CREATE TRIGGER EXECUTE %s action dynamic SQL', (action) => {
    expect(findBackupLockConflicts(pending(ticketTriggers(action)), ['session_turns', 'session_events'])).toEqual([]);
  });

  it.each(['data_sources', 'admission_rules', 'work_admissions'])('still blocks a static trigger on backup-held %s', (table) => {
    expect(findBackupLockConflicts(pending(ticketTriggers()), [table])).toEqual([
      { file: '1228-x.sql', subject: table, reason: 'names-locked-relation' },
    ]);
  });

  it('does not exempt a prepared EXECUTE named function after a static trigger statement', () => {
    const sql = ticketTriggers() + 'EXECUTE "function"(1);';
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('still refuses dynamic SQL that constructs a trigger', () => {
    const sql = `DO $$ BEGIN EXECUTE 'CREATE TRIGGER t AFTER INSERT ON public.a EXECUTE FUNCTION public.f()'; END $$;`;
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('refuses statements whose lock footprint the text cannot prove, even with nothing locked', () => {
    const cases: Array<[string, string]> = [
      ["DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD c int', t); END $$;", 'EXECUTE (dynamic SQL)'],
      ['GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO r;', 'ALL TABLES IN SCHEMA'],
      ['DROP SCHEMA old_stuff;', 'DROP SCHEMA'],
      ['DROP TYPE foo CASCADE;', 'DROP … CASCADE'],
      ['TRUNCATE a CASCADE;', 'TRUNCATE … CASCADE'],
      ['ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0);', 'ALTER DOMAIN'],
      ['REINDEX SCHEMA harness_shared;', 'REINDEX SCHEMA/DATABASE/SYSTEM'],
      ['VACUUM FULL a;', 'VACUUM'],
    ];
    for (const [sql, label] of cases) {
      const conflicts = findBackupLockConflicts(pending(sql), []);
      expect(conflicts.map((c) => c.subject)).toContain(label);
      expect(conflicts.every((c) => c.reason === 'unprovable-statement')).toBe(true);
    }
  });

  it('does not treat ON DELETE CASCADE in a FK definition as unprovable', () => {
    expect(
      findBackupLockConflicts(
        pending('CREATE TABLE a (id int, b_id int REFERENCES b(id) ON DELETE CASCADE);'),
        ['session_turns'],
      ),
    ).toEqual([]);
  });

  it('reports every conflicting file so the boot log names them all', () => {
    const conflicts = findBackupLockConflicts(
      [
        { file: '1.sql', sqlText: 'ALTER TABLE t1 ADD c int;' },
        { file: '2.sql', sqlText: 'ALTER TABLE t2 ADD c int;' },
        { file: '3.sql', sqlText: 'CREATE TABLE t3 (c int);' },
      ],
      ['t1', 't2'],
    );
    expect(conflicts.map((c) => c.file)).toEqual(['1.sql', '2.sql']);
    expect(describeConflicts(conflicts)).toBe(
      '1.sql names backup-locked relation t1; 2.sql names backup-locked relation t2',
    );
  });
});

describe('normalizeMigrationSql', () => {
  it('lowercases, drops double quotes and blanks comments', () => {
    expect(normalizeMigrationSql('ALTER "T" -- c\n/* x */ADD')).toBe('alter t  \n add');
  });
});
