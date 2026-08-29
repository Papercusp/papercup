/**
 * schema-object-drift.test.ts — the comparison engine, exercised directly.
 *
 * The two false-positive classes that made a TEXT search over the migration
 * corpus unusable (see schema-object-drift.ts's module header) get explicit
 * controls here. They are the reason the reference is materialized, so they are
 * the first thing to re-prove if anyone ever "optimizes" the reference back into
 * a grep: a guard that cries wolf on nine auto-named constraint indexes and five
 * dynamically-named ones gets ignored, and an ignored guard is not a guard.
 */
import { describe, expect, it } from 'vitest';
import {
  compareIndexCensus,
  describeSchemaObjectDrift,
  hasSchemaObjectDrift,
  normalizeIndexDefinition,
  type IndexCensusEntry,
} from './schema-object-drift';

function idx(
  schema: string,
  name: string,
  table: string,
  definition = `CREATE INDEX ${name} ON ${schema}.${table} USING btree (col)`,
  constraintBacked = false,
): IndexCensusEntry {
  return { schema, name, table, definition, constraintBacked };
}

const BASE: IndexCensusEntry[] = [
  idx('harness_shared', 'work_items_pkey', 'work_items', 'CREATE UNIQUE INDEX work_items_pkey ON harness_shared.work_items USING btree (id)', true),
  idx('harness_shared', 'session_turns_session_idx', 'session_turns'),
  idx('papercup_shared', 'token_index_ws_idx', 'token_index'),
];

describe('compareIndexCensus', () => {
  it('reports nothing when the two censuses agree', () => {
    const drift = compareIndexCensus(BASE, [...BASE]);
    expect(hasSchemaObjectDrift(drift)).toBe(false);
    expect(drift.liveIndexCount).toBe(3);
    expect(drift.referenceIndexCount).toBe(3);
  });

  it('reports an index that exists live but in no migration', () => {
    const live = [...BASE, idx('harness_shared', 'plugin_configs_plugin_idx', 'plugin_configs')];
    const drift = compareIndexCensus(BASE, live);
    expect(drift.liveOnly.map((e) => e.name)).toEqual(['plugin_configs_plugin_idx']);
    expect(drift.referenceOnly).toEqual([]);
    expect(hasSchemaObjectDrift(drift)).toBe(true);
  });

  it('reports an index the migrations produce that the live database lacks', () => {
    const live = BASE.filter((e) => e.name !== 'session_turns_session_idx');
    const drift = compareIndexCensus(BASE, live);
    expect(drift.referenceOnly.map((e) => e.name)).toEqual(['session_turns_session_idx']);
    expect(drift.liveOnly).toEqual([]);
  });

  it('reports a same-named index whose DEFINITION changed', () => {
    // The case a name-only comparison cannot see: an index redefined in place
    // over different columns is a different index for every purpose that matters.
    const live = BASE.map((e) =>
      e.name === 'session_turns_session_idx'
        ? { ...e, definition: 'CREATE INDEX session_turns_session_idx ON harness_shared.session_turns USING btree (other_col)' }
        : e,
    );
    const drift = compareIndexCensus(BASE, live);
    expect(drift.liveOnly).toEqual([]);
    expect(drift.referenceOnly).toEqual([]);
    expect(drift.definitionMismatch).toHaveLength(1);
    expect(drift.definitionMismatch[0].name).toBe('session_turns_session_idx');
    expect(drift.definitionMismatch[0].live).toContain('other_col');
    expect(drift.definitionMismatch[0].reference).toContain('(col)');
  });

  it('IGNORES schemas the migrations do not build, and says which it ignored', () => {
    // dbos is created by the DBOS library at runtime, zero_0/cvr belongs to the
    // retired sync engine, and a per-harness schema comes from the name-skipped
    // template migration. None of them is drift, and none is excluded by a
    // hand-maintained list — they are simply absent from the reference.
    const live = [
      ...BASE,
      idx('dbos', 'operation_outputs_idx', 'operation_outputs'),
      idx('zero_0/cvr', 'instances_idx', 'instances'),
    ];
    const drift = compareIndexCensus(BASE, live);
    expect(drift.liveOnly).toEqual([]);
    expect(drift.schemasNotCompared).toEqual(['dbos', 'zero_0/cvr']);
    expect(drift.schemasCompared).toEqual(['harness_shared', 'papercup_shared']);
    // Only in-scope indexes are counted, so the count cannot be padded by
    // out-of-scope schemas into looking like a bigger comparison than it was.
    expect(drift.liveIndexCount).toBe(3);
  });

  describe('the false-positive classes that a text search over the migrations cannot avoid', () => {
    it('does NOT flag a dynamically-named index (migration 530 EXECUTE format())', () => {
      // The name is assembled at runtime, so it appears as a literal in no
      // migration file. A materialized reference has it, so it matches.
      const dynamic = idx('harness_shared', 'session_turns_text_embedding_mode_idx', 'session_turns');
      const drift = compareIndexCensus([...BASE, dynamic], [...BASE, dynamic]);
      expect(drift.liveOnly).toEqual([]);
      expect(hasSchemaObjectDrift(drift)).toBe(false);
    });

    it('does NOT flag an index Postgres auto-named for a UNIQUE constraint', () => {
      // `UNIQUE (workspace_id, harness_slug)` yields `<table>_..._key`; that
      // identifier is never written in the SQL either.
      const autoNamed = idx(
        'harness_shared',
        'token_index_workspace_id_harness_slug_key',
        'token_index',
        'CREATE UNIQUE INDEX token_index_workspace_id_harness_slug_key ON harness_shared.token_index USING btree (workspace_id, harness_slug)',
        true,
      );
      const drift = compareIndexCensus([...BASE, autoNamed], [...BASE, autoNamed]);
      expect(drift.liveOnly).toEqual([]);
      expect(hasSchemaObjectDrift(drift)).toBe(false);
    });

    it('DOES still flag a genuinely-extra index that merely LOOKS auto-named', () => {
      // The control for the two above: they must pass because the reference
      // contains the index, NOT because anything is filtering on the name shape.
      // If someone reintroduces a `_key`/`_idx` name-pattern exclusion, this
      // fails — which is the point.
      const impostor = idx(
        'harness_shared',
        'hand_made_thing_key',
        'work_items',
        'CREATE UNIQUE INDEX hand_made_thing_key ON harness_shared.work_items USING btree (id)',
        true,
      );
      const drift = compareIndexCensus(BASE, [...BASE, impostor]);
      expect(drift.liveOnly.map((e) => e.name)).toEqual(['hand_made_thing_key']);
    });
  });
});

