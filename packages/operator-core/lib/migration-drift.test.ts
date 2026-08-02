import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeSchemaAhead,
  classifyMissingByDeployedTree,
  computeContentDrift,
  resolveDeployedSqlDir,
  resolveSqlDir,
  resolveCanonicalStagingSqlDir,
} from './migration-drift';

/**
 * EI-19365742982915607: an applied migration edited AFTER it ran. The edit
 * never executes (the runner skips anything already recorded), so the file on
 * disk silently misdescribes the live schema — forever.
 *
 * The real case this reproduces: mig 708 ran at 2026-08-01T19:15:49Z against a
 * blob containing zero `closed_ts`; a PART 2 hunk was committed 9 minutes
 * later. PART 1 was live, PART 2 never was, and every reader who grepped the
 * .sql concluded closed_ts federation had shipped.
 */
describe('computeContentDrift', () => {
  const rows = (...pairs: Array<[string, string | null]>) =>
    pairs.map(([filename, sha256]) => ({ filename, sha256 }));

  it('flags an applied migration whose bytes changed after it ran', () => {
    expect(
      computeContentDrift(
        rows(['708-federate.sql', 'recorded-sha'], ['707-fine.sql', 'same']),
        new Map([
          ['708-federate.sql', 'edited-sha'],
          ['707-fine.sql', 'same'],
        ]),
      ),
    ).toEqual([
      {
        filename: '708-federate.sql',
        recordedSha256: 'recorded-sha',
        diskSha256: 'edited-sha',
      },
    ]);
  });

  it('is empty when every applied file still matches its recorded hash', () => {
    expect(
      computeContentDrift(
        rows(['001-a.sql', 'aaa'], ['002-b.sql', 'bbb']),
        new Map([
          ['001-a.sql', 'aaa'],
          ['002-b.sql', 'bbb'],
        ]),
      ),
    ).toEqual([]);
  });

  it('a legacy row with no recorded sha256 is UNJUDGEABLE, never reported as drift', () => {
    // Absence of evidence is not evidence of drift — reporting these would
    // bury the real signal under every pre-sha256 migration in history.
    expect(
      computeContentDrift(
        rows(['001-legacy.sql', null], ['002-blank.sql', '  ']),
        new Map([
          ['001-legacy.sql', 'whatever'],
          ['002-blank.sql', 'whatever'],
        ]),
      ),
    ).toEqual([]);
  });

  it('a file gone from disk is `extra`, not content drift (no double reporting)', () => {
    expect(computeContentDrift(rows(['600-squashed.sql', 'sha']), new Map())).toEqual([]);
  });

  it('ignores runner-ineligible rows (templates / manual-only)', () => {
    expect(
      computeContentDrift(
        rows(['999-per-harness-template.sql', 'sha'], ['040-plugin-configs-backfill.sql', 'sha']),
        new Map([
          ['999-per-harness-template.sql', 'different'],
          ['040-plugin-configs-backfill.sql', 'different'],
        ]),
      ),
    ).toEqual([]);
  });

  it('reports every drifted file, sorted by filename', () => {
    expect(
      computeContentDrift(
        rows(['710-c.sql', 'r3'], ['700-a.sql', 'r1'], ['705-b.sql', 'r2']),
        new Map([
          ['710-c.sql', 'd3'],
          ['700-a.sql', 'd1'],
          ['705-b.sql', 'd2'],
        ]),
      ).map((d) => d.filename),
    ).toEqual(['700-a.sql', '705-b.sql', '710-c.sql']);
  });
});

/**
 * WI-5050 (WI-4070 class): `schemaAhead` flags applied migrations numbered
 * beyond anything the running code tree ships — a stale operator against a
 * newer-migrated shared DB (the dev-source rot that silently killed VM
 * federation via the mig-557 hives→pots rename).
 */
describe('computeSchemaAhead', () => {
  const onDisk = ['001-a.sql', '002-b.sql', '557-hives-to-pots.sql'];

  it('is empty when the DB has nothing newer than the code tree', () => {
    expect(computeSchemaAhead(onDisk, ['001-a.sql', '002-b.sql'])).toEqual([]);
    expect(computeSchemaAhead(onDisk, onDisk)).toEqual([]);
  });

  it('flags applied migrations numbered beyond the on-disk cap', () => {
    expect(
      computeSchemaAhead(onDisk, ['001-a.sql', '558-newer.sql', '614-adjacency-state.sql']),
    ).toEqual(['558-newer.sql', '614-adjacency-state.sql']);
  });

  it('ignores non-numbered / runner-ineligible applied rows', () => {
    expect(
      computeSchemaAhead(onDisk, ['999-per-harness-template.sql', 'notes.txt', 'zzz.sql']),
    ).toEqual([]);
  });

  it('returns empty when the code tree has no numbered migrations (unknown ≠ ahead)', () => {
    expect(computeSchemaAhead([], ['558-newer.sql'])).toEqual([]);
    expect(computeSchemaAhead(['README.md'], ['558-newer.sql'])).toEqual([]);
  });

  it('an applied row EQUAL to the cap is not "ahead"', () => {
    expect(computeSchemaAhead(onDisk, ['557-hives-to-pots.sql'])).toEqual([]);
  });
});

