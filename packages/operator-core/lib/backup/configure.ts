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

import { getOrgPg } from '@papercusp/db-org';
import { workspacesRoot } from '../workspace-registry';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { shouldRun } from '../search/battery-policy';
import { configureBackup } from '@papercusp/backup';

configureBackup({
  // Called per use (not cached) so getOrgPg's discovery-file change
  // detection fires — see getOrgPg's own doc-comment.
  getSql: () => getOrgPg().sql,
  workspacesRoot,
  // Backup tables are defined by the migration baseline now; the host seam
  // is a no-op.
  ensureSchema: async () => {},
  getHarnessAdminUrl: getHarnessAdminUrlWithSource,
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
