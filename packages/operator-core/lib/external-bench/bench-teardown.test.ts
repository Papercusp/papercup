/**
 * bench-teardown — the run-end debris retire (benchmark-coordination-topologies recurrence fix).
 * Pins the guarded scope (benchmark-only, papercup-protected) + the never-throw best-effort contract.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isStaleBenchDebris, retireBenchDebris, type DebrisSql } from './bench-teardown';

test('isStaleBenchDebris — benchmark non-terminal = debris; terminal + papercup = NOT', () => {
  // benchmark harnesses in a non-terminal state → debris
  assert.equal(isStaleBenchDebris('xbench-su-abc123-instance_flipt', 'todo'), true);
  assert.equal(isStaleBenchDebris('xbq72ugvazsm-instance_ansible', 'failing'), true);
  assert.equal(isStaleBenchDebris('xbench-9kloo4ig', 'in_progress'), true);
  // the broadened slug families: a pure xbq/extbench scratch slug (no `instance` substring) still matches
  assert.equal(isStaleBenchDebris('xbq9kloo4ig', 'pending'), true, 'xbq prefix alone = bench debris');
  assert.equal(isStaleBenchDebris('extbench-scratch-1', 'failed'), true, 'extbench prefix alone = bench debris');
  // terminal states are NOT debris (already out of the frontier)
  for (const s of ['done', 'passed', 'deprecated', 'cancelled', 'archived']) {
    assert.equal(isStaleBenchDebris('xbench-su-abc', s), false, `terminal '${s}' is not debris`);
  }
  // real papercup harnesses are PROTECTED — never retired, even non-terminal
  assert.equal(isStaleBenchDebris('papercup', 'todo'), false);
  assert.equal(isStaleBenchDebris('papercup-hive', 'failing'), false);
  // the papercusp home hive + its members are PROTECTED too (papercup→papercusp generalization)
  assert.equal(isStaleBenchDebris('papercusp', 'todo'), false);
  assert.equal(isStaleBenchDebris('papercusp-hive', 'failing'), false);
  // a non-benchmark harness is ignored
  assert.equal(isStaleBenchDebris('some-real-harness', 'todo'), false);
});

test('retireBenchDebris — guarded UPDATE, returns count, never throws', async () => {
  let sqlText = '';
  const fakeSql = (async (strings: TemplateStringsArray) => {
    sqlText = strings.join('?');
    return [{ feature_id: 'F-INSTANCE-1' }, { feature_id: 'F-INSTANCE-2' }];
  }) as unknown as DebrisSql;
  const n = await retireBenchDebris(fakeSql, 123);
  assert.equal(n, 2);
  assert.ok(sqlText.includes('UPDATE harness_shared.harness_features_consolidated'));
  assert.ok(sqlText.includes("NOT LIKE 'papercup%'"), 'must guard real papercup harnesses');
  assert.ok(sqlText.includes("NOT LIKE 'papercusp%'"), 'must guard the papercusp home hive + members');
  assert.ok(sqlText.includes("SET status = 'deprecated'"));
  // the broadened slug families are in the guarded predicate (mirrors isStaleBenchDebris)
  assert.ok(sqlText.includes("LIKE 'xbench%'") && sqlText.includes("LIKE 'xbq%'") && sqlText.includes("LIKE 'extbench%'"),
    'retire SQL must cover every benchmark slug family the predicate matches');

  // never-throw: a failing sql → 0, not a propagated error (teardown must not wedge a run)
  const throwingSql = (async () => {
    throw new Error('PG too many clients');
  }) as unknown as DebrisSql;
  assert.equal(await retireBenchDebris(throwingSql, 0), 0);
});

test('retireBenchDebris — SCOPED form retires ONLY one run hive (safe under concurrent peer runs)', async () => {
  let sqlText = '';
  const vals: unknown[] = [];
  const fakeSql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
    sqlText = strings.join('?');
    vals.push(...v);
    return Promise.resolve([{ feature_id: 'xbench-instance_a' }]);
  }) as unknown as DebrisSql;

  const n = await retireBenchDebris(fakeSql, 999, { slugPrefix: 'xbench-su-AbC123' });
  assert.equal(n, 1);
  // the scoped predicate is a single prefix LIKE — NOT the broad workspace-wide OR-clause.
  assert.ok(sqlText.includes('harness_slug LIKE') && !sqlText.includes("LIKE 'xbench%'"),
    'scoped retire must not use the broad bench-family clause that would hit peers');
  assert.ok(sqlText.includes("NOT LIKE 'papercup%'"), 'still guards papercup');
  assert.ok(vals.includes('xbench-su-AbC123%'), 'prefix passed as a parameter (LIKE pattern), not the broad family');
});
