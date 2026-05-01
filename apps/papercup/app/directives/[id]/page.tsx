'use client';

/**
 * Directive detail — Zero-driven where possible.
 *
 * Directive metadata still comes from `/api/org/directives/:id` (no PG
 * table for directives yet, only `directive_summaries` and per-directive
 * messages). The summary log + linked-messages timeline ARE Zero-driven,
 * so summaries posted by the CEO and new routing messages light up live.
 *
 * Activates two previously-unused named queries:
 *   - queries.messages.byDirective({ id })
 *   - queries.directiveSummaries.forDirective({ directiveId })
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSyncQuery } from '@restart/sync';
import {
  type MessageRow,
  type DirectiveSummaryRow,
} from '@restart/zero-harness';
import { RichGrid, applySort, type ColumnDef, type RichGridSortState } from '@restart/grid-core';

type Directive = {
  id: string;
  title: string;
  body: string;
  status: 'active' | 'paused' | 'complete' | 'cancelled';
  created_by: string;
  created_ts: number;
  deadline_ts?: number;
  budget_cents?: number;
  priority?: 'low' | 'normal' | 'high';
  assignedDepartments?: string[];
  linkedProjectIds?: string[];
  constraints?: Record<string, string>;
};

const STATUS_TONE: Record<string, string> = {
  active: '#34d399',
  paused: '#fbbf24',
  complete: '#7aa2f7',
  cancelled: '#f87171',
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

function fmtMoney(cents: number | undefined | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
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

export default function DirectiveDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();

  // Directive metadata: JSON-backed (no PG table yet)
  const [directive, setDirective] = useState<Directive | null>(null);
  const [dirLoaded, setDirLoaded] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/org/directives/${id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setDirError(data.error);
        } else {
          setDirective(data.directive ?? null);
        }
        setDirLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setDirError(`${e}`);
        setDirLoaded(true);
      });
    return () => { cancelled = true; };
  }, [id]);

  // Summaries + messages — REST polling via @restart/sync.
  const { data: summaries } = useSyncQuery<DirectiveSummaryRow>({
    queryName: 'directiveSummaries.forDirective',
    args: { directiveId: id },
  });
  const { data: messages } = useSyncQuery<MessageRow>({
    queryName: 'messages.byDirective',
    args: { directiveId: id },
  });

  const tone = useMemo(
    () => (directive ? STATUS_TONE[directive.status] ?? '#8a96ad' : '#8a96ad'),
    [directive],
  );

  const [draftSummary, setDraftSummary] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const postSummary = useCallback(async () => {
    if (!draftSummary.trim() || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/org/directives/${id}/summaries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draftSummary, author: 'user' }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'post failed');
      setDraftSummary('');
    } catch (e) {
      setPostError(`${e}`);
    } finally {
      setPosting(false);
    }
  }, [draftSummary, posting, id]);

  const [summarySort, setSummarySort] = useState<RichGridSortState | null>(null);
  const [messageSort, setMessageSort] = useState<RichGridSortState | null>(null);
  const sortedSummaries = useMemo(() => applySort(summaries as DirectiveSummaryRow[], summarySort), [summaries, summarySort]);
  const sortedMessages = useMemo(() => applySort(messages as MessageRow[], messageSort), [messages, messageSort]);

  const summaryColumns = useMemo<ColumnDef<DirectiveSummaryRow>[]>(() => [
    {
      key: 'when',
      header: 'When',
      width: 1.0,
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
      key: 'author',
      header: 'Author',
      width: 0.8,
      align: 'left',
      sortKey: 'author',
      render: ({ row }) => {
        const c = row.author === 'ceo' ? '#7aa2f7' : '#34d399';
        return (
          <span style={{
            fontSize: 11, padding: '2px 6px', borderRadius: 3,
            color: c, background: `color-mix(in oklab, ${c}, transparent 88%)`,
            textTransform: 'uppercase', letterSpacing: 0.4, fontFamily: 'ui-monospace, monospace',
          }}>
            {row.author}
          </span>
        );
      },
    },
    {
      key: 'body',
      header: 'Summary',
      width: 5,
      align: 'left',
      render: ({ row }) => (
        <span style={{ fontSize: 12, color: '#e7ecf3' }}>
          {row.body.length > 200 ? row.body.slice(0, 200) + '…' : row.body}
        </span>
      ),
    },
  ], []);

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
  ], []);

  if (!id) return <div style={{ padding: 24, color: '#e7ecf3' }}>Missing directive id.</div>;

  if (dirLoaded && (dirError || !directive)) {
    return (
      <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif' }}>
        <Link href="/directives" style={{ color: '#7aa2f7', fontSize: 12 }}>← back to directives</Link>
        <p style={{ marginTop: 12 }}>Directive <code>{id}</code> not found{dirError ? `: ${dirError}` : '.'}</p>
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
        {directive ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 4,
                color: tone,
                background: `color-mix(in oklab, ${tone}, transparent 86%)`,
                border: `1px solid ${tone}55`,
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>{directive.status}</span>
              {directive.priority === 'high' && (
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 10,
                  background: '#3a2030', color: '#f7768e', border: '1px solid #f7768e55',
                  letterSpacing: 0.5,
                }}>HIGH</span>
              )}
              <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{directive.id}</span>
              <span style={{ fontSize: 11, color: '#7c89b1' }}>created {relTime(directive.created_ts)}</span>
            </div>
            <h1 style={{ fontSize: 22, margin: 0 }}>{directive.title}</h1>
          </>
        ) : (
          <p style={{ fontSize: 12, color: '#7c89b1' }}>Loading directive metadata…</p>
        )}
      </header>

      {directive && (
        <>
          <section style={{ marginBottom: 16 }}>
            <div style={META_LABEL}>Body</div>
            <pre style={{
              background: '#0a0d12', border: '1px solid #1f2738', borderRadius: 6,
              padding: 12, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              margin: '6px 0 0', fontFamily: 'inherit',
            }}>{directive.body}</pre>
          </section>

          <section style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12,
            padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
            background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
          }}>
            <div>
              <div style={META_LABEL}>Created by</div>
              <div style={META_VALUE}>{directive.created_by}</div>
            </div>
            {directive.budget_cents != null && (
              <div>
                <div style={META_LABEL}>Budget</div>
                <div style={META_VALUE}>{fmtMoney(directive.budget_cents)}</div>
              </div>
            )}
            {directive.deadline_ts && (
              <div>
                <div style={META_LABEL}>Deadline</div>
                <div style={META_VALUE}>{new Date(directive.deadline_ts).toISOString().slice(0, 10)}</div>
              </div>
            )}
            <div>
              <div style={META_LABEL}>Assigned ({directive.assignedDepartments?.length ?? 0})</div>
              <div style={META_VALUE}>
                {directive.assignedDepartments?.length
                  ? directive.assignedDepartments.join(', ')
                  : <span style={{ color: '#fbbf24' }}>unrouted</span>}
              </div>
            </div>
            <div>
              <div style={META_LABEL}>Linked projects ({directive.linkedProjectIds?.length ?? 0})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {directive.linkedProjectIds?.length
                  ? directive.linkedProjectIds.map((pid) => (
                      <Link
                        key={pid}
                        href={`/projects/${pid}`}
                        style={{ ...META_VALUE, color: '#9ece6a', textDecoration: 'none' }}
                      >
                        {pid.slice(0, 8)}
                      </Link>
                    ))
                  : <span style={META_VALUE}>—</span>}
              </div>
            </div>
          </section>

          {directive.constraints && Object.keys(directive.constraints).length > 0 && (
            <section style={{
              padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
              background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
            }}>
              <div style={{ ...META_LABEL, marginBottom: 8 }}>Constraints</div>
              {Object.entries(directive.constraints).map(([k, v]) => (
                <div key={k} style={{ marginBottom: 6, fontSize: 12 }}>
                  <span style={{ color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{k}: </span>
                  <span style={{ color: '#e7ecf3' }}>{v}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Summary log ({(summaries as DirectiveSummaryRow[]).length})
        </h2>
        <div style={{ minHeight: 120, maxHeight: 360, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<DirectiveSummaryRow>
            columns={summaryColumns}
            rows={sortedSummaries}
            getRowId={(s) => s.id}
            sortState={summarySort}
            onSortChange={setSummarySort}
            empty="No summaries yet."
            rowMinHeight={32}
            headerHeight={28}
          />
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            placeholder="Add a summary entry…"
            rows={3}
            style={{
              padding: 10, border: '1px solid #1f2738', borderRadius: 6,
              background: '#0a0d12', color: '#e7ecf3', fontSize: 13, fontFamily: 'inherit',
              resize: 'vertical', minHeight: 70,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              onClick={postSummary}
              disabled={posting || !draftSummary.trim()}
              style={{
                padding: '6px 14px', background: '#7aa2f7', color: '#0a0d12',
                border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600,
                cursor: posting || !draftSummary.trim() ? 'not-allowed' : 'pointer',
                opacity: posting || !draftSummary.trim() ? 0.5 : 1,
              }}
            >
              {posting ? 'Posting…' : 'Post summary'}
            </button>
            {postError && <span style={{ fontSize: 11, color: '#f87171' }}>{postError}</span>}
          </div>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Linked messages ({(messages as MessageRow[]).length})
        </h2>
        <div style={{ minHeight: 200, maxHeight: 500, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<MessageRow>
            columns={messageColumns}
            rows={sortedMessages}
            getRowId={(m) => m.id}
            sortState={messageSort}
            onSortChange={setMessageSort}
            onRowClick={(m) => router.push(`/messages/${m.id}`)}
            empty="No messages tagged with this directive yet."
            rowMinHeight={32}
            headerHeight={28}
          />
        </div>
      </section>
    </div>
  );
}
