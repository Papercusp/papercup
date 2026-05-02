'use client';

import { useEffect, useRef, useState } from 'react';
import { MarkdownEditor, MarkdownPreview } from '../_components/MarkdownEditor';

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
  spentCents?: number;
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
    <div className="experts-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', color: 'var(--fg)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, var(--bg-2), rgba(255,255,255,0.02))',
      }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--fg)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>Experts</div>
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

      <div style={{ display: 'flex', flex: 1, minHeight: 0, background: 'rgba(4, 10, 20, 0.32)' }}>
        <div style={{ width: 280, borderRight: '1px solid var(--border)', overflow: 'auto', background: 'rgba(6, 13, 24, 0.46)' }}>
          {error && <div style={{ padding: 12, color: 'var(--bad)' }}>{error}</div>}
          {!experts && !error && <div style={{ padding: 12, color: 'var(--fg-mute)' }}>loading…</div>}
          {experts && experts.length === 0 && (
            <div style={{ padding: 12, color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
              No experts yet. The scoper spawns them automatically when{' '}
              <code>scoper.useExperts: true</code> is set in <code>.harness/config.json</code>,
              or you can spawn one manually with the button above.
            </div>
          )}
          {experts && experts.map((e) => (
            <ExpertRow key={e.id} expert={e} selected={selectedId === e.id} onSelect={() => setSelectedId(e.id)} />
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'hidden', minWidth: 0, display: 'flex', background: 'linear-gradient(180deg, rgba(11, 18, 32, 0.78), rgba(4, 10, 20, 0.58))' }}>
          {selectedId ? (
            <ExpertDetailView
              key={selectedId}
              harnessSlug={harnessSlug}
              expertId={selectedId}
              onChange={() => setRefreshKey((k) => k + 1)}
            />
          ) : (
            <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Select an expert.</div>
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
        border: 'none', background: selected ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        borderBottom: '1px solid var(--border)', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--fg-mute)' }}>{expert.id}</span>
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: color, color: '#fff' }}>{expert.status}</span>
        {expert.userEngaged && <span title="user is engaged" style={{ fontSize: 11 }}>👤</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--fg)' }}>{expert.title}</div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 2 }}>
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

  if (error) return <div style={{ padding: 24, color: 'var(--bad)' }}>{error}</div>;
  if (!detail) return <div style={{ padding: 24, color: 'var(--fg-mute)' }}>loading…</div>;

  const statusColor = STATUS_COLOR[detail.status] ?? '#6b7280';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(6, 13, 24, 0.42)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--fg-mute)' }}>{detail.id}</span>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: statusColor, color: '#fff' }}>{detail.status}</span>
          {detail.terminationReason && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>· {detail.terminationReason}</span>}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)' }}>{detail.title}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 2 }}>
          {detail.featureSize} · {detail.agentCount} agent{detail.agentCount !== 1 ? 's' : ''} · {detail.roundCount} round{detail.roundCount !== 1 ? 's' : ''}
          {' · '}
          <span title="Spent vs budget envelope. Server stops the loop when spent reaches budget.">
            {(((detail.spentCents ?? 0) / 100)).toFixed(2)} / {(detail.budgetCents / 100).toFixed(2)} USD
          </span>
          {detail.forkedFrom && <span> · forked from <code>{detail.forkedFrom}</code></span>}
          {detail.personasUsed.length > 0 && <span> · personas: {detail.personasUsed.join(', ')}</span>}
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          {!['cancelled', 'superseded', 'final', 'max_rounds'].includes(detail.status) && (
            <button onClick={onCancel} style={btnSecondary}>cancel</button>
          )}
          <button onClick={onFork} style={btnSecondary}>fork</button>
        </div>
        {detail.highLevelSpec && detail.highLevelSpec.trim().length > 0 ? (
          <details style={{ marginTop: 10 }}>
            <summary style={{
              fontSize: 11, color: 'var(--fg-dim)', cursor: 'pointer',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              High-level brief (from scoper)
            </summary>
            <div style={{
              marginTop: 6, padding: '8px 10px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 12,
              color: 'var(--fg-dim)',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 240,
              overflowY: 'auto',
            }}>
              {detail.highLevelSpec}
            </div>
          </details>
        ) : null}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
        {(['spec', 'feedback', 'chat', 'identity'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 14px', border: 'none', background: tab === t ? 'rgba(56, 189, 248, 0.10)' : 'transparent',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              fontSize: 12, fontWeight: 650, cursor: 'pointer',
              color: tab === t ? 'var(--accent-cool)' : 'var(--fg-dim)',
            }}
          >
            {t === 'spec' ? 'SPEC.md' : t === 'feedback' ? `feedback (${feedback?.length ?? 0})` : t === 'chat' ? 'chat' : 'identity'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tab === 'spec' && <SpecView spec={detail.spec} harnessSlug={harnessSlug} expertId={expertId} />}
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

interface RelatedDocMatch {
  title: string;
  slug: string;
  score: number;
  body: string;
  mtimeMs: number;
}

function RelatedDocFiller({ harnessSlug, expertId }: { harnessSlug: string; expertId: string }) {
  const [match, setMatch] = useState<RelatedDocMatch | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setMatch(null); setLoading(true);
    fetch(`/api/harness/${harnessSlug}/experts/${expertId}/related-docs`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled) { setMatch(d?.match ?? null); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [harnessSlug, expertId]);

  if (loading) return null;
  if (!match) return null;

  return (
    <div style={{ padding: '20px 24px 24px', maxWidth: 880, margin: '0 auto', color: 'var(--fg)' }}>
      <div style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--fg-dim)', marginBottom: 8,
      }}>
        Background reading · matched to this expert's title
      </div>
      <div style={{
        padding: '14px 18px',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent-cool)',
        borderRadius: 6,
        background: 'rgba(56, 189, 248, 0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{match.title}</span>
          <a
            href={`/docs/${match.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: 'var(--fg-dim)', textDecoration: 'underline' }}
          >open in docs ↗</a>
          <span style={{ fontSize: 10, color: 'var(--fg-mute)', marginLeft: 'auto' }}>
            relevance score: {match.score}
          </span>
        </div>
        <div className="experts-spec-md" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
          <MarkdownPreview value={match.body} outline="left" />
        </div>
      </div>
    </div>
  );
}

function SpecView({ spec, harnessSlug, expertId }: { spec: string; harnessSlug: string; expertId: string }) {
  if (!spec || !spec.trim()) {
    return (
      <div style={{ height: '100%', overflow: 'auto' }}>
        <div style={{ padding: '20px 24px 0', color: 'var(--fg-mute)', fontSize: 13, maxWidth: 880, margin: '0 auto' }}>
          SPEC.md is empty — the expert hasn't drafted anything yet.
        </div>
        <RelatedDocFiller harnessSlug={harnessSlug} expertId={expertId} />
      </div>
    );
  }
  return (
    <div style={{ padding: '16px 24px', maxWidth: 880, margin: '0 auto', color: 'var(--fg)' }}>
      <div className="experts-spec-md" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--fg)' }}>
        <MarkdownPreview value={spec} outline="left" />
      </div>
      <style jsx>{`
        :global(.experts-spec-md) h1 { font-size: 22px; margin: 16px 0 8px; font-weight: 760; color: var(--fg); }
        :global(.experts-spec-md) h2 { font-size: 18px; margin: 14px 0 6px; font-weight: 720; color: var(--fg); }
        :global(.experts-spec-md) h3 { font-size: 15px; margin: 12px 0 4px; font-weight: 680; color: var(--fg); }
        :global(.experts-spec-md) p { margin: 8px 0; }
        :global(.experts-spec-md) ul, :global(.experts-spec-md) ol { padding-left: 22px; margin: 6px 0; }
        :global(.experts-spec-md) li { margin: 2px 0; }
        :global(.experts-spec-md) code { background: rgba(125, 211, 252, 0.11); color: var(--accent-cool); padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, monospace; }
        :global(.experts-spec-md) pre { background: rgba(4, 10, 20, 0.58); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
        :global(.experts-spec-md) pre code { background: transparent; padding: 0; }
        :global(.experts-spec-md) a { color: var(--accent-strong); text-decoration: underline; }
        :global(.experts-spec-md) blockquote { border-left: 3px solid rgba(125, 211, 252, 0.35); padding-left: 10px; color: var(--fg-dim); margin: 8px 0; }
        :global(.experts-spec-md) table { border-collapse: collapse; margin: 8px 0; }
        :global(.experts-spec-md) th, :global(.experts-spec-md) td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
        :global(.experts-spec-md) th { background: rgba(125, 211, 252, 0.08); font-weight: 650; }
      `}</style>
    </div>
  );
}

function FeedbackList({ feedback }: { feedback: FeedbackEntry[] | null }) {
  if (!feedback) return <div style={{ padding: 16, color: 'var(--fg-mute)' }}>loading…</div>;
  if (feedback.length === 0) return <div style={{ padding: 16, color: 'var(--fg-mute)' }}>No feedback agents have been spawned yet.</div>;
  return (
    <div>
      {feedback.map((fb) => (
        <div key={fb.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--fg-mute)' }}>{fb.id}</span>
            <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--fg)' }}>{fb.persona}</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: fb.ended ? 'var(--good)' : 'var(--warn)', color: '#051827' }}>
              {fb.ended ? 'ended' : 'in progress'}
            </span>
          </div>
          {fb.verdict && (
            <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
              {fb.verdict.newIssues && fb.verdict.newIssues.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {fb.verdict.newIssues.map((iss, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      <span style={{ fontWeight: 500 }}>[{iss.severity}]</span> {iss.summary}
                      {iss.specLines && <span style={{ color: 'var(--fg-mute)' }}> ({iss.specLines})</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <span style={{ color: 'var(--good)' }}>no new issues — convergence signal</span>
              )}
              {fb.verdict.coversPriorIssues && fb.verdict.coversPriorIssues.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 4 }}>
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
      position: 'fixed', inset: 0, background: 'rgba(2, 6, 12, 0.64)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(6px)',
    }}>
      <div style={{
        background: 'linear-gradient(180deg, rgba(11,18,32,0.98), rgba(4,10,20,0.98))', borderRadius: 14, width: 520, maxWidth: '90vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', boxShadow: '0 24px 70px rgba(0,0,0,0.42)', color: 'var(--fg)',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, background: 'rgba(255,255,255,0.035)' }}>Spawn expert</div>
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
            <div style={{ minHeight: 220, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
              <MarkdownEditor
                value={highLevelSpec}
                onChange={setHighLevelSpec}
                mode="ir"
                outline="left"
                minHeight={220}
                placeholder="Slice of SPEC.md this expert owns. The expert will turn this into a detailed spec."
              />
            </div>
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

  if (error) return <div style={{ padding: 16, color: 'var(--bad)' }}>{error}</div>;
  if (chat === null) return <div style={{ padding: 16, color: 'var(--fg-mute)' }}>loading…</div>;
  if (chat === 'none') {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: 12 }}>
          No chat open with this expert yet. Opening a chat pauses the expert's autonomous loop
          (status → <code>awaiting_user</code>) until you close it.
        </div>
        <button onClick={startChat} style={btnPrimary}>Open chat</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--warn-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--warn-bg)' }}>
        <div style={{ fontSize: 11, color: 'var(--warn)' }}>
          ⏸ Autonomous loop paused while this chat is open.
        </div>
        <button onClick={archiveChat} style={btnSecondary}>close chat</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
        {chat.transcript.length === 0 && (
          <div style={{ color: 'var(--fg-mute)', fontSize: 13, padding: 16, textAlign: 'center' }}>
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
          <div style={{ padding: '6px 12px', color: 'var(--fg-mute)', fontSize: 12 }}>thinking…</div>
        )}
        <div ref={transcriptEndRef} />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 8, display: 'flex', gap: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
          }}
          placeholder="Type a message…  (⌘↵ to send)"
          rows={2}
          disabled={streaming}
          style={{ flex: 1, fontSize: 13, padding: 8, border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'inherit', resize: 'vertical', background: 'rgba(4,10,20,0.58)', color: 'var(--fg)' }}
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
          background: isUser ? 'linear-gradient(135deg, var(--accent), var(--accent-strong))' : 'rgba(125, 211, 252, 0.10)',
          color: isUser ? 'var(--accent-ink)' : 'var(--fg)',
          padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
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
  padding: '4px 10px', fontSize: 11, border: '1px solid var(--border)',
  background: 'rgba(255,255,255,0.045)', borderRadius: 8, cursor: 'pointer', color: 'var(--fg-dim)',
};
const btnPrimary: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, border: '1px solid rgba(125,211,252,0.48)',
  background: 'linear-gradient(135deg, var(--accent-strong), var(--accent))', borderRadius: 8, cursor: 'pointer', color: 'var(--accent-ink)', fontWeight: 700,
};
const inputStyle: React.CSSProperties = {
  display: 'block', marginTop: 4, padding: '7px 9px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 8, width: '100%', fontFamily: 'inherit',
  background: 'rgba(4,10,20,0.58)', color: 'var(--fg)',
};
