'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ExpertSummary {
  id: string;
  title: string;
  status: string;
  featureSize: 'small' | 'standard' | 'large';
  agentCount: number;
  roundCount: number;
  userEngaged: boolean;
  forkedFrom?: string;
  createdAt: string;
  updatedAt: string;
}

interface ExpertDetail extends ExpertSummary {
  budgetCents: number;
  highLevelSpec: string;
  spec: string;
  specPath: string;
  personasUsed: string[];
  terminationReason?: string;
}

interface FeedbackEntry {
  id: string;
  persona: string;
  ended: boolean;
  verdict: { newIssues?: Array<{ summary: string; severity: string; specLines?: string }>; coversPriorIssues?: string[] } | null;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  transcript: ChatTurn[];
  archived_at: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  drafting: '#6b7280',
  gathering_feedback: '#2563eb',
  awaiting_user: '#d97706',
  final: '#16a34a',
  max_rounds: '#a16207',
  cancelled: '#9ca3af',
  superseded: '#9ca3af',
  error: '#dc2626',
};

export default function ExpertsPanel({ harnessSlug, onClose }: { harnessSlug: string; onClose: () => void }) {
  const [experts, setExperts] = useState<ExpertSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSpawn, setShowSpawn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${harnessSlug}/experts`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setExperts(d.experts ?? []);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [harnessSlug, refreshKey]);

  useEffect(() => {
    if (!experts || selectedId) return;
    const live = experts.find((e) => !['cancelled', 'superseded'].includes(e.status));
    if (live) setSelectedId(live.id);
    else if (experts.length > 0) setSelectedId(experts[0].id);
  }, [experts, selectedId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
      }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Experts</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowSpawn(true)} style={btnPrimary}>+ spawn expert</button>
          <button onClick={() => setRefreshKey((k) => k + 1)} style={btnSecondary}>refresh</button>
          <button onClick={onClose} style={btnSecondary}>close</button>
        </div>
      </div>

      {showSpawn && (
        <SpawnModal
          harnessSlug={harnessSlug}
          onClose={() => setShowSpawn(false)}
          onSpawned={(id) => {
            setShowSpawn(false);
            setRefreshKey((k) => k + 1);
            setSelectedId(id);
          }}
        />
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 280, borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
          {error && <div style={{ padding: 12, color: '#dc2626' }}>{error}</div>}
          {!experts && !error && <div style={{ padding: 12, color: '#6b7280' }}>loading…</div>}
          {experts && experts.length === 0 && (
            <div style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>
              No experts yet. The scoper spawns them automatically when{' '}
              <code>scoper.useExperts: true</code> is set in <code>.harness/config.json</code>,
              or you can spawn one manually with the button above.
            </div>
          )}
          {experts && experts.map((e) => (
            <ExpertRow key={e.id} expert={e} selected={selectedId === e.id} onSelect={() => setSelectedId(e.id)} />
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'hidden', minWidth: 0, display: 'flex' }}>
          {selectedId ? (
            <ExpertDetailView
              key={selectedId}
              harnessSlug={harnessSlug}
              expertId={selectedId}
              onChange={() => setRefreshKey((k) => k + 1)}
            />
          ) : (
            <div style={{ padding: 24, color: '#6b7280' }}>Select an expert.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExpertRow({ expert, selected, onSelect }: { expert: ExpertSummary; selected: boolean; onSelect: () => void }) {
  const color = STATUS_COLOR[expert.status] ?? '#6b7280';
  return (
    <button
      onClick={onSelect}
      style={{
        width: '100%', textAlign: 'left', padding: '10px 12px',
        border: 'none', background: selected ? '#eff6ff' : 'transparent',
        borderLeft: selected ? '2px solid #2563eb' : '2px solid transparent',
        borderBottom: '1px solid #f3f4f6', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{expert.id}</span>
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: color, color: '#fff' }}>{expert.status}</span>
        {expert.userEngaged && <span title="user is engaged" style={{ fontSize: 11 }}>👤</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#111' }}>{expert.title}</div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
        {expert.featureSize} · {expert.agentCount} agent{expert.agentCount !== 1 ? 's' : ''} · {expert.roundCount} round{expert.roundCount !== 1 ? 's' : ''}
      </div>
    </button>
  );
}

function ExpertDetailView({ harnessSlug, expertId, onChange }: { harnessSlug: string; expertId: string; onChange: () => void }) {
  const [detail, setDetail] = useState<ExpertDetail | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'spec' | 'feedback' | 'chat' | 'identity'>('spec');

  useEffect(() => {
    let cancelled = false;
    setDetail(null); setFeedback(null); setError(null);
    Promise.all([
      fetch(`/api/harness/${harnessSlug}/experts/${expertId}`).then((r) => r.json()),
      fetch(`/api/harness/${harnessSlug}/experts/${expertId}/feedback`).then((r) => r.json()),
    ]).then(([d, f]) => {
      if (cancelled) return;
      if (d.error) setError(d.error); else setDetail(d as ExpertDetail);
      if (!f.error) setFeedback(f.feedback ?? []);
    }).catch((e) => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [harnessSlug, expertId]);

  const onCancel = async () => {
    if (!confirm(`Cancel ${expertId}?`)) return;
    await fetch(`/api/harness/${harnessSlug}/experts/${expertId}/cancel`, { method: 'POST' });
    onChange();
  };
  const onFork = async () => {
    if (!confirm(`Fork ${expertId}? SPEC.md is copied; current expert becomes superseded.`)) return;
    await fetch(`/api/harness/${harnessSlug}/experts/${expertId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    onChange();
  };

  if (error) return <div style={{ padding: 24, color: '#dc2626' }}>{error}</div>;
  if (!detail) return <div style={{ padding: 24, color: '#6b7280' }}>loading…</div>;

  const statusColor = STATUS_COLOR[detail.status] ?? '#6b7280';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{detail.id}</span>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: statusColor, color: '#fff' }}>{detail.status}</span>
          {detail.terminationReason && <span style={{ fontSize: 11, color: '#6b7280' }}>· {detail.terminationReason}</span>}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{detail.title}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {detail.featureSize} · {detail.agentCount} agent{detail.agentCount !== 1 ? 's' : ''} · {detail.roundCount} round{detail.roundCount !== 1 ? 's' : ''} · budget {(detail.budgetCents / 100).toFixed(2)} USD
          {detail.forkedFrom && <span> · forked from <code>{detail.forkedFrom}</code></span>}
          {detail.personasUsed.length > 0 && <span> · personas: {detail.personasUsed.join(', ')}</span>}
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          {!['cancelled', 'superseded', 'final', 'max_rounds'].includes(detail.status) && (
            <button onClick={onCancel} style={btnSecondary}>cancel</button>
          )}
          <button onClick={onFork} style={btnSecondary}>fork</button>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' }}>
        {(['spec', 'feedback', 'chat', 'identity'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 14px', border: 'none', background: 'transparent',
              borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
              fontSize: 12, fontWeight: 500, cursor: 'pointer',
              color: tab === t ? '#2563eb' : '#374151',
            }}
          >
            {t === 'spec' ? 'SPEC.md' : t === 'feedback' ? `feedback (${feedback?.length ?? 0})` : t === 'chat' ? 'chat' : 'identity'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tab === 'spec' && <SpecView spec={detail.spec} />}
        {tab === 'feedback' && <FeedbackList feedback={feedback} />}
        {tab === 'chat' && <ExpertChat harnessSlug={harnessSlug} expertId={expertId} />}
        {tab === 'identity' && (
          <pre style={{ padding: 16, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ ...detail, spec: undefined }, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function SpecView({ spec }: { spec: string }) {
  if (!spec || !spec.trim()) {
    return (
      <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>
        SPEC.md is empty — the expert hasn't drafted anything yet.
      </div>
    );
  }
  return (
    <div style={{ padding: '16px 24px', maxWidth: 880, margin: '0 auto' }}>
      <div className="experts-spec-md" style={{ fontSize: 14, lineHeight: 1.6, color: '#111' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{spec}</ReactMarkdown>
      </div>
      <style jsx>{`
        :global(.experts-spec-md) h1 { font-size: 22px; margin: 16px 0 8px; font-weight: 700; }
        :global(.experts-spec-md) h2 { font-size: 18px; margin: 14px 0 6px; font-weight: 600; }
        :global(.experts-spec-md) h3 { font-size: 15px; margin: 12px 0 4px; font-weight: 600; }
        :global(.experts-spec-md) p { margin: 8px 0; }
        :global(.experts-spec-md) ul, :global(.experts-spec-md) ol { padding-left: 22px; margin: 6px 0; }
        :global(.experts-spec-md) li { margin: 2px 0; }
        :global(.experts-spec-md) code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: ui-monospace, monospace; }
        :global(.experts-spec-md) pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
        :global(.experts-spec-md) pre code { background: transparent; padding: 0; }
        :global(.experts-spec-md) a { color: #2563eb; text-decoration: underline; }
        :global(.experts-spec-md) blockquote { border-left: 3px solid #d1d5db; padding-left: 10px; color: #6b7280; margin: 8px 0; }
        :global(.experts-spec-md) table { border-collapse: collapse; margin: 8px 0; }
        :global(.experts-spec-md) th, :global(.experts-spec-md) td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
        :global(.experts-spec-md) th { background: #f9fafb; font-weight: 600; }
      `}</style>
    </div>
  );
}

function FeedbackList({ feedback }: { feedback: FeedbackEntry[] | null }) {
  if (!feedback) return <div style={{ padding: 16, color: '#6b7280' }}>loading…</div>;
  if (feedback.length === 0) return <div style={{ padding: 16, color: '#6b7280' }}>No feedback agents have been spawned yet.</div>;
  return (
    <div>
      {feedback.map((fb) => (
        <div key={fb.id} style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{fb.id}</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{fb.persona}</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: fb.ended ? '#16a34a' : '#d97706', color: '#fff' }}>
              {fb.ended ? 'ended' : 'in progress'}
            </span>
          </div>
          {fb.verdict && (
            <div style={{ fontSize: 12, color: '#374151' }}>
              {fb.verdict.newIssues && fb.verdict.newIssues.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {fb.verdict.newIssues.map((iss, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      <span style={{ fontWeight: 500 }}>[{iss.severity}]</span> {iss.summary}
                      {iss.specLines && <span style={{ color: '#6b7280' }}> ({iss.specLines})</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <span style={{ color: '#16a34a' }}>no new issues — convergence signal</span>
              )}
              {fb.verdict.coversPriorIssues && fb.verdict.coversPriorIssues.length > 0 && (
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                  also independently raised: {fb.verdict.coversPriorIssues.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Spawn modal ─────────────────────────────────────────────────────────

function SpawnModal({ harnessSlug, onClose, onSpawned }: {
  harnessSlug: string; onClose: () => void; onSpawned: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [highLevelSpec, setHighLevelSpec] = useState('');
  const [budgetCents, setBudgetCents] = useState(5000);
  const [featureSize, setFeatureSize] = useState<'small' | 'standard' | 'large'>('standard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || !highLevelSpec.trim()) return;
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(`/api/harness/${harnessSlug}/experts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, highLevelSpec, budgetCents, featureSize }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setError(d.error ?? `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      onSpawned(d.id);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 8, width: 520, maxWidth: '90vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Spawn expert</div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <label style={{ fontSize: 12, fontWeight: 500 }}>
            Title
            <input
              type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Auth flow"
              style={inputStyle}
              autoFocus
            />
          </label>
          <label style={{ fontSize: 12, fontWeight: 500 }}>
            High-level spec
            <textarea
              value={highLevelSpec} onChange={(e) => setHighLevelSpec(e.target.value)}
              placeholder="Slice of SPEC.md this expert owns. The expert will turn this into a detailed spec."
              rows={6}
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
              Budget (USD)
              <input
                type="number" value={budgetCents / 100}
                onChange={(e) => setBudgetCents(Math.round(parseFloat(e.target.value || '0') * 100))}
                step="1" min="0.01"
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
              Size
              <select
                value={featureSize}
                onChange={(e) => setFeatureSize(e.target.value as 'small' | 'standard' | 'large')}
                style={inputStyle}
              >
                <option value="small">small (2 agents × 1 round)</option>
                <option value="standard">standard (4 agents × 3 rounds)</option>
                <option value="large">large (10 agents × 15 rounds)</option>
              </select>
            </label>
          </div>
          {error && <div style={{ color: '#dc2626', fontSize: 12 }}>{error}</div>}
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !title.trim() || !highLevelSpec.trim()}
            style={{ ...btnPrimary, opacity: submitting || !title.trim() || !highLevelSpec.trim() ? 0.5 : 1 }}
          >
            {submitting ? 'spawning…' : 'spawn'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Chat with the expert ────────────────────────────────────────────────

function ExpertChat({ harnessSlug, expertId }: { harnessSlug: string; expertId: string }) {
  const [chat, setChat] = useState<ChatRow | null | 'none'>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Find the most recent (non-archived) chat for this expert, or signal none.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${harnessSlug}/agent-chats`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const chats = (d.chats ?? []) as ChatRow[];
        const match = chats.find((c) => c.role === 'expert' && c.feature_id === expertId && !c.archived_at);
        setChat(match ?? 'none');
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [harnessSlug, expertId]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat, streamText]);

  const startChat = async () => {
    const r = await fetch(`/api/harness/${harnessSlug}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'expert', feature_id: expertId, title: `expert · ${expertId}` }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { setError(d.error ?? `HTTP ${r.status}`); return; }
    setChat(d as ChatRow);
  };

  const archiveChat = async () => {
    if (chat && chat !== 'none' && confirm('Close this chat? The expert will resume autonomous work.')) {
      await fetch(`/api/harness/${harnessSlug}/agent-chats/${chat.id}`, { method: 'DELETE' });
      setChat('none');
    }
  };

  const send = async () => {
    if (!chat || chat === 'none' || !draft.trim() || streaming) return;
    const message = draft.trim();
    setDraft('');
    setStreaming(true);
    setStreamText('');
    // Optimistically append user turn.
    setChat({ ...chat, transcript: [...chat.transcript, { role: 'user', content: message, ts: new Date().toISOString() }] });

    try {
      const r = await fetch(`/api/harness/${harnessSlug}/agent-chats/${chat.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
      if (!r.body) {
        setError('no stream body');
        setStreaming(false);
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let assembled = '';
      // SSE parse loop.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = ''; let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          try {
            const d = JSON.parse(data);
            if (event === 'delta' && typeof d.text === 'string') {
              assembled += d.text;
              setStreamText(assembled);
            } else if (event === 'done') {
              if (typeof d.text === 'string' && d.text.length > assembled.length) assembled = d.text;
            }
          } catch {}
        }
      }
      // Append final assistant turn.
      setChat((cur) => {
        if (!cur || cur === 'none') return cur;
        return { ...cur, transcript: [...cur.transcript, { role: 'assistant', content: assembled, ts: new Date().toISOString() }] };
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
      setStreamText('');
    }
  };

  if (error) return <div style={{ padding: 16, color: '#dc2626' }}>{error}</div>;
  if (chat === null) return <div style={{ padding: 16, color: '#6b7280' }}>loading…</div>;
  if (chat === 'none') {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontSize: 13, color: '#374151', marginBottom: 12 }}>
          No chat open with this expert yet. Opening a chat pauses the expert's autonomous loop
          (status → <code>awaiting_user</code>) until you close it.
        </div>
        <button onClick={startChat} style={btnPrimary}>Open chat</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fefce8' }}>
        <div style={{ fontSize: 11, color: '#78350f' }}>
          ⏸ Autonomous loop paused while this chat is open.
        </div>
        <button onClick={archiveChat} style={btnSecondary}>close chat</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
        {chat.transcript.length === 0 && (
          <div style={{ color: '#6b7280', fontSize: 13, padding: 16, textAlign: 'center' }}>
            Send a message to start.
          </div>
        )}
        {chat.transcript.map((turn, i) => (
          <ChatTurnView key={i} turn={turn} />
        ))}
        {streaming && streamText && (
          <ChatTurnView turn={{ role: 'assistant', content: streamText, ts: new Date().toISOString() }} streaming />
        )}
        {streaming && !streamText && (
          <div style={{ padding: '6px 12px', color: '#6b7280', fontSize: 12 }}>thinking…</div>
        )}
        <div ref={transcriptEndRef} />
      </div>
      <div style={{ borderTop: '1px solid #e5e7eb', padding: 8, display: 'flex', gap: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
          }}
          placeholder="Type a message…  (⌘↵ to send)"
          rows={2}
          disabled={streaming}
          style={{ flex: 1, fontSize: 13, padding: 8, border: '1px solid #d1d5db', borderRadius: 4, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <button onClick={send} disabled={!draft.trim() || streaming} style={{ ...btnPrimary, alignSelf: 'flex-end', opacity: !draft.trim() || streaming ? 0.5 : 1 }}>
          send
        </button>
      </div>
    </div>
  );
}

function ChatTurnView({ turn, streaming }: { turn: ChatTurn; streaming?: boolean }) {
  const isUser = turn.role === 'user';
  return (
    <div style={{ margin: '8px 0', display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '80%',
          background: isUser ? '#2563eb' : '#f3f4f6',
          color: isUser ? '#fff' : '#111',
          padding: '8px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          opacity: streaming ? 0.85 : 1,
        }}
      >
        {turn.content}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const btnSecondary: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, border: '1px solid #d1d5db',
  background: '#fff', borderRadius: 4, cursor: 'pointer', color: '#374151',
};
const btnPrimary: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, border: 'none',
  background: '#2563eb', borderRadius: 4, cursor: 'pointer', color: '#fff', fontWeight: 500,
};
const inputStyle: React.CSSProperties = {
  display: 'block', marginTop: 4, padding: '6px 8px', fontSize: 13,
  border: '1px solid #d1d5db', borderRadius: 4, width: '100%', fontFamily: 'inherit',
};
