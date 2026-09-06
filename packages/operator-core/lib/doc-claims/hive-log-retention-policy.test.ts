/**
 * P-043 (plan shared-pot-dao-cupboard-v1-2026-09-04; D-057/D-059, WI-2147374):
 * EVERY kind that rides the hive peer log carries a retention class.
 *
 * The pin: a new `sync:'peer-log'` table added to `table-registry.ts` without an
 * entry in `HIVE_LOG_RETENTION` fails HERE, at build time — which is the whole
 * point of the item. Before this existed, a new federated op kind rode an
 * append-only log with no eviction code anywhere in the tree and nobody had
 * decided how long it was kept; that is how the dev box reached 46 GB in 58 days.
 *
 * FIXTURE CONTROLS are load-bearing (same reason as `gate-candidate-ref.test.ts`
 * and its siblings): once the live assertion goes green it stops being evidence
 * that the checker can fail at all. Each control below reproduces a shape that
 * MUST be caught, so a checker broken into always-ok is caught by its own tests.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_LOG_TABLES } from '../harness-state/table-registry';
import {
  HIVE_LOG_RETENTION,
  MEASURED_APPEND_VOLUME_2026_09_06,
  checkHiveLogRetentionCoverage,
  checkRetentionCoverage,
  projectAppendVolume,
  rotatingTables,
  summarizeAmplification,
  tablesNotBelongingOnTheLog,
  type RetentionSpec,
} from '../harness-state/hive-log-retention';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('P-043 — every federated op kind carries a retention class', () => {
  it('the live registry is fully classified, with no orphan or incoherent entry', () => {
    const coverage = checkHiveLogRetentionCoverage();
    // Named explicitly so a failure REPORTS the offending table instead of a bare false.
    expect(coverage.unclassified).toEqual([]);
    expect(coverage.orphanPolicy).toEqual([]);
    expect(coverage.incoherent).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('classifies every peer-log table exactly once and nothing else', () => {
    expect(Object.keys(HIVE_LOG_RETENTION).sort()).toEqual([...PEER_LOG_TABLES].sort());
  });

  describe('fixture controls — the checker must be able to FAIL', () => {
    const ok: RetentionSpec = {
      tier: 'append-only-log',
      retention: 'permanent',
      note: 'fixture',
    };

    it('catches a federated table with NO retention class — the P-043 gap itself', () => {
      const c = checkRetentionCoverage(['a_table', 'b_table'], { a_table: ok });
      expect(c.ok).toBe(false);
      expect(c.unclassified).toEqual(['b_table']);
    });

    it('catches a policy entry for a table that no longer federates', () => {
      const c = checkRetentionCoverage(['a_table'], { a_table: ok, retired_table: ok });
      expect(c.ok).toBe(false);
      expect(c.orphanPolicy).toEqual(['retired_table']);
    });

    it('catches `rotating` with no retainEpochs — a rotation nothing would ever run', () => {
      const c = checkRetentionCoverage(['a_table'], {
        a_table: { tier: 'append-only-log', retention: 'rotating', note: 'fixture' },
      });
      expect(c.ok).toBe(false);
      expect(c.incoherent.join('\n')).toMatch(/rotating without retainEpochs/);
    });

    it('catches `ephemeral` with no ttlSec — an expiry nobody could enforce', () => {
      const c = checkRetentionCoverage(['a_table'], {
        a_table: { tier: 'ephemeral-channel', retention: 'ephemeral', carriedBy: 'x', note: 'fixture' },
      });
      expect(c.ok).toBe(false);
      expect(c.incoherent.join('\n')).toMatch(/ephemeral without ttlSec/);
    });

    it('catches an off-log class that names NO alternative transport — silent data loss', () => {
      const c = checkRetentionCoverage(['a_table'], {
        a_table: { tier: 'local-postgres', retention: 'off-log', note: 'fixture' },
      });
      expect(c.ok).toBe(false);
      expect(c.incoherent.join('\n')).toMatch(/names no carriedBy transport/);
    });

    it('catches a class with no note — a policy must record why', () => {
      const c = checkRetentionCoverage(['a_table'], {
        a_table: { tier: 'append-only-log', retention: 'permanent', note: '   ' },
      });
      expect(c.ok).toBe(false);
      expect(c.incoherent.join('\n')).toMatch(/no note/);
    });
  });
});

describe('P-043 — the tier-2 transport the ephemeral class points at actually exists', () => {
  /**
   * `shared_presence` is classified `ephemeral-channel`, and D-059 asked whether
   * P-043 must BUILD that tier. It does not: `presence-gossip.ts` is the tier-2
   * transport and predates this item. Pinning it here means the `carriedBy`
   * claim cannot rot into a promise — if that module or its factory is deleted
   * or renamed, the classification that depends on it fails with it.
   */
  const PRESENCE_GOSSIP = join(ROOT, 'packages/operator-core/lib/sync/hyperbee/presence-gossip.ts');

  it('presence-gossip.ts exists and exports the channel factory', () => {
    expect(existsSync(PRESENCE_GOSSIP)).toBe(true);
    const src = readFileSync(PRESENCE_GOSSIP, 'utf8');
    expect(src).toMatch(/export function createPresenceGossip\b/);
    expect(src).toMatch(/HIVE_PRESENCE_PROTOCOL\s*=\s*'papercusp\/hive-presence'/);
  });

  it('every off-the-log classification names a transport', () => {
    const offLog = tablesNotBelongingOnTheLog();
    expect(offLog.length).toBeGreaterThan(0);
    for (const table of offLog) {
      expect(HIVE_LOG_RETENTION[table]?.carriedBy, `${table} carriedBy`).toBeTruthy();
    }
  });
});

