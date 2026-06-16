import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import AdminShell from '../../components/admin/AdminShell';
import { SubstrateSummaryCardClient } from '@/app/harness/insights/SubstrateSummaryCardClient';
import { BootHistoryTableClient } from '@/app/harness/insights/BootHistoryTableClient';
import { SubstrateHealthPill } from '@/app/harness/insights/SubstrateHealthPill';
import { ClaimAttemptTimelineClient } from '@/app/harness/insights/ClaimAttemptTimelineClient';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /admin/dogfood-substrate — Vite-side mirror of the SSR diagnostic
 * page at `apps/operator/app/admin/dogfood-substrate/page.tsx`.
 *
 * The operator-vite SPA owns admin routes for the live Tauri shell,
 * so the SSR version is unreachable until this route exists.
 *
 * Uses the client wrappers shipped in apps/operator/app/harness/insights/
 * — they self-fetch /api/admin/dogfood-substrate-* so the route is
 * a thin composition.
 */

export const Route = createFileRoute('/admin/dogfood-substrate')({
  component: DogfoodSubstratePage,
});

interface HealthResponse {
  summary?: {
    enabled: boolean;
    totalHarnesses: number;
    healthy: number;
    booting: number;
    degraded: number;
    unhealthy: number;
    disabled: number;
    worstVerdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy';
  };
  harnesses?: Array<{
    workspaceId: string;
    harnessSlug: string;
    verdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy';
    reasons?: string[];
  }>;
}

function DogfoodSubstratePage() {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const [resp, setResp] = useState<HealthResponse | null>(null);
  const [pickedSlug, setPickedSlug] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetch('/api/admin/dogfood-substrate-health', { cache: 'no-store' });
        if (!r.ok) return;
        const json = (await r.json()) as HealthResponse;
        if (!cancelled) setResp(json);
      } catch {
        // hold last-known
      }
    };
    void run();
    const t = setInterval(() => void run(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const rows =
    (resp?.harnesses ?? []).filter(
      (h) => h.workspaceId !== '' && h.harnessSlug !== '',
    );

  return (
    <AdminShell title="Substrate diagnostic">
      <div style={{ padding: '16px max(24px, calc((100% - 960px) / 2))', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SubstrateSummaryCardClient diagnosticHref={undefined} />

        <p style={{ fontSize: 13, color: 'var(--fg-dim, #888)', margin: 0 }}>
          Hyperbee substrate boot state for this operator process. The substrate
          always boots — each shared harness joins its swarm in-process.
        </p>

        {rows.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-dim, #888)' }} data-testid="dogfood-substrate-empty">
            No shared {t('pot', { plural: true, lower: true })} booted yet.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="dogfood-substrate-table">
            <thead>
              <tr>
                <th style={th}>Workspace</th>
                <th style={th}>{t('pot')}</th>
                <th style={th}>Health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={`${h.workspaceId}::${h.harnessSlug}`} data-testid={`dogfood-substrate-row-${h.harnessSlug}`}>
                  <td style={td}><code>{h.workspaceId}</code></td>
                  <td style={td}><code>{h.harnessSlug}</code></td>
                  <td style={td}>
                    <SubstrateHealthPill verdict={h.verdict} reasons={h.reasons} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <section style={{ marginTop: 12 }} data-testid="dogfood-substrate-boot-history-section">
          <h2 style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-dim, #888)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
            Boot history
          </h2>
          <BootHistoryTableClient limit={50} />
        </section>

        <section style={{ marginTop: 12 }} data-testid="dogfood-substrate-claim-attempts-section">
          <h2 style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-dim, #888)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
            Claim attempts
            {rows.length > 0 && (
              <select
                data-testid="claim-attempts-harness-picker"
                value={pickedSlug || rows[0].harnessSlug}
                onChange={(e) => setPickedSlug(e.target.value)}
                style={{ fontSize: 11, fontWeight: 400, padding: '2px 6px', textTransform: 'none', letterSpacing: 0 }}
              >
                {rows.map((h) => (
                  <option key={h.harnessSlug} value={h.harnessSlug}>
                    {h.harnessSlug}
                  </option>
                ))}
              </select>
            )}
          </h2>
          {rows.length > 0 ? (
            <ClaimAttemptTimelineClient slug={pickedSlug || rows[0].harnessSlug} limit={50} />
          ) : (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--fg-dim, #888)' }}>
              No {t('pot', { plural: true, lower: true })} booted — claim attempts only record under a booted substrate.
            </div>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

const th = {
  textAlign: 'left' as const,
  borderBottom: '1px solid var(--border, #2a2a2a)',
  padding: '8px 12px',
  fontWeight: 600,
  color: 'var(--fg-dim, #888)',
  fontSize: 11,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
};

const td = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle, #222)',
};
