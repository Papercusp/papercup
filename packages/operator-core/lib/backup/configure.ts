/**
 * Operator host binding for `@papercusp/backup`.
 *
 * Wires the host seams the backup package needs — the org Postgres
 * handle, the workspaces-root path, the backup-table schema bootstrap,
 * the embedded-pg admin URL (for the pre-snapshot DB dump), and the
 * optional battery-aware sweep pause. Imported for its side-effect by
 * `./index` and the deep-path shims (`./scheduler`, `./orphan-cleanup`)
 * so `configureBackup()` runs before any backup API is used, regardless
 * of which entry point a consumer hits.
 *
 * Part of papercusp-systems-abstraction-2026-05-29 P-023/P-024.
 */

import postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, workspacesRoot } from '../workspace-registry';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { shouldRun } from '../search/battery-policy';
import { configureBackup } from '@papercusp/backup';
import {
  BACKUP_MIGRATION_ADVISORY_LOCK_KEY,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from '@papercusp/backup/application-names';
import { readQualificationAdmission } from '../release-checkpoint-config';
import { readCheckpointSerializerAuthority } from '../release/checkpoint-serializer-authority';

configureBackup({
  // Called per use (not cached) so getOrgPg's discovery-file change
  // detection fires — see getOrgPg's own doc-comment.
  getSql: () => getOrgPg().sql,
  // Wrapped, NOT passed by reference. `configureBackup` runs at module-eval
  // time (this file is imported for its side-effect), so passing the imported
  // binding directly DEREFERENCES `../workspace-registry` the instant anything
  // in the agent-tools import graph is loaded. Under vitest that graph is
  // routinely reached from unrelated prompt/registry suites whose
  // `vi.mock('../workspace-registry', () => ({ activeWorkspaceId }))` is a
  // partial mock — and reading a property the mock does not define is a HARD
  // vitest throw ("No \"workspacesRoot\" export is defined on the ... mock"),
  // failing the whole suite file at import. Deferring the read to call time
  // keeps every host seam here lazy (same reasoning as getSql above) so a
  // partial mock upstream can never strand an unrelated test file.
  workspacesRoot: () => workspacesRoot(),
  // Backup tables are defined by the migration baseline now; the host seam
  // is a no-op.
  ensureSchema: async () => {},
  // Wrapped for the same module-eval-time reason as `workspacesRoot` above:
  // every host seam on this object stays lazy so no partial mock of a source
  // module can throw while this side-effect import is being evaluated.
  getHarnessAdminUrl: () => getHarnessAdminUrlWithSource(),
  /**
   * Keep the rendezvous on a dedicated max:1 postgres-js session. The normal
   * org handle is pooled, so an advisory lock acquired through it could land
   * on a different connection from the later snapshot work and release early.
   * This handle owns exactly one session for the whole snapshot lifecycle.
   */
  acquireMigrationLock: async () => {
    const { url } = getHarnessAdminUrlWithSource();
    const client = postgres(url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: WORKSPACE_BACKUP_APPLICATION_NAME },
    });
    try {
      await client`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
    } catch (error) {
      await client.end({ timeout: 5 }).catch(() => {});
      throw error;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
        } finally {
          // Closing the session is the final safety net: PostgreSQL releases a
          // session advisory lock even if the explicit unlock fails.
          await client.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  },
  // Interval-only release rendezvous. Every workspace pre-snapshot hook dumps
  // the SAME operator Postgres database, so its AccessShareLocks share one
  // lock domain even when the snapshot's filesystem workspace differs. Anchor
  // both release-authority reads to the operator-home workspace that owns the
  // checkpoint routine/serializer; using the snapshot workspace here lets a
  // sibling workspace's dump bypass the hold and re-enter the qualification
  // window. Reads remain fresh, and unknown/unreadable authority fails closed
  // for this tick. Manual and pre-destructive snapshots still bypass this host
  // seam in @papercusp/backup.
  readIntervalSnapshotAdmission: async (_snapshotWorkspaceId) => {
    const releaseWorkspaceId = activeWorkspaceId();
    const [qualification, serializer] = await Promise.all([
      readQualificationAdmission({ workspaceId: releaseWorkspaceId }),
      readCheckpointSerializerAuthority({ workspaceId: releaseWorkspaceId }),
    ]);
    if (qualification.status === 'unknown') {
      return {
        status: 'defer',
        reason: 'qualification-admission-unreadable',
        evidence: { error: qualification.reason },
      };
    }
    if (qualification.status === 'held') {
      return {
        status: 'defer',
        reason: 'qualification-held',
        evidence: {
          governingRef: qualification.hold.governingRef,
          blockingItems: qualification.hold.blockingItems ?? [],
        },
      };
    }
    if (serializer.status === 'unreadable') {
      return {
        status: 'defer',
        reason: 'checkpoint-serializer-unreadable',
        evidence: { error: serializer.error },
      };
    }
    if (serializer.status === 'held') {
      return {
        status: 'defer',
        reason: 'checkpoint-serializer-held',
        evidence: { itemId: serializer.itemId, ownerId: serializer.ownerId },
      };
    }
    return { status: 'admit' };
  },
  // Battery-aware pause for the orphan sweep. Resilient: any failure
  // resolving the decision means "don't pause" (the sweep is cheap).
  shouldPauseSweep: () => {
    try {
      return shouldRun() === 'pause';
    } catch {
      return false;
    }
  },
});