describe('P-043 — the amplification explanation is arithmetic over a recorded measurement', () => {
  /**
   * D-057 recorded the >10x store/row-content gap as unexplained and attributed
   * the volume to "machine chatter". These assertions pin the arithmetic that
   * refuted that: the multiplier is VERSION COUNT on large edited rows, and
   * coordination messages are insert-only.
   *
   * They are computations over `MEASURED_APPEND_VOLUME_2026_09_06`, not restated
   * prose — so a later agent who re-measures and updates that constant sees
   * immediately whether the SHAPE that justified the policy still holds.
   */
  it('coordination messages are insert-only — 1.00 appends per key, so they are not the amplifier', () => {
    const coord = projectAppendVolume().find((r) => r.table === 'coord_event_log');
    expect(coord).toBeDefined();
    expect(coord!.appendsPerKey).toBeCloseTo(1.0, 2);
  });

  it('the three largest producers are edit-churn tables, each re-appending whole rows', () => {
    const top = summarizeAmplification().topProducers.map((p) => p.table);
    expect(top).toEqual(['harness_plans', 'harness_features_consolidated', 'engineer_issues']);
    for (const p of summarizeAmplification().topProducers) {
      expect(p.appendsPerKey, `${p.table} appends per key`).toBeGreaterThan(1);
    }
  });

  it('superseded versions dominate: keeping only the latest per key would cut the day by ~4/5', () => {
    // Measured 2026-09-06: 4.87x across the whole federated set (79.5% of the
    // day is superseded versions). The three edit-churn amplifiers alone are
    // 87.6% (224 MB → 27.8 MB); the whole-set figure is lower because the
    // insert-only kinds — coord_event_log above all — cannot be compacted at all.
    // Asserting the WHOLE-SET number on purpose: it is the one a rotation pass
    // actually has to beat, and quoting the narrower 87.6% as if it were the
    // system-wide saving is exactly the overstatement this test exists to stop.
    const s = summarizeAmplification();
    expect(s.versionMultiplier).toBeGreaterThan(4);
    const savedPct = ((s.wireBytes24h - s.latestOnlyBytes24h) / s.wireBytes24h) * 100;
    expect(savedPct).toBeGreaterThan(75);
    expect(savedPct).toBeLessThan(87.6);
  });

  it('the kinds paying that cost are the ones classified `rotating`', () => {
    // If a future edit reclassifies the amplifiers away from `rotating` without
    // building something better, this share collapses and the test says so.
    expect(summarizeAmplification().rotatingSharePct).toBeGreaterThan(80);
    expect(rotatingTables()).toEqual(expect.arrayContaining(['harness_plans', 'engineer_issues']));
  });

  it('every measured table is one the registry federates', () => {
    const peer = new Set(PEER_LOG_TABLES);
    for (const table of Object.keys(MEASURED_APPEND_VOLUME_2026_09_06)) {
      expect(peer.has(table), `${table} is measured but not federated`).toBe(true);
    }
  });
});
