'use client';

/**
 * Department detail — Zero-driven inbox + outbox.
 *
 * Activates the last two unused message-related queries:
 *   - queries.messages.byFromDept({ deptSlug })       — outbox
 *   - queries.messageRecipients.forDept({ deptSlug }) — inbox (joined client-side
 *                                                        with messages.recent for full rows)
 *
 * Department metadata is JSON-backed (departments.json — rare-change), but
 * inbox/outbox light up live as messages flow through `appendMessage`'s
 * dual-write to `papercup_shared.messages`.
 */
import Link from 'next/link';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@rocicorp/zero/react';
import {
  queries,
  type MessageRow,
  type MessageRecipientRow,
} from '@restart/zero-harness';
import { RichGrid, applySort, type ColumnDef, type RichGridSortState } from '@restart/grid-core';

type Department = {
  slug: string;
  name: string;
  harnessSlug?: string;
  mandate?: string;
  inboxKinds?: string[];
  outboxKinds?: string[];
  counts?: { inboxTotal: number; inboxPending: number; outboxTotal: number };
  lastActivity?: number | null;
};

const KIND_COLOR: Record<string, string> = {
  Directive: '#fbbf24',
  ProjectKickoff: '#a78bfa',
  Priority: '#7aa2f7',
  Decision: '#9ece6a',
  BudgetAllocation: '#f7768e',
  ProgressUpdate: '#7aa2f7',
};

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

