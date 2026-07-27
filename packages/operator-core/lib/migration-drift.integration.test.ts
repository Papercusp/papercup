/**
 * checkMigrationDrift — Phase 2 (fleet-coordination-painpoints, P-005).
 * Live: reads the sql/ dir + reconciles against harness_shared.schema_migrations.
 * Asserts the diff is internally consistent regardless of DB reachability
 * (the fn fails-soft to applied=[] if the tracker is unreachable).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readInbox } from './agent-tools/coordination/messages';
import { checkMigrationDrift } from './migration-drift';

describe('checkMigrationDrift', () => {
  beforeAll(async () => {
    // Prime the org PG handle past the first-call race (D-015), best-effort.
    await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  it('reads the sql dir and reconciles against schema_migrations', async () => {
    const d = await checkMigrationDrift();
    expect(d.sqlDir).not.toBeNull();
    expect(d.onDisk).toContain('000-baseline.sql');

    const onDiskSet = new Set(d.onDisk);
    const appliedSet = new Set(d.applied);
    // every `missing` is on disk and not applied
    for (const m of d.missing) {
      expect(onDiskSet.has(m)).toBe(true);
      expect(appliedSet.has(m)).toBe(false);
    }
    // every `extra` is applied and not on disk
    for (const e of d.extra) {
      expect(appliedSet.has(e)).toBe(true);
      expect(onDiskSet.has(e)).toBe(false);
    }
    // inSync reflects ACTIONABLE drift ONLY (infra round-3 F14): it is driven by
    // `missing` (on-disk migrations awaiting an apply) AND `missingCanonical`
    // (EI-18757486483124756 — the canonical tree agents author in, checked
    // independent of whichever tree served this call), NOT by `extra`
    // (squashed/renamed-migration history). A non-empty `extra` must NOT flip
    // inSync false — that used to make in_sync permanently false on this fleet
    // and masked real `missing` drift.
    expect(d.inSync).toBe(d.missing.length === 0 && d.missingCanonical.length === 0);
  });

  it('extra (squashed-history) rows do not flip inSync false', async () => {
    const d = await checkMigrationDrift();
    if (d.extra.length > 0 && d.missing.length === 0 && d.missingCanonical.length === 0) {
      // The exact live condition this fix targets: history present, nothing
      // awaiting apply in either tree ⇒ in sync.
      expect(d.inSync).toBe(true);
    }
    // And the invariant always holds regardless of `extra`.
    expect(d.inSync).toBe(d.missing.length === 0 && d.missingCanonical.length === 0);
  });

  // EI-18757486483124756: a migration authored in the canonical tree must be
  // visible here even when the tree serving this call (often the release
  // checkout) already matches its own on-disk set — the exact gap that let a
  // just-written staging migration read `in_sync: true`.
  it('missingCanonical is scanned against the canonical tree independent of sqlDir, and gates inSync', async () => {
    const d = await checkMigrationDrift();
    if (d.canonicalStagingSqlDir === null) {
      // Not resolvable on this host/process (e.g. PAPERCUSP_INTEGRATION_ROOT unset) —
      // fails toward reporting nothing extra, never toward a false positive.
      expect(d.missingCanonical).toEqual([]);
      return;
    }
    const appliedSet = new Set(d.applied);
    for (const m of d.missingCanonical) expect(appliedSet.has(m)).toBe(false);
    if (d.missingCanonical.length > 0) expect(d.inSync).toBe(false);
  });

  // WI-6037: `missingDeployed`/`missingPendingDeploy` must partition `missing` exactly —
  // every missing file is in exactly one bucket, and (per the fail-toward-reporting
  // contract) missingDeployed === missing whenever the deployed tree isn't resolvable.
  it('missingDeployed + missingPendingDeploy partition missing exactly', async () => {
    const d = await checkMigrationDrift();
    const union = new Set([...d.missingDeployed, ...d.missingPendingDeploy]);
    expect(union.size).toBe(d.missingDeployed.length + d.missingPendingDeploy.length);
    expect([...union].sort()).toEqual([...d.missing].sort());
    if (d.deployedSqlDir === null) {
      expect(d.missingDeployed).toEqual(d.missing);
      expect(d.missingPendingDeploy).toEqual([]);
    }
  });
});
