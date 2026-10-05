/**
 * `system:connector-sync` — the routine that runs the ONE host-owned connector
 * sync driver over every registered provider (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05 P-004 / R-3). Seeded by migration
 * 1360. Per-provider poll actions are retired as each provider moves onto the
 * driver (Gmail P-008, Calendar P-009, GitHub issues P-010).
 */
import { getOrgPg } from '@papercusp/db-org';
import { formatConnectorSyncLog, runConnectorSync } from '../../providers/connector-runtime';
import { registerSystemAction } from './system-actions';

registerSystemAction('connector-sync', async (ctx) => {
  const result = await runConnectorSync(getOrgPg().sql, {
    workspaceId: ctx.workspaceId,
    harness: ctx.installSlug,
  });
  if (result.sources.length > 0) console.log(formatConnectorSyncLog(result));
  const failed = result.sources.filter((source) => source.outcome === 'failed' || source.outcome === 'reconnect-required');
  return {
    diagnostics: {
      providers: result.providers,
      sources: result.sources.length,
      failed: failed.length,
      admitted: result.sources.reduce((n, source) => n + source.admitted, 0),
    },
    ...(failed.length > 0
      ? { softError: `connector-sync: ${failed.length} source(s) failed: ${failed.map((s) => `${s.sourceId}:${s.error ?? s.outcome}`).join('; ').slice(0, 1000)}` }
      : {}),
  };
});