const META_LABEL: CSSProperties = {
  fontSize: 10,
  color: '#7c89b1',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const META_VALUE: CSSProperties = {
  fontSize: 13,
  color: '#e7ecf3',
  fontFamily: 'ui-monospace, monospace',
};

export default function DepartmentDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? '';
  const router = useRouter();

  const [department, setDepartment] = useState<Department | null>(null);
  const [deptLoaded, setDeptLoaded] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch('/api/org/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const d = (data.departments ?? []).find((x: Department) => x.slug === slug) ?? null;
        setDepartment(d);
        setDeptLoaded(true);
      })
      .catch(() => { if (!cancelled) setDeptLoaded(true); });
    return () => { cancelled = true; };
  }, [slug]);

  // Outbox: live via Zero
  const [outbox] = useQuery(queries.messages.byFromDept({ deptSlug: slug }));

  // Inbox: recipients-for-this-dept × messages.recent → join client-side
  const [inboxRecipients] = useQuery(queries.messageRecipients.forDept({ deptSlug: slug }));
  // Pull a wider message window to maximize the chance of joining each recipient
  // back to a full message row. 1000 is the practical ceiling.
  const [recentMessages] = useQuery(queries.messages.recent({ limit: 500 }));

  const messageById = useMemo(() => {
    const m = new Map<string, MessageRow>();
    for (const r of recentMessages as MessageRow[]) m.set(r.id, r);
    return m;
  }, [recentMessages]);

  const inbox = useMemo<MessageRow[]>(() => {
    return (inboxRecipients as MessageRecipientRow[])
      .map((r) => messageById.get(r.messageId))
      .filter((m): m is MessageRow => !!m)
      .sort((a, b) => b.ts - a.ts);
  }, [inboxRecipients, messageById]);

  const [inboxSort, setInboxSort] = useState<RichGridSortState | null>(null);
  const [outboxSort, setOutboxSort] = useState<RichGridSortState | null>(null);
  const sortedInbox = useMemo(() => applySort(inbox, inboxSort), [inbox, inboxSort]);
  const sortedOutbox = useMemo(() => applySort(outbox as MessageRow[], outboxSort), [outbox, outboxSort]);

  const messageColumns = useMemo<ColumnDef<MessageRow>[]>(() => [
    {
      key: 'ts',
      header: 'When',
      width: 0.7,
      align: 'left',
      sortKey: 'ts',
      defaultSortDir: 'desc',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{relTime(row.ts)}</span>
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
            color: c, background: `color-mix(in oklab, ${c}, transparent 88%)`,
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
        <span style={{ fontSize: 12, color: '#e7ecf3', fontFamily: 'ui-monospace, monospace' }}>{row.fromDept}</span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      width: 4,
      align: 'left',
      sortKey: 'subject',
      render: ({ row }) => (
        <Link href={`/messages/${row.id}`} style={{ fontSize: 12, color: '#e7ecf3', textDecoration: 'none' }}>
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

  if (!slug) return <div style={{ padding: 24, color: '#e7ecf3' }}>Missing department slug.</div>;

  if (deptLoaded && !department) {
    return (
      <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif' }}>
        <Link href="/organization" style={{ color: '#7aa2f7', fontSize: 12 }}>← back to organization</Link>
        <p style={{ marginTop: 12 }}>Department <code>{slug}</code> not found.</p>
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
        {department ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{department.slug}</span>
              {department.harnessSlug && (
                <Link href="/harnesses" style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 4,
                  background: '#1f2738', color: '#9ece6a', textDecoration: 'none', fontFamily: 'ui-monospace, monospace',
                }}>
                  ↪ {department.harnessSlug}
                </Link>
              )}
              {department.lastActivity && (
                <span style={{ fontSize: 11, color: '#7c89b1' }}>last activity {relTime(department.lastActivity)}</span>
              )}
            </div>
            <h1 style={{ fontSize: 22, margin: 0 }}>{department.name}</h1>
            {department.mandate && (
              <p style={{ fontSize: 13, color: '#8a96ad', marginTop: 6, lineHeight: 1.5 }}>
                {department.mandate}
              </p>
            )}
          </>
        ) : (
          <p style={{ fontSize: 12, color: '#7c89b1' }}>Loading…</p>
        )}
      </header>

      {department && (
        <section style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12,
          padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
          background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
        }}>
          <div>
            <div style={META_LABEL}>Inbox total</div>
            <div style={{ ...META_VALUE, fontSize: 22 }}>{inbox.length}</div>
          </div>
          <div>
            <div style={META_LABEL}>Outbox total</div>
            <div style={{ ...META_VALUE, fontSize: 22 }}>{(outbox as MessageRow[]).length}</div>
          </div>
          {department.counts?.inboxPending != null && (
            <div>
              <div style={META_LABEL}>Inbox pending</div>
              <div style={{
                ...META_VALUE, fontSize: 22,
                color: department.counts.inboxPending > 0 ? '#fbbf24' : '#9ece6a',
              }}>
                {department.counts.inboxPending}
              </div>
            </div>
          )}
        </section>
      )}

      {department && (department.inboxKinds || department.outboxKinds) && (
        <section style={{
          padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
          background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
        }}>
          {department.inboxKinds && department.inboxKinds.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={META_LABEL}>Inbox kinds</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {department.inboxKinds.map((k) => (
                  <span key={k} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 3,
                    background: 'rgba(122,162,247,0.12)', color: '#7aa2f7', fontFamily: 'ui-monospace, monospace',
                  }}>{k}</span>
                ))}
              </div>
            </div>
          )}
          {department.outboxKinds && department.outboxKinds.length > 0 && (
            <div>
              <div style={META_LABEL}>Outbox kinds</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {department.outboxKinds.map((k) => (
                  <span key={k} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 3,
                    background: 'rgba(158,206,106,0.12)', color: '#9ece6a', fontFamily: 'ui-monospace, monospace',
                  }}>{k}</span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Inbox ({inbox.length})
        </h2>
        <div style={{ minHeight: 160, maxHeight: 400, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<MessageRow>
            columns={messageColumns}
            rows={sortedInbox}
            getRowId={(m) => m.id}
            sortState={inboxSort}
            onSortChange={setInboxSort}
            onRowClick={(m) => router.push(`/messages/${m.id}`)}
            empty="No inbound messages for this department."
            rowMinHeight={32}
            headerHeight={28}
          />
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Outbox ({(outbox as MessageRow[]).length})
        </h2>
        <div style={{ minHeight: 160, maxHeight: 400, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<MessageRow>
            columns={messageColumns}
            rows={sortedOutbox}
            getRowId={(m) => m.id}
            sortState={outboxSort}
            onSortChange={setOutboxSort}
            onRowClick={(m) => router.push(`/messages/${m.id}`)}
            empty="No outbound messages from this department."
            rowMinHeight={32}
            headerHeight={28}
          />
        </div>
      </section>
    </div>
  );
}