describe('normalizeIndexDefinition', () => {
  it('collapses whitespace and nothing else', () => {
    expect(normalizeIndexDefinition('CREATE  INDEX\n  a ON b (c) ')).toBe('CREATE INDEX a ON b (c)');
  });

  it('does NOT treat case or keyword differences as equivalent', () => {
    // Deliberate: every "harmless" normalization is a rule about what counts as
    // the same index, and each one is a place a real difference can hide.
    expect(normalizeIndexDefinition('CREATE INDEX a ON b USING btree (c)')).not.toBe(
      normalizeIndexDefinition('create index a on b using btree (c)'),
    );
  });
});

describe('describeSchemaObjectDrift', () => {
  it('NAMES the drifted objects rather than only counting them', () => {
    const live = [...BASE, idx('harness_shared', 'plugin_enables_plugin_idx', 'plugin_enables')];
    const text = describeSchemaObjectDrift(compareIndexCensus(BASE, live));
    expect(text).toContain('plugin_enables_plugin_idx');
    expect(text).toContain('plugin_enables');
  });

  it('says what was actually compared when there is nothing to report', () => {
    // A clean verdict has to carry its own scope, or "no drift" is
    // indistinguishable from "nothing was examined".
    const text = describeSchemaObjectDrift(compareIndexCensus(BASE, [...BASE]));
    expect(text).toContain('No index drift');
    expect(text).toContain('3 live indexes');
    expect(text).toContain('2 migration-owned schema');
  });

  it('marks a constraint-backed index, because the remedy differs', () => {
    const impostor = idx('harness_shared', 'x_key', 'work_items', 'CREATE UNIQUE INDEX x_key ON harness_shared.work_items USING btree (id)', true);
    const text = describeSchemaObjectDrift(compareIndexCensus(BASE, [...BASE, impostor]));
    expect(text).toContain('[constraint-backed]');
  });
});
