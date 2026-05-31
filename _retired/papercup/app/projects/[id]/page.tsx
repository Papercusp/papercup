'use client';

/**
 * Project detail — Zero-driven, target of /projects row clicks.
 *
 * Activates two previously-unused named queries:
 *   - queries.projects.byId({ id })        — single-row project fetch
 *   - queries.messages.byProject({ id })   — all messages tagged with this project
 *
 * Stats + status + budget rail + an embedded mini-RichGrid of related
 * messages, all live via the harness Zero WebSocket.
 */
import Link from 'next/link';
import { useMemo, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@rocicorp/zero/react';
import {
  queries,
  type ProjectRow,
  type MessageRow,
} from '@papercusp/zero-harness';
import { RichGrid, applySort, type ColumnDef, type RichGridSortState } from '@papercusp/grid-core';

const KIND_COLOR: Record<string, string> = {
  Directive: '#fbbf24',
  ProjectKickoff: '#a78bfa',
  Priority: '#7aa2f7',
  Decision: '#9ece6a',
  BudgetAllocation: '#f7768e',
  ProgressUpdate: '#7aa2f7',
  BuildRequest: '#bb9af7',
  BuildRequestResponse: '#bb9af7',
  Capability: '#9ece6a',
  PlatformUpdate: '#e0af68',
  FeasibilityQuery: '#7dcfff',
  FeasibilityResponse: '#7dcfff',
  LaunchReady: '#9ece6a',
  MarketSignal: '#ff9e64',
  Campaign: '#ff9e64',
  ProjectSpinout: '#bb9af7',
};

const STATUS_TONE: Record<string, string> = {
  in_progress: '#34d399',
  proposed: '#a3a3a3',
  approved: '#7aa2f7',
  launched: '#7aa2f7',
  paused: '#fbbf24',
  cancelled: '#f87171',
};

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtMoney(cents: number | undefined | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtPct(num: number, denom: number | undefined | null): string {
  if (!denom || denom <= 0) return '—';
  return `${Math.round((num / denom) * 100)}%`;
}

const META_LABEL: CSSProperties = {
  fontSize: 10,
  color: '#7c89b1',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const META_VALUE: CSSProperties = {
  fontSize: 14,
  color: '#e7ecf3',
  fontFamily: 'ui-monospace, monospace',
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();

  const [project, projInfo] = useQuery(queries.projects.byId({ id }));
  const [messages] = useQuery(queries.messages.byProject({ id }));

  const p = project as ProjectRow | undefined;
  const tone = useMemo(() => (p ? STATUS_TONE[p.status] ?? '#8a96ad' : '#8a96ad'), [p]);
  const pct = useMemo(() => {
    if (!p?.budgetCents || p.budgetCents <= 0) return 0;
    return Math.min(100, Math.round((p.spentCents / p.budgetCents) * 100));
  }, [p]);

  const [messageSort, setMessageSort] = useState<RichGridSortState | null>(null);
  const sortedMessages = useMemo(() => applySort(messages as MessageRow[], messageSort), [messages, messageSort]);

  const messageColumns = useMemo<ColumnDef<MessageRow>[]>(() => [
    {
      key: 'ts',
      header: 'When',
      width: 0.8,
      align: 'left',
      sortKey: 'ts',
      defaultSortDir: 'desc',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>
          {relTime(row.ts)}
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.4,
      align: 'left',
      sortKey: 'kind',
      render: ({ row }) => {
        const c = KIND_COLOR[row.kind] ?? '#7aa2f7';
        return (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            color: c,
            background: `color-mix(in oklab, ${c}, transparent 88%)`,
          }}>
            {row.kind}
          </span>
        );
      },
    },
    {
      key: 'from',
      header: 'From',
      width: 1.0,
      align: 'left',
      sortKey: 'fromDept',
      render: ({ row }) => (
        <span style={{ fontSize: 12, color: '#e7ecf3', fontFamily: 'ui-monospace, monospace' }}>
          {row.fromDept}
        </span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      width: 4,
      align: 'left',
      sortKey: 'subject',
      render: ({ row }) => (
        <Link
          href={`/messages/${row.id}`}
          style={{ fontSize: 12, color: '#e7ecf3', textDecoration: 'none' }}
        >
          {row.subject}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 0.8,
      align: 'left',
      sortKey: 'status',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#7c89b1' }}>{row.status}</span>
      ),
    },
  ], []);

  if (!id) {
    return <div style={{ padding: 24, color: '#e7ecf3' }}>Missing project id.</div>;
  }

  if (projInfo?.type === 'complete' && !p) {
    return (
      <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif' }}>
        <Link href="/projects" style={{ color: '#7aa2f7', fontSize: 12 }}>← back to projects</Link>
        <p style={{ marginTop: 12 }}>Project <code>{id}</code> not found.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            background: 'transparent', border: 'none', color: '#7aa2f7',
            fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 8,
          }}
        >
          ← back
        </button>
        {p ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 4,
                color: tone,
                background: `color-mix(in oklab, ${tone}, transparent 86%)`,
                border: `1px solid ${tone}55`,
              }}>{p.status.replace(/_/g, ' ')}</span>
              {p.vertical && (
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, background: '#1f2738', color: '#8a96ad' }}>
                  {p.vertical}
                </span>
              )}
              <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{p.id}</span>
              <span style={{ fontSize: 11, color: '#7c89b1' }}>created {relTime(p.createdTs)}</span>
            </div>
            <h1 style={{ fontSize: 22, margin: 0 }}>{p.name}</h1>
          </>
        ) : (
          <p style={{ fontSize: 12, color: '#7c89b1' }}>Loading…</p>
        )}
      </header>

      {p && (
        <>
          <section style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12,
            padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
            background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
          }}>
            <div>
              <div style={META_LABEL}>Owner</div>
              <div style={META_VALUE}>{p.owningDept ?? 'Management'}</div>
            </div>
            <div>
              <div style={META_LABEL}>Budget</div>
              <div style={META_VALUE}>{fmtMoney(p.budgetCents)}</div>
            </div>
            <div>
              <div style={META_LABEL}>Spent</div>
              <div style={{
                ...META_VALUE,
                color: p.spentCents > 0 ? '#fbbf24' : '#7c89b1',
              }}>
                {fmtMoney(p.spentCents)}
              </div>
            </div>
            <div>
              <div style={META_LABEL}>Used</div>
              <div style={META_VALUE}>{fmtPct(p.spentCents, p.budgetCents)}</div>
            </div>
          </section>

          <section style={{ marginBottom: 16 }}>
            <div style={{ ...META_LABEL, marginBottom: 6 }}>Budget utilization</div>
            <div style={{ height: 8, background: 'rgba(124,137,177,0.15)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${pct}%`, height: '100%',
                background: pct >= 100 ? '#f7768e' : pct >= 80 ? '#fbbf24' : '#9ece6a',
                transition: 'width 200ms ease',
              }} />
            </div>
          </section>

          {p.metadata && Object.keys(p.metadata as Record<string, unknown>).length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <div style={{ ...META_LABEL, marginBottom: 6 }}>Metadata</div>
              <pre style={{
                background: '#0a0d12', border: '1px solid #1f2738', borderRadius: 6,
                padding: 12, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                margin: 0, fontFamily: 'ui-monospace, monospace', color: '#8a96ad',
              }}>
                {JSON.stringify(p.metadata, null, 2)}
              </pre>
            </section>
          )}
        </>
      )}

      <section>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Related messages ({(messages as MessageRow[]).length})
        </h2>
        <div style={{ minHeight: 200, maxHeight: 500, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<MessageRow>
            columns={messageColumns}
            rows={sortedMessages}
            getRowId={(m) => m.id}
            sortState={messageSort}
            onSortChange={setMessageSort}
            onRowClick={(m) => router.push(`/messages/${m.id}`)}
            empty="No messages tagged with this project yet."
            rowMinHeight={32}
            headerHeight={28}
          />
        </div>
      </section>
    </div>
  );
}
