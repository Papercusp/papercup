import Link from 'next/link';
import { getOrgPg } from '@restart/db-org';

/**
 * /design index — lists harnesses with at least one feature flagged
 * needs_design and links into each. Lets users reach the design tab
 * from the chrome nav without picking a slug from the URL.
 *
 * Server-rendered against PG directly (REST endpoint is workspace-
 * scoped; for the index we want the cross-harness count).
 */
export const dynamic = 'force-dynamic';

interface HarnessRow {
  slug: string;
  total: number;
  needsDesign: number;
  pending: number;
  accepted: number;
  ignored: number;
}

async function loadHarnesses(): Promise<HarnessRow[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        harness_slug: string;
        total: number;
        needs_design: number;
        pending: number;
        accepted: number;
        ignored: number;
      }>
    >`
      SELECT
        harness_slug,
        COUNT(*)::int                                                            AS total,
        COUNT(*) FILTER (WHERE needs_design)::int                                AS needs_design,
        COUNT(*) FILTER (WHERE needs_design AND (design_status IS NULL OR design_status = 'pending'))::int AS pending,
        COUNT(*) FILTER (WHERE needs_design AND design_status = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE needs_design AND design_status = 'ignored')::int  AS ignored
      FROM harness_shared.harness_features_consolidated
      GROUP BY harness_slug
      HAVING COUNT(*) FILTER (WHERE needs_design) > 0
      ORDER BY needs_design DESC
    `;
    return rows.map((r) => ({
      slug: r.harness_slug,
      total: Number(r.total),
      needsDesign: Number(r.needs_design),
      pending: Number(r.pending),
      accepted: Number(r.accepted),
      ignored: Number(r.ignored),
    }));
  } catch {
    return [];
  }
}

export default async function DesignIndexPage() {
  const harnesses = await loadHarnesses();
  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Design</h1>
      <p style={{ color: '#6b7280', marginTop: 8 }}>
        Pick a harness to enter the design tab. Harnesses with at least one
        feature flagged <code>needs_design</code> appear here.
      </p>
      {harnesses.length === 0 ? (
        <p style={{ color: '#6b7280', fontStyle: 'italic', marginTop: 24 }}>
          No harnesses have design-flagged features yet. Create a UI feature in
          any harness; the heuristic auto-flags it via PG trigger 050.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {harnesses.map((h) => (
            <li
              key={h.slug}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}
            >
              <Link
                href={`/design/${encodeURIComponent(h.slug)}`}
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: '#1d4ed8',
                  textDecoration: 'none',
                }}
              >
                {h.slug}
              </Link>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12, color: '#6b7280' }}>
                <span>
                  <strong style={{ color: '#a16207' }}>{h.pending}</strong> pending
                </span>
                <span>
                  <strong style={{ color: '#15803d' }}>{h.accepted}</strong> accepted
                </span>
                <span>
                  <strong style={{ color: '#6b7280' }}>{h.ignored}</strong> ignored
                </span>
                <span style={{ color: '#9ca3af' }}>· {h.total} total</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
