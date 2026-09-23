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

  /**
   * EI-19408574209859155 — THE COST GUARD. Classification recovers the applied
   * bytes from git history, one `git log` + up to N `git show` subprocesses per
   * drifted file. Measured on this tree: 68 drifted files, 8.5–10s.
   *
   * `checkMigrationDrift` is called from boot, system-health and the watchdog,
   * and NONE of them read `contentDrift`. So the default MUST stay off. If
   * someone flips it, this fails — structurally, because a classified entry can
   * only be produced by actually doing the git walk.
   */
  it('does NOT hash or classify content drift by default — boot/system-health must not pay for either', async () => {
    // WI-10002541: the default call does not even hash (null = NOT MEASURED,
    // never an empty "no drift" list).
    const off = await checkMigrationDrift();
    expect(off.contentDrift).toBeNull();
    expect(off.contentDriftExecutable).toBeNull();

    // checkContent measures raw drift but still skips the git walk.
    const d = await checkMigrationDrift({ checkContent: true });
    if (d.contentDrift === null || d.contentDriftExecutable === null) {
      throw new Error('checkContent:true must measure content drift');
    }
    for (const entry of d.contentDrift) {
      expect(entry.classification).toBe('unclassified');
      expect(entry.classificationDetail).toMatch(/did not request classification/);
    }
    // Unclassified counts as hazardous, so skipping the work can never make
    // drift look benign — the whole set stays in the actionable subset.
    expect(d.contentDriftExecutable.length).toBe(d.contentDrift.length);
  });

  /**
   * The opt-in path: `db:check_drift` passes classifyContent, and the verdict
   * must partition cleanly — `contentDriftExecutable` is exactly the entries
   * that are NOT proven benign.
   */
  it('classifyContent:true partitions drift into benign vs actionable', async () => {
    const d = await checkMigrationDrift({ classifyContent: true });
    if (d.contentDrift === null || d.contentDriftExecutable === null) {
      throw new Error('classifyContent:true must measure content drift');
    }
    if (d.contentDrift.length === 0) return; // nothing drifted here — nothing to assert
    for (const entry of d.contentDrift) {
      expect(['executable', 'comments-only', 'unclassified']).toContain(entry.classification);
      expect(entry.classificationDetail.length).toBeGreaterThan(0);
    }
    const benign = d.contentDrift.filter((e) => e.classification === 'comments-only');
    // The actionable subset is the complement of the benign one — never a
    // superset (which would defeat the point) and never missing a hazard.
    expect(d.contentDriftExecutable.length).toBe(d.contentDrift.length - benign.length);
    for (const e of d.contentDriftExecutable) expect(e.classification).not.toBe('comments-only');
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
