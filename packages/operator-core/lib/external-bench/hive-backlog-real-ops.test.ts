/**
 * P-022 — the REAL hive-backlog ops binding (`liveHiveBacklogOps`/`realHiveBacklogOps`). The pure,
 * NO-spend slices of the live binding: the terminal-feature-status → stopReason map, the
 * `agent_usage_samples` / bee-spawn SQL reads (over a FAKE tagged-template `sql`, no PG), and the
 * `bindLiveHiveBacklog` wiring (over INJECTED fake ops — proves the driver is bound without touching
 * the real fleet/hive/clone machinery). NO real hive, NO bee spawn, NO LLM spend — fakes/structure
 * only; the full live run is owner-gated (su-10912/ec8fe), exercised only by the pilot trigger.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  bindLiveHiveBacklog,
  realHiveBacklogOps,
  readMemberUsage,
  readMemberBeeSpawns,
  stopReasonForFeatureStatus,
  type HiveBacklogOps,
} from './hive-backlog-live';
import { runHiveBacklog, setHiveBacklogDriver, type HiveBacklogRunRequest } from './hive-backlog';
import type postgres from 'postgres';

afterEach(() => setHiveBacklogDriver(null));

// ── the terminal-feature-status → stopReason map (pure) ──────────────────────

test('stopReasonForFeatureStatus maps a member feature terminal → the ArmAttempt stopReason', () => {
  // A generation-side infra failure (diff-extract error) ALWAYS wins — it's not a scored terminal.
  assert.equal(stopReasonForFeatureStatus('passed', 'extractDiff failed: boom'), 'error');
  // passed → done; escalated/blocked → escalate (the same statuses bench-harness-live keys on).
  assert.equal(stopReasonForFeatureStatus('passed', undefined), 'done');
  assert.equal(stopReasonForFeatureStatus('escalated', undefined), 'escalate');
  assert.equal(stopReasonForFeatureStatus('blocked', undefined), 'escalate');
  // FAIRNESS (benchmark-fairness-fix): not terminal at collect time means the fleet was paused to bound
  // spend before this member got a fair run under contention — an EXTERNAL drain-unsettled symptom, NOT a
  // capability fail → 'infra-failed' (NON-scored, excluded from resolved%), NOT the old 'max-turns'-as-fail.
  assert.equal(stopReasonForFeatureStatus('todo', undefined), 'infra-failed');
  assert.equal(stopReasonForFeatureStatus(null, undefined), 'infra-failed');
});

// ── the per-member cost / spawn reads (over a fake tagged-template sql) ───────

/** A minimal fake `sql` tagged template that returns a fixed row set (the one query each helper runs). */
function fakeSql(rows: unknown[]): postgres.Sql {
  const fn = (() => Promise.resolve(rows)) as unknown as postgres.Sql;
  return fn;
}

test('readMemberUsage sums tokens/cost/turns + coerces null/text columns to numbers', async () => {
  const usage = await readMemberUsage(
    fakeSql([{ tokens_in: '120000', tokens_out: '30000', cost_usd: '4.20', turns: '7' }]),
    'xbhm-instance',
    'ws-1',
  );
  assert.deepEqual(usage, { tokensIn: 120_000, tokensOut: 30_000, costUsd: 4.2, turns: 7 });

  // Unpriced / empty member → all-zero (COALESCE floor), never NaN.
  const empty = await readMemberUsage(
    fakeSql([{ tokens_in: null, tokens_out: null, cost_usd: null, turns: '0' }]),
    'xbhm-empty',
    'ws-1',
  );
  assert.deepEqual(empty, { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 });
});

test('readMemberBeeSpawns maps the bee spawn rows + coerces the timestamps (finished may be null)', async () => {
  const t0 = new Date('2026-06-15T05:00:00Z');
  const t1 = new Date('2026-06-15T05:10:00Z');
  const rows = await readMemberBeeSpawns(
    fakeSql([
      { spawn_id: 's-bee-1', started_at: t0.toISOString(), finished_at: t1.toISOString() },
      { spawn_id: 's-bee-2', started_at: t1.toISOString(), finished_at: null },
    ]),
    'xbhm-instance',
    'ws-1',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].spawnId, 's-bee-1');
  assert.equal(rows[0].startedAtMs, t0.getTime());
  assert.equal(rows[0].finishedAtMs, t1.getTime());
  assert.equal(rows[1].finishedAtMs, null); // a still-running bee
});

// ── the binding wiring (over injected fake ops — no real machinery) ──────────

test('realHiveBacklogOps returns a fully-implemented ops set (no throwing stub on the core path)', () => {
  const ops = realHiveBacklogOps({ workspaceId: 'ws-1' });
  for (const m of [
    'createHive', 'enrollTask', 'gatherFrontier', 'gatherBees', 'placeBatch',
    'countInFlight', 'pauseFleet', 'collectTask', 'teardown',
  ] as const) {
    assert.equal(typeof ops[m], 'function', `${m} is wired`);
  }
});

test('bindLiveHiveBacklog binds the live driver over INJECTED fake ops — proves the wiring, no real fleet', async () => {
  const seen: string[] = [];
  const fake: HiveBacklogOps = {
    now: () => 1_000,
    sleep: async () => {},
    createHive: async () => { seen.push('createHive'); return { hiveHome: 'xb' }; },
    enrollTask: async () => { seen.push('enrollTask'); throw new Error('stop — wiring proven before any place'); },
    gatherFrontier: async () => [] as never,
    gatherBees: async () => ({ bees: [] as never, headroom: 0 }),
    placeBatch: async () => ({ placements: [] }),
    countInFlight: async () => 0,
    pauseFleet: async () => { seen.push('pauseFleet'); },
    collectTask: async () => { throw new Error('unreached'); },
    teardown: async () => { seen.push('teardown'); },
  };
  // bindLiveHiveBacklog === bindLiveHiveBacklogDriver; inject the fake ops so NO real machinery loads.
  bindLiveHiveBacklog({ workspaceId: 'ws-1', pollIntervalMs: 1 }, fake);

  const req: HiveBacklogRunRequest = {
    arm: 'hive', suite: 'swe-bench-pro', runId: 'run-1', seed: 0,
    backlog: [{ benchmark: 'swe-bench-pro', instanceId: 'a', problemStatement: 'fix a', graderMeta: {} }],
    budget: { maxUsd: 10 },
  };
  const result = await runHiveBacklog(req);
  // The bound live driver ran the orchestration over the fake ops (create → enroll → pause+teardown on
  // the enroll failure), never throwing — the never-throws generation-failure contract.
  assert.match(result.runError ?? '', /wiring proven/);
  assert.deepEqual(seen, ['createHive', 'enrollTask', 'pauseFleet', 'teardown']);
});
