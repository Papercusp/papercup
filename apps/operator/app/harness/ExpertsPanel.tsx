'use client';

import { useEffect, useMemo, useState } from 'react';

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

  // Default-select the first non-terminal expert.
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
          <button onClick={() => setRefreshKey((k) => k + 1)} style={btnSecondary}>refresh</button>
          <button onClick={onClose} style={btnSecondary}>close</button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 280, borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
          {error && <div style={{ padding: 12, color: '#dc2626' }}>{error}</div>}
          {!experts && !error && <div style={{ padding: 12, color: '#6b7280' }}>loading…</div>}
          {experts && experts.length === 0 && (
            <div style={{ padding: 12, color: '#6b7280' }}>
              No experts yet. The scoper spawns one per high-level feature area when{' '}
              <code>scoper.useExperts: true</code> is set in <code>.harness/config.json</code>.
            </div>
          )}
          {experts && experts.map((e) => (
            <ExpertRow key={e.id} expert={e} selected={selectedId === e.id} onSelect={() => setSelectedId(e.id)} />
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
          {selectedId ? (
            <ExpertDetailView
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
  const [tab, setTab] = useState<'spec' | 'feedback' | 'identity'>('spec');

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
    if (!confirm(`Cancel ${expertId}? It will stop being dispatched.`)) return;
    await fetch(`/api/harness/${harnessSlug}/experts/${expertId}/cancel`, { method: 'POST' });
    onChange();
  };
  const onFork = async () => {
    if (!confirm(`Fork ${expertId}? A new expert will be created with the same SPEC.md as a starting point; the current one will be marked superseded.`)) return;
    await fetch(`/api/harness/${harnessSlug}/experts/${expertId}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    onChange();
  };

  if (error) return <div style={{ padding: 24, color: '#dc2626' }}>{error}</div>;
  if (!detail) return <div style={{ padding: 24, color: '#6b7280' }}>loading…</div>;

  const statusColor = STATUS_COLOR[detail.status] ?? '#6b7280';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
        {(['spec', 'feedback', 'identity'] as const).map((t) => (
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
            {t === 'spec' ? 'SPEC.md' : t === 'feedback' ? `feedback (${feedback?.length ?? 0})` : 'identity'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tab === 'spec' && (
          <pre style={{ padding: 16, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {detail.spec || '(SPEC.md is empty — the expert hasn\'t written anything yet)'}
          </pre>
        )}
        {tab === 'feedback' && (
          <FeedbackList feedback={feedback} />
        )}
        {tab === 'identity' && (
          <pre style={{ padding: 16, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ ...detail, spec: undefined }, null, 2)}
          </pre>
        )}
      </div>
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

const btnSecondary: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, border: '1px solid #d1d5db',
  background: '#fff', borderRadius: 4, cursor: 'pointer', color: '#374151',
};
