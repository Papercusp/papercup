/**
 * P-003 (p2p-v1-core-release-2026-11-13): fail-closed merge rules.
 *
 * SPEC-P003-NON-SIMPLE-RULE-REJECTED: a table declaring a merge rule outside the v1
 * simple rule set is refused for replication. The simple set and the full rule list
 * are read from the canonical registry (merge-rules.ts), never restated here.
 *
 * R-6 (unit layer): a table without a rule in the v1 simple set produces no
 * replication operation at the capture seam, never wins a fold under an assumed
 * rule, and is refused by the apply path. The integration layer of R-6 lives in
 * lib/p2p/v1-core/v1-core-acceptance.integration.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Lets one case withdraw a captured table's rule, so the capture seam is exercised
// on a real mapped table_name. Every other lookup passes through unchanged.
const withdrawn = vi.hoisted(() => ({ tags: new Set<string>() }));
vi.mock('../merge-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../merge-rules')>();
  return {
    ...actual,
    replicationRuleFor: (table: string, declared?: unknown) =>
      withdrawn.tags.has(table) ? undefined : actual.replicationRuleFor(table, declared),
  };
});

import {
  MERGE_RULES,
  TABLE_MERGE_RULES,
  V1_SIMPLE_MERGE_RULES,
  assertReplicationRule,
  isSimpleMergeRule,
  operationGroupKey,
  replicationRuleFor,
} from '../merge-rules';
import {
  _clearRegistryForTests,
  applyOpVia,
  getProjection,
  registerProjection,
  type TableProjection,
} from '../projection';
import {
  UnknownOutboxTableError,
  UnreplicatedOutboxTableError,
  outboxRowToLocalWriteOp,
} from '../feature-issue-op-keys';
import type { OpEnvelope } from '../op-envelope-types';

// Declared values outside the v1 set: an unsupported rule, a near-miss spelling,
// a case variant and a non-string. The first describe asserts each is genuinely outside.
const OUTSIDE: readonly unknown[] = ['max', 'last-writer-wins', 'LWW', 'json-merge', 42];

function fixtureProjection(tableTag: string, mergeRule: unknown, writes: string[] = []): TableProjection<unknown> {
  return {
    tableTag,
    mergeRule,
    writeToPg: async (_row: unknown, key: string) => {
      writes.push(key);
    },
    deleteFromPg: async (key: string) => {
      writes.push(`del:${key}`);
    },
  } as unknown as TableProjection<unknown>;
}

afterEach(() => {
  withdrawn.tags.clear();
  _clearRegistryForTests();
});

describe('SPEC-P003-NON-SIMPLE-RULE-REJECTED: a non-simple declared rule is refused for replication', () => {
  it('the outside fixtures are genuinely outside the v1 simple set (not a vacuous pass)', () => {
    expect(OUTSIDE.length).toBeGreaterThan(0);
    for (const rule of OUTSIDE) expect(isSimpleMergeRule(rule), String(rule)).toBe(false);
    for (const rule of V1_SIMPLE_MERGE_RULES) expect(MERGE_RULES).toContain(rule);
  });

  it.each(OUTSIDE)('a table declaring %s is refused at registration and never becomes replicated', (rule) => {
    const tag = `spec-p003-non-simple-${String(rule)}`;
    expect(() => registerProjection(fixtureProjection(tag, rule))).toThrow(/outside the v1 simple rule set/);
    expect(getProjection(tag)).toBeNull();
    expect(replicationRuleFor(tag, rule)).toBeUndefined();
    expect(() => assertReplicationRule(tag, rule)).toThrow(/outside the v1 simple rule set/);
  });

  it.each(V1_SIMPLE_MERGE_RULES)('control: a table declaring the simple rule %s registers', (rule) => {
    const tag = `spec-p003-simple-${rule}`;
    registerProjection(fixtureProjection(tag, rule));
    expect(getProjection(tag)).not.toBeNull();
    expect(replicationRuleFor(tag, rule)).toBe(rule);
  });

  it('every production census entry declares a simple rule', () => {
    for (const [table, rule] of Object.entries(TABLE_MERGE_RULES)) {
      expect(isSimpleMergeRule(rule), `${table} declares ${rule}`).toBe(true);
    }
  });
});

describe('R-6: a table without a v1 replication rule produces no replication operation', () => {
  it('R-6: an undeclared table is refused at registration', () => {
    const tag = 'r6-undeclared-fixture';
    expect(replicationRuleFor(tag)).toBeUndefined();
    expect(() => registerProjection(fixtureProjection(tag, undefined))).toThrow(/Missing merge rule/);
    expect(getProjection(tag)).toBeNull();
  });

  it('R-6: the capture seam emits no op for a mapped table whose rule is withdrawn, and the drain skip class applies', () => {
    const row = { table_name: 'pot_settings', op: 'del' as const, key: 'r6-key', ts: 1, row: null };
    // Control: with its declared rule the same row is a replication op.
    expect(outboxRowToLocalWriteOp(row)).toMatchObject({ type: 'del', table: 'hive-settings-by-key', hbKey: 'r6-key' });

    withdrawn.tags.add('hive-settings-by-key');
    let thrown: unknown;
    try {
      outboxRowToLocalWriteOp(row);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnreplicatedOutboxTableError);
    // The drain skips this class: the row stays undrained and nothing is appended.
    expect(thrown).toBeInstanceOf(UnknownOutboxTableError);
  });

  it('R-6: an unreplicated op never shares an LWW fold address', () => {
    const op = (hlc: string): OpEnvelope =>
      ({ type: 'put', table: 'r6-undeclared-fixture', hbKey: 'k', hlc, sourceLogKeyHex: 'aa', writerPubkey: 'aa' }) as OpEnvelope;
    const lwwKey = 'r6-undeclared-fixture::k';
    expect(operationGroupKey(op('1:0'))).not.toBe(lwwKey);
    expect(operationGroupKey(op('1:0'))).not.toBe(operationGroupKey(op('2:0')));
    // Control: a declared LWW table folds both ops onto one address.
    const lww = (hlc: string) => ({ ...op(hlc), table: 'hive-settings-by-key' }) as OpEnvelope;
    expect(operationGroupKey(lww('1:0'))).toBe(operationGroupKey(lww('2:0')));
  });

  const applyCases: Array<[string, unknown]> = [
    ['undeclared', undefined],
    ...OUTSIDE.map((r): [string, unknown] => [`non-simple (${r})`, r]),
  ];
  it.each(applyCases)('R-6: the apply path writes nothing for a %s table', async (_label, rule) => {
    const writes: string[] = [];
    const tag = 'r6-apply-fixture';
    const projection = fixtureProjection(tag, rule, writes);
    const applied = await applyOpVia(() => projection, {
      type: 'put', table: tag, hbKey: 'k', value: { a: 1 }, ts: 1, hlc: '1:0',
    } as unknown as OpEnvelope);
    expect(applied).toBe(false);
    expect(writes).toEqual([]);
  });
});
