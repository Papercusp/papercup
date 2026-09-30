/**
 * WI-10004107 recurrence guard, planner half: the bench must reproduce the live
 * memory tables' triggers, and must refuse loudly when it meets one it cannot
 * classify or cannot confine to its own schema.
 *
 * The fixtures are the live catalog's own output (pg_get_triggerdef /
 * pg_get_functiondef, 2026-09-30), trimmed of comments. The real-PG half, which
 * proves ensureBenchSchema actually installs them, is bench-host.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { BENCH_TRIGGER_FUNCTION_POLICY, planBenchTriggerClones, type LiveTriggerRow } from './bench-triggers';

const SCHEMA = 'bench_memory_4242';
const VECS = ['memory_vec_openai', 'memory_vec_local', 'memory_vec_gemma', 'memory_vec_harrier'];
const TABLES = ['memory_canonical', ...VECS];

const STAMP_FN = `CREATE OR REPLACE FUNCTION harness_shared.stamp_memory_vec_row_kind()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE kind text;
    BEGIN
      SELECT c.row_kind INTO kind FROM harness_shared.memory_canonical c WHERE c.id = NEW.memory_id;
      IF kind IS NULL THEN RAISE EXCEPTION 'no canonical row for %', NEW.memory_id; END IF;
      NEW.row_kind := kind;
      RETURN NEW;
    END;
    $function$
`;

const PROPAGATE_FN = `CREATE OR REPLACE FUNCTION harness_shared.propagate_memory_row_kind()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
      ${VECS.map((v) => `UPDATE harness_shared.${v} SET row_kind = NEW.row_kind WHERE memory_id = NEW.id;`).join('\n      ')}
      RETURN NULL;
    END;
    $function$
`;

const OUTBOX_FN = `CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
      INSERT INTO harness_shared.substrate_outbox (table_name, row_id) VALUES (TG_TABLE_NAME, NEW.id);
      RETURN NULL;
    END;
    $function$
`;

function stampRow(vec: string): LiveTriggerRow {
  return {
    table: vec,
    trigger: `stamp_${vec}_row_kind_trg`,
    functionName: 'stamp_memory_vec_row_kind',
    enabled: 'O',
    triggerDef: `CREATE TRIGGER stamp_${vec}_row_kind_trg BEFORE INSERT OR UPDATE ON harness_shared.${vec} FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_memory_vec_row_kind()`,
    functionDef: STAMP_FN,
  };
}

const PROPAGATE_ROW: LiveTriggerRow = {
  table: 'memory_canonical',
  trigger: 'propagate_memory_row_kind_trg',
  functionName: 'propagate_memory_row_kind',
  enabled: 'O',
  triggerDef:
    'CREATE TRIGGER propagate_memory_row_kind_trg AFTER UPDATE ON harness_shared.memory_canonical FOR EACH ROW WHEN ((old.row_kind IS DISTINCT FROM new.row_kind)) EXECUTE FUNCTION harness_shared.propagate_memory_row_kind()',
  functionDef: PROPAGATE_FN,
};

const OUTBOX_ROW: LiveTriggerRow = {
  table: 'memory_canonical',
  trigger: 'capture_memory_canonical_outbox_ins_trg',
  functionName: 'capture_substrate_outbox',
  enabled: 'O',
  triggerDef:
    "CREATE TRIGGER capture_memory_canonical_outbox_ins_trg AFTER INSERT ON harness_shared.memory_canonical FOR EACH ROW WHEN ((new.shareable = true)) EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id')",
  functionDef: OUTBOX_FN,
};

const LIVE_ROWS: LiveTriggerRow[] = [OUTBOX_ROW, PROPAGATE_ROW, ...VECS.map(stampRow)];

describe('planBenchTriggerClones (WI-10004107)', () => {
  it('reproduces the 1093 row_kind stamp on every cloned vec table, defining the function once', () => {
    const plan = planBenchTriggerClones(LIVE_ROWS, SCHEMA, TABLES);
    const stampFns = plan.statements.filter((s) => s.startsWith(`CREATE OR REPLACE FUNCTION ${SCHEMA}.stamp_memory_vec_row_kind(`));
    expect(stampFns).toHaveLength(1);
    for (const vec of VECS) {
      expect(plan.statements).toContain(
        `CREATE TRIGGER stamp_${vec}_row_kind_trg BEFORE INSERT OR UPDATE ON ${SCHEMA}.${vec} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.stamp_memory_vec_row_kind()`,
      );
    }
    // The stamp must read the BENCH canonical table, not the live one.
    expect(stampFns[0]).toContain(`FROM ${SCHEMA}.memory_canonical c`);
  });

  it('never emits a statement that can reach harness_shared', () => {
    const plan = planBenchTriggerClones(LIVE_ROWS, SCHEMA, TABLES);
    expect(plan.statements.length).toBeGreaterThan(0);
    for (const sql of plan.statements) expect(sql).not.toMatch(/harness_shared/);
  });

  it('defines every function before any trigger that calls it', () => {
    const plan = planBenchTriggerClones(LIVE_ROWS, SCHEMA, TABLES);
    const lastFn = plan.statements.map((s) => s.startsWith('CREATE OR REPLACE FUNCTION')).lastIndexOf(true);
    const firstTrg = plan.statements.findIndex((s) => s.startsWith('CREATE TRIGGER'));
    expect(lastFn).toBeLessThan(firstTrg);
  });

  it('skips the federation outbox capture with its stated reason', () => {
    const plan = planBenchTriggerClones(LIVE_ROWS, SCHEMA, TABLES);
    expect(plan.skipped).toEqual([
      { table: 'memory_canonical', trigger: 'capture_memory_canonical_outbox_ins_trg', reason: expect.stringMatching(/outbox/) },
    ]);
    expect(plan.statements.join('\n')).not.toMatch(/outbox/);
    expect(plan.cloned).toHaveLength(5);
  });

  it('REFUSES a live trigger whose function is unclassified, naming it (the next 1093 fails loud)', () => {
    const novel: LiveTriggerRow = { ...stampRow('memory_vec_harrier'), trigger: 'new_trg', functionName: 'some_new_stamp' };
    expect(() => planBenchTriggerClones([...LIVE_ROWS, novel], SCHEMA, TABLES)).toThrow(
      /memory_vec_harrier\.new_trg -> some_new_stamp\(\).*BENCH_TRIGGER_FUNCTION_POLICY/,
    );
  });

  it('REFUSES to clone a function that touches a table the bench does not clone', () => {
    const policy = { ...BENCH_TRIGGER_FUNCTION_POLICY, capture_substrate_outbox: { action: 'clone' as const } };
    expect(() => planBenchTriggerClones(LIVE_ROWS, SCHEMA, TABLES, policy)).toThrow(
      new RegExp(`references ${SCHEMA}\\.substrate_outbox`),
    );
  });

  it('REFUSES a trigger definition that escapes the rewrite (unqualified live table)', () => {
    const unqualified = {
      ...stampRow('memory_vec_harrier'),
      triggerDef:
        'CREATE TRIGGER stamp_memory_vec_harrier_row_kind_trg BEFORE INSERT OR UPDATE ON memory_vec_harrier FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_memory_vec_row_kind()',
    };
    expect(() => planBenchTriggerClones([unqualified], SCHEMA, TABLES)).toThrow(/does not target/);
  });

  it('skips a trigger that is disabled on the live table', () => {
    const plan = planBenchTriggerClones([{ ...PROPAGATE_ROW, enabled: 'D' }], SCHEMA, TABLES);
    expect(plan.statements).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'disabled on the live table' })]);
  });

  it('refuses a schema name that is not a plain identifier', () => {
    expect(() => planBenchTriggerClones(LIVE_ROWS, 'bench; DROP SCHEMA harness_shared', TABLES)).toThrow(/plain identifier/);
  });
});
