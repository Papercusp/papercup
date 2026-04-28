'use client';

/**
 * Message detail — Zero-driven, target of TimelineView row clicks.
 *
 * Uses three named queries that previously had no consumer:
 *   - queries.messages.byId({ id })
 *   - queries.messageRecipients.forMessage({ messageId })
 *   - queries.messageComments.forMessage({ messageId })
 *
 * Every row + comment is live: a new comment inserted server-side appears
 * within ~3s without reload. Recipients update the same way.
 */
import Link from 'next/link';
import { useMemo, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@rocicorp/zero/react';
import {
  queries,
  type MessageRow,
  type MessageRecipientRow,
  type MessageCommentRow,
} from '@restart/zero-harness';

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

export default function MessageDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();

  const [message, msgInfo] = useQuery(queries.messages.byId({ id }));
  const [recipients] = useQuery(queries.messageRecipients.forMessage({ messageId: id }));
  const [comments, commentsInfo] = useQuery(queries.messageComments.forMessage({ messageId: id }));
  const [commentDraft, setCommentDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const m = message as MessageRow | undefined;
  const tone = useMemo(() => (m ? KIND_COLOR[m.kind] ?? '#7aa2f7' : '#7aa2f7'), [m]);

  if (!id) {
    return <div style={{ padding: 24, color: '#e7ecf3' }}>Missing message id.</div>;
  }

  if (msgInfo?.type === 'complete' && !m) {
    return (
      <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif' }}>
        <Link href="/timeline" style={{ color: '#7aa2f7', fontSize: 12 }}>← back to timeline</Link>
        <p style={{ marginTop: 12 }}>Message <code>{id}</code> not found.</p>
      </div>
    );
  }

  async function postComment() {
    if (!commentDraft.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/org/messages/${id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: commentDraft, author: 'user' }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'comment failed');
      setCommentDraft('');
    } catch (e) {
      setSubmitError(`${e}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: 24, color: '#e7ecf3', fontFamily: 'system-ui, sans-serif', maxWidth: 920, margin: '0 auto' }}>
      <header style={{ marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#7aa2f7',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
            marginBottom: 8,
          }}
        >
          ← back
        </button>
        {m ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 4,
                color: tone,
                background: `color-mix(in oklab, ${tone}, transparent 86%)`,
                border: `1px solid ${tone}55`,
              }}>{m.kind}</span>
              <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{m.status}</span>
              <span style={{ fontSize: 11, color: '#7c89b1' }}>{relTime(m.ts)}</span>
              <span style={{ fontSize: 11, color: '#7c89b1', fontFamily: 'ui-monospace, monospace' }}>{m.id}</span>
            </div>
            <h1 style={{ fontSize: 22, margin: 0 }}>{m.subject}</h1>
          </>
        ) : (
          <p style={{ fontSize: 12, color: '#7c89b1' }}>Loading…</p>
        )}
      </header>

      {m && (
        <>
          <section style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12,
            padding: 14, border: '1px solid #1f2738', borderRadius: 6, marginBottom: 16,
            background: 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
          }}>
            <div>
              <div style={META_LABEL}>From</div>
              <div style={META_VALUE}>{m.fromDept}</div>
            </div>
            <div>
              <div style={META_LABEL}>To ({(recipients as MessageRecipientRow[]).length})</div>
              <div style={META_VALUE}>
                {(recipients as MessageRecipientRow[]).length > 0
                  ? (recipients as MessageRecipientRow[]).map((r) => r.deptSlug).join(', ')
                  : '—'}
              </div>
            </div>
            {m.projectId && (
              <div>
                <div style={META_LABEL}>Project</div>
                <Link href={`/projects/${m.projectId}`} style={{ ...META_VALUE, color: '#9ece6a', textDecoration: 'none' }}>
                  {m.projectId.slice(0, 8)}
                </Link>
              </div>
            )}
            {m.directiveId && (
              <div>
                <div style={META_LABEL}>Directive</div>
                <Link href={`/directives/${m.directiveId}`} style={{ ...META_VALUE, color: '#7aa2f7', textDecoration: 'none' }}>
                  {m.directiveId}
                </Link>
              </div>
            )}
            {m.refId && (
              <div>
                <div style={META_LABEL}>Ref</div>
                <div style={META_VALUE}>{m.refId}</div>
              </div>
            )}
          </section>

          <section style={{ marginBottom: 24 }}>
            <div style={META_LABEL}>Body</div>
            <pre style={{
              background: '#0a0d12', border: '1px solid #1f2738', borderRadius: 6,
              padding: 14, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              margin: '6px 0 0', fontFamily: 'inherit',
            }}>
              {m.body}
            </pre>
          </section>
        </>
      )}

      <section>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Comments ({(comments as MessageCommentRow[]).length})
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {commentsInfo?.type === 'complete' && (comments as MessageCommentRow[]).length === 0 && (
            <p style={{ fontSize: 12, color: '#7c89b1', fontStyle: 'italic' }}>No comments yet.</p>
          )}
          {(comments as MessageCommentRow[]).map((c) => (
            <article key={c.id} style={{
              padding: 10, border: '1px solid #1f2738', borderLeft: `3px solid ${c.author === 'user' ? '#9ece6a' : '#7aa2f7'}`,
              borderRadius: 4, background: '#0a0d12',
            }}>
              <div style={{ fontSize: 11, color: '#7c89b1', marginBottom: 4 }}>
                <b style={{ color: c.author === 'user' ? '#9ece6a' : '#7aa2f7', textTransform: 'uppercase' }}>{c.author}</b>
                {' · '}{relTime(c.ts)}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {c.body}
              </div>
            </article>
          ))}
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Add a comment…"
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
              onClick={postComment}
              disabled={submitting || !commentDraft.trim()}
              style={{
                padding: '6px 14px', background: '#7aa2f7', color: '#0a0d12',
                border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600,
                cursor: submitting || !commentDraft.trim() ? 'not-allowed' : 'pointer',
                opacity: submitting || !commentDraft.trim() ? 0.5 : 1,
              }}
            >
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
            {submitError && <span style={{ fontSize: 11, color: '#f87171' }}>{submitError}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
