/**
 * Append an audit row for a feature mutation. Fire-and-forget; never
 * blocks the caller.
 *
 * Writes the canonical row to `harness_shared.feature_audit_consolidated`
 * + a `sync_invalidate` for Zero, then best-effort mirrors to the legacy
 * per-harness `feature_audit` table for any read paths not yet migrated.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 26a) so the features-mutation routes + `issues/:id/promote` +
 * `brainstorm/promote` can call it after they migrate off Hono. Behaviour
 * preserved verbatim; the local `dbcFor` alias is inlined as
 * `getLegacyClient(slug)`.
 */
import { getLegacyClient } from '@restart/db-org';

export function auditFeatureChange(
  harnessSlug: string,
  featureId: string,
  field: string,
  oldValue: any,
  newValue: any,
  actor: string,
): void {
  (async () => {
    try {
      const { db } = (await import('@restart/db-org')).getOrgPg();
      const { generated } = await import('@restart/db-org');
      const { activeWorkspaceId } = await import('@/lib/workspace-registry');
      const ws = activeWorkspaceId();
      await db.insert(generated.featureAuditConsolidatedInHarnessShared).values({
        workspaceId: ws,
        harnessSlug,
        featureId,
        ts: Date.now(),
        field,
        oldValue: oldValue === undefined ? null : JSON.stringify(oldValue),
        newValue: newValue === undefined ? null : JSON.stringify(newValue),
        actor,
      });
      const { notifySyncInvalidate } = await import('@/lib/sync-sse');
      await notifySyncInvalidate('featureAudit.byHarness', { harnessSlug });
      // Best-effort mirror to the legacy per-harness table for any read
      // paths we haven't migrated yet. Don't fail the canonical write on
      // a mirror failure.
      try {
        const c = getLegacyClient(harnessSlug);
        await c.prepare(
          `INSERT INTO feature_audit (ts, harness_slug, feature_id, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          Date.now(),
          harnessSlug,
          featureId,
          field,
          oldValue === undefined ? null : JSON.stringify(oldValue),
          newValue === undefined ? null : JSON.stringify(newValue),
          actor,
        );
      } catch { /* per-harness mirror best-effort, not load-bearing */ }
      return;
    } catch {
      // Fall through to the legacy-only path below.
    }
    try {
      const c = getLegacyClient(harnessSlug);
      await c.prepare(
        `INSERT INTO feature_audit (ts, harness_slug, feature_id, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        harnessSlug,
        featureId,
        field,
        oldValue === undefined ? null : JSON.stringify(oldValue),
        newValue === undefined ? null : JSON.stringify(newValue),
        actor,
      );
    } catch (e) {
      console.warn('[harness] feature audit insert failed:', (e as Error)?.message);
    }
  })();
}
