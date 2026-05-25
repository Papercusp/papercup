/**
 * /admin/dogfood-substrate — substrate boot diagnostic page.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Composes the substrate-status JSON endpoint with the per-harness
 * claim-attempts stats. Useful for verifying:
 *
 *   1. PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE took effect (top badge).
 *   2. Each expected harness successfully booted (rows below).
 *   3. The claim-audit table has rows for each harness (won/lost/error).
 *
 * Server-rendered: every metric is fetched on render via the in-process
 * sql + loaders so the page is always fresh and never depends on a
 * separate client-side fetch.
 */

import { getOrgPg } from '@restart/db-org';
import { listBootedHandles } from '@/lib/sync/hyperbee/boot-all';
import { listBootstrapProgress } from '@/lib/sync/hyperbee/bootstrap-progress';
import { loadClaimAttemptStats } from '@/lib/orchestrator/load-claim-attempts';
import { assessHarnessSubstrateHealth } from '@/lib/sync/hyperbee/health';
import { SubstrateStatusBadge } from '../../harness/insights/SubstrateStatusBadge';
import { ClaimAttemptStatsPill } from '../../harness/insights/ClaimAttemptStatsPill';
import { BootstrapProgressIndicator } from '../../harness/insights/BootstrapProgressIndicator';
import { SubstrateHealthPill } from '../../harness/insights/SubstrateHealthPill';

export const dynamic = 'force-dynamic';

const PAGE_STYLE = {
  padding: '32px max(24px, calc((100% - 960px) / 2))',
  fontFamily: 'inherit',
  color: 'var(--fg, #ddd)',
} as const;

const HEADER_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  marginBottom: 24,
} as const;

const TITLE = {
  fontSize: 22,
  fontWeight: 600,
} as const;

const TABLE = {
  width: '100%',
  borderCollapse: 'collapse' as const,
  fontSize: 13,
};

const TH = {
  textAlign: 'left' as const,
  borderBottom: '1px solid var(--border, #2a2a2a)',
  padding: '8px 12px',
  fontWeight: 600,
  color: 'var(--fg-dim, #888)',
  fontSize: 11,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
};

const TD = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle, #222)',
};

const EMPTY = {
  fontSize: 13,
  color: 'var(--fg-dim, #888)',
  padding: '24px 0',
};

export default async function DogfoodSubstratePage() {
  const enabled = process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE === '1';
  const booted = listBootedHandles();
  const { sql } = getOrgPg();
  const runQuery = async <T,>(
    query: string,
    paramsArr: unknown[],
  ): Promise<T[]> => {
    return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
  };
  const statsBySlug = new Map<string, Awaited<ReturnType<typeof loadClaimAttemptStats>>>();
  await Promise.all(
    booted.map(async (h) => {
      const stats = await loadClaimAttemptStats({
        workspace_id: h.workspaceId,
        harness_slug: h.harnessSlug,
        runQuery,
      });
      statsBySlug.set(`${h.workspaceId}::${h.harnessSlug}`, stats);
    }),
  );

  const progressBySlug = new Map<
    string,
    ReturnType<typeof listBootstrapProgress>[number]
  >();
  for (const snap of listBootstrapProgress()) {
    progressBySlug.set(`${snap.workspaceId}::${snap.harnessSlug}`, snap);
  }

  const topStatus = !enabled ? 'disabled' : booted.length > 0 ? 'booted' : 'booting';
  const hint = !enabled
    ? null
    : booted.length > 0
      ? `${booted.length} harness${booted.length === 1 ? '' : 'es'}`
      : null;

  return (
    <div style={PAGE_STYLE} data-testid="dogfood-substrate-page">
      <div style={HEADER_ROW}>
        <span style={TITLE}>Substrate diagnostic</span>
        <SubstrateStatusBadge status={topStatus} hint={hint} />
      </div>

      <p
        style={{
          fontSize: 13,
          color: 'var(--fg-dim, #888)',
          marginBottom: 16,
        }}
      >
        Hyperbee substrate boot state for the local process. Gated by{' '}
        <code>PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1</code>; with the flag off
        the operator runs in PG-only mode.
      </p>

      {booted.length === 0 ? (
        <div style={EMPTY}>
          {enabled
            ? 'Flag enabled but no harnesses have booted yet. Watch this page; the orchestrator boots each harness on its own.'
            : 'Flag disabled — no substrate handles in this process. Set PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1 and restart.'}
        </div>
      ) : (
        <table style={TABLE} data-testid="dogfood-substrate-table">
          <thead>
            <tr>
              <th style={TH}>Workspace</th>
              <th style={TH}>Harness</th>
              <th style={TH}>Health</th>
              <th style={TH}>Bootstrap</th>
              <th style={TH}>Claim audit</th>
            </tr>
          </thead>
          <tbody>
            {booted.map((h) => {
              const key = `${h.workspaceId}::${h.harnessSlug}`;
              const stats = statsBySlug.get(key);
              const progress = progressBySlug.get(key);
              const health = assessHarnessSubstrateHealth({
                flagEnabled: enabled,
                handlePresent: true,
                claimStats: stats,
                bootstrapProgress: progress ?? null,
              });
              return (
                <tr
                  key={key}
                  data-testid={`dogfood-substrate-row-${h.harnessSlug}`}
                >
                  <td style={TD}>
                    <code>{h.workspaceId}</code>
                  </td>
                  <td style={TD}>
                    <code>{h.harnessSlug}</code>
                  </td>
                  <td style={TD}>
                    <SubstrateHealthPill
                      verdict={health.verdict}
                      reasons={health.reasons}
                    />
                  </td>
                  <td style={TD}>
                    {progress ? (
                      <BootstrapProgressIndicator
                        totalOps={Math.max(
                          progress.highestSeen,
                          progress.mergedOps,
                        )}
                        mergedOps={progress.mergedOps}
                      />
                    ) : (
                      <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>
                    )}
                  </td>
                  <td style={TD}>
                    {stats && stats.total > 0 ? (
                      <ClaimAttemptStatsPill
                        total={stats.total}
                        won={stats.won}
                        lost={stats.lost}
                        error={stats.error}
                      />
                    ) : (
                      <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