/**
 * WI-6037: `missing` alone can't distinguish a genuine unapplied migration from the
 * normal staging-ahead-of-release window (the staging tree legitimately contains
 * migration files the release tree hasn't received yet). classifyMissingByDeployedTree
 * splits `missing` against what's actually on disk in the DEPLOYED tree.
 */
describe('classifyMissingByDeployedTree', () => {
  const missing = ['670-a.sql', '671-b.sql', '672-c.sql'];

  it('splits into deployed (real hazard) vs pending-deploy (staging-ahead noise)', () => {
    // 670/671 exist in the deployed tree (genuinely unapplied there); 672 is staging-only.
    expect(classifyMissingByDeployedTree(missing, ['670-a.sql', '671-b.sql', '900-other.sql'])).toEqual({
      missingDeployed: ['670-a.sql', '671-b.sql'],
      missingPendingDeploy: ['672-c.sql'],
    });
  });

  it('the staging-ahead case: nothing missing exists in the deployed tree', () => {
    expect(classifyMissingByDeployedTree(missing, ['001-old.sql'])).toEqual({
      missingDeployed: [],
      missingPendingDeploy: missing,
    });
  });

  it('the masking-control case: everything missing also exists in the deployed tree', () => {
    expect(classifyMissingByDeployedTree(missing, missing)).toEqual({
      missingDeployed: missing,
      missingPendingDeploy: [],
    });
  });

  it('null deployedOnDisk (tree unresolvable) fails TOWARD reporting, not silent suppression', () => {
    expect(classifyMissingByDeployedTree(missing, null)).toEqual({
      missingDeployed: missing,
      missingPendingDeploy: [],
    });
  });

  it('is empty-safe', () => {
    expect(classifyMissingByDeployedTree([], [])).toEqual({ missingDeployed: [], missingPendingDeploy: [] });
    expect(classifyMissingByDeployedTree([], null)).toEqual({ missingDeployed: [], missingPendingDeploy: [] });
  });
});

/**
 * EI-18737837917400418: a packaged/headless deploy (a Tauri sidecar, a
 * standalone rig install) has no repo tree above cwd, so `resolveSqlDir` MUST
 * be resolvable from `PAPERCUSP_PG_SQL_DIR` alone — it used to try only
 * repo-relative candidates and silently return null on such a layout, which
 * skipped the EI-13992 boot-apply safety net on every boot.
 */
describe('resolveSqlDir', () => {
  const tmpRoots: string[] = [];
  const savedEnv = process.env.PAPERCUSP_PG_SQL_DIR;

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PAPERCUSP_PG_SQL_DIR;
    else process.env.PAPERCUSP_PG_SQL_DIR = savedEnv;
  });

  it('resolves from PAPERCUSP_PG_SQL_DIR alone with NO repo tree above cwd (packaged layout)', () => {
    // A cwd with nothing above it resembling libs/papercusp/libs/db/sql — the
    // packaged-install case that used to fall through to null.
    const packagedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-packaged-'));
    tmpRoots.push(packagedCwd);
    const envSqlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-env-sql-'));
    tmpRoots.push(envSqlDir);
    fs.writeFileSync(path.join(envSqlDir, '001-a.sql'), '-- noop\n');

    process.env.PAPERCUSP_PG_SQL_DIR = envSqlDir;
    expect(resolveSqlDir(packagedCwd)).toBe(envSqlDir);
  });

  it('falls back to repo-relative candidates when the env var is unset', () => {
    delete process.env.PAPERCUSP_PG_SQL_DIR;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-inrepo-'));
    tmpRoots.push(parent);
    const sqlDir = path.join(parent, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    expect(resolveSqlDir(parent)).toBe(sqlDir);
  });

  it('falls back to repo-relative candidates when the env var points at a nonexistent dir', () => {
    process.env.PAPERCUSP_PG_SQL_DIR = '/definitely/not/a/real/dir/xyz';
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-inrepo2-'));
    tmpRoots.push(parent);
    const sqlDir = path.join(parent, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    expect(resolveSqlDir(parent)).toBe(sqlDir);
  });

  it('returns null when neither the env var nor any repo-relative candidate exists', () => {
    process.env.PAPERCUSP_PG_SQL_DIR = '/definitely/not/a/real/dir/xyz';
    const packagedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-nothing-'));
    tmpRoots.push(packagedCwd);
    expect(resolveSqlDir(packagedCwd)).toBeNull();
  });
});

/**
 * resolveDeployedSqlDir: recovers the release-tree sql dir from an already-resolved
 * on-disk sql dir, using a `papercup-release` sibling of the tree's parent dir — no
 * git/env lookup needed for the common case. Verified against a real fixture tree
 * (not mocked) so the path-arithmetic itself is exercised, not just its assumption.
 */
describe('resolveDeployedSqlDir', () => {
  const tmpRoots: string[] = [];
  // Guard against an ambient PAPERCUSP_RELEASE_ROOT in the test-runner's own env
  // (set on a real :3070/:3170 host) shadowing the fixture sibling these tests rely on.
  const savedReleaseRootEnv = process.env.PAPERCUSP_RELEASE_ROOT;
  function makeTree(name: string, hasFile: boolean): string {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-test-'));
    tmpRoots.push(parent);
    const treeRoot = path.join(parent, name);
    const sqlDir = path.join(treeRoot, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    if (hasFile) fs.writeFileSync(path.join(sqlDir, '670-a.sql'), '-- noop\n');
    return parent;
  }

  beforeEach(() => {
    delete process.env.PAPERCUSP_RELEASE_ROOT;
  });

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedReleaseRootEnv === undefined) delete process.env.PAPERCUSP_RELEASE_ROOT;
    else process.env.PAPERCUSP_RELEASE_ROOT = savedReleaseRootEnv;
  });

  it('returns null for a bogus sqlDir (no such tree)', () => {
    expect(resolveDeployedSqlDir(null)).toBeNull();
    expect(resolveDeployedSqlDir('/definitely/not/a/real/path/libs/papercusp/libs/db/sql')).toBeNull();
  });

  it('resolves the sibling papercup-release tree when it exists', () => {
    const parent = makeTree('papercusp', false);
    fs.mkdirSync(path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql'), { recursive: true });
    const currentSqlDir = path.join(parent, 'papercusp/libs/papercusp/libs/db/sql');
    expect(resolveDeployedSqlDir(currentSqlDir)).toBe(
      path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql'),
    );
  });

  it('resolves to itself when the current tree IS the release checkout', () => {
    // If this process is already running FROM papercup-release, its parent's
    // "papercup-release" sibling is itself — deployedSqlDir === sqlDir (no noise).
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-test-'));
    tmpRoots.push(parent);
    const releaseSqlDir = path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql');
    fs.mkdirSync(releaseSqlDir, { recursive: true });
    expect(resolveDeployedSqlDir(releaseSqlDir)).toBe(releaseSqlDir);
  });

  it('returns null when there is no papercup-release sibling at all', () => {
    const parent = makeTree('papercusp', false);
    const currentSqlDir = path.join(parent, 'papercusp/libs/papercusp/libs/db/sql');
    expect(resolveDeployedSqlDir(currentSqlDir)).toBeNull();
  });
});

/**
 * EI-18757486483124756: `resolveCanonicalStagingSqlDir` resolves the CANONICAL
 * tree agents author migrations in (`PAPERCUSP_INTEGRATION_ROOT`) directly —
 * unlike `resolveDeployedSqlDir`, it does NOT derive from whatever tree is
 * currently running, so it still finds the canonical tree even when the
 * current process IS the release checkout (db:next-migration already solved
 * this identical problem, EI-353, the same way).
 */
describe('resolveCanonicalStagingSqlDir', () => {
  const tmpRoots: string[] = [];
  const savedEnv = process.env.PAPERCUSP_INTEGRATION_ROOT;

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = savedEnv;
  });

  it('returns null when PAPERCUSP_INTEGRATION_ROOT is unset', () => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    expect(resolveCanonicalStagingSqlDir()).toBeNull();
  });

  it('resolves libs/papercusp/libs/db/sql under PAPERCUSP_INTEGRATION_ROOT when it exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-'));
    tmpRoots.push(root);
    const sqlDir = path.join(root, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBe(sqlDir);
  });

  it('returns null when PAPERCUSP_INTEGRATION_ROOT is set but has no sql dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-empty-'));
    tmpRoots.push(root);
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBeNull();
  });

  it('is independent of the CURRENT tree — unlike resolveDeployedSqlDir, it does not derive from a sibling', () => {
    // Simulate the exact bug: PAPERCUSP_INTEGRATION_ROOT names a tree that is
    // NOT any sibling relationship of "current" — it is found directly.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-direct-'));
    tmpRoots.push(root);
    const sqlDir = path.join(root, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(sqlDir, '680-new.sql'), '-- noop\n');
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBe(sqlDir);
  });
});
