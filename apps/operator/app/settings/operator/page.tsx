'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MarkdownEditor } from '../../_components/MarkdownEditor';

interface OperatorConfig {
  prompt_user: string;
  preferences: string;
  substrate_prompt: string;
  prompt_user_path: string;
  prefs_path: string;
}

interface PreferenceEntry {
  key: string;
  date: string;
  body: string;
  tags: string[];
  addedAt: string;
}

type FilterMode = 'all' | 'user-typed' | 'operator-proposed';

const DAY_MS = 24 * 60 * 60 * 1000;

export default function OperatorSettingsPage() {
  const [cfg, setCfg] = useState<OperatorConfig | null>(null);
  const [promptUser, setPromptUser] = useState('');
  const [preferences, setPreferences] = useState('');
  const [entries, setEntries] = useState<PreferenceEntry[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [budget, setBudget] = useState<{ dailyCapUsd: number; todaySpendUsd: number; configured: boolean } | null>(null);
  const [candidates, setCandidates] = useState<{ capability: string; targetHarness: string; count: number; lastSeenAt: string }[]>([]);

  const loadAll = useCallback(async () => {
    const [cfgR, prefsR, budgetR, candR] = await Promise.all([
      fetch('/api/agent-mcp/operator-config').then((r) => r.json()),
      fetch('/api/agent-mcp/operator-preferences').then((r) => r.json()),
      fetch('/api/agent-mcp/operator-budget').then((r) => r.json()),
      fetch('/api/agent-mcp/operator-standing-approvals').then((r) => r.json()).catch(() => ({ candidates: [] })),
    ]);
    setCfg(cfgR);
    setPromptUser(cfgR.prompt_user);
    setPreferences(cfgR.preferences);
    setEntries(prefsR.entries ?? []);
    setBudget(budgetR);
    setCandidates(candR.candidates ?? []);
  }, []);

  const decideCandidate = useCallback(async (capability: string, targetHarness: string, decision: 'approve' | 'dismiss') => {
    await fetch('/api/agent-mcp/operator-standing-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, targetHarness, decision }),
    });
    await loadAll();
  }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    loadAll()
      .catch((e) => {
        if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt_user: promptUser, preferences }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadAll();
      toast.success('Saved');
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = useCallback(async (key: string) => {
    if (!confirm('Remove this preference entry?')) return;
    await fetch(`/api/agent-mcp/operator-preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    await loadAll();
    toast.success('Removed');
  }, [loadAll]);

  const setBudgetCap = useCallback(async (cap: number) => {
    await fetch('/api/agent-mcp/operator-budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyCapUsd: cap }),
    });
    await loadAll();
  }, [loadAll]);

  const filteredEntries = useMemo(() => {
    if (filter === 'all') return entries;
    if (filter === 'user-typed') return entries.filter((e) => e.tags.includes('USER-TYPED'));
    return entries.filter((e) => e.tags.some((t) => t.startsWith('OPERATOR-PROPOSED')));
  }, [entries, filter]);

  const recentEntries = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    return entries.filter((e) => new Date(e.addedAt).getTime() > cutoff);
  }, [entries]);

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: '8px 4px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Operator</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
        The Operator is the proactive concierge accessed from the top-bar Operator button.
        Files live at <code>{cfg?.prompt_user_path}</code> and <code>{cfg?.prefs_path}</code>.
      </p>

      {candidates.length > 0 && (
        <section style={{ background: 'rgba(255,200,0,0.08)', border: '1px solid rgba(255,170,0,0.4)', borderRadius: 6, padding: 12, marginBottom: 24 }}>
          <strong style={{ fontSize: 13 }}>Standing-approval candidates</strong>
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '4px 0 8px' }}>
            Operator dispatched these (capability, target) pairs ≥3 times in the last 24h. Approve to skip the ask-first prompt for future identical dispatches.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {candidates.map((c) => (
              <li key={`${c.capability}::${c.targetHarness}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                <span><code>{c.capability}</code> → <code>{c.targetHarness}</code> · {c.count}× in 24h</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => decideCandidate(c.capability, c.targetHarness, 'approve')}>Approve</button>
                  <button type="button" onClick={() => decideCandidate(c.capability, c.targetHarness, 'dismiss')}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentEntries.length > 0 && (
        <section style={{ background: 'rgba(33,150,243,0.06)', border: '1px solid rgba(33,150,243,0.3)', borderRadius: 6, padding: 12, marginBottom: 24 }}>
          <strong style={{ fontSize: 13 }}>Operator recently learned (last 24h)</strong>
          <ul style={{ marginTop: 8, fontSize: 13, paddingLeft: 18 }}>
            {recentEntries.map((e) => (
              <li key={e.key} style={{ marginBottom: 4 }}>
                <code style={{ fontSize: 11 }}>{e.tags.join(' ')}</code>{' '}
                <span style={{ opacity: 0.8 }}>{e.body.replace(/^- /, '').slice(0, 160)}{e.body.length > 160 ? '…' : ''}</span>{' '}
                <button type="button" onClick={() => removeEntry(e.key)} style={{ fontSize: 11 }}>undo</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Daily budget</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', marginBottom: 8 }}>
          Today: <strong>${budget?.todaySpendUsd?.toFixed(2) ?? '0.00'}</strong> of{' '}
          <strong>${budget?.dailyCapUsd?.toFixed(2) ?? '0.00'}</strong>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          {[5, 20, 50].map((cap) => (
            <button key={cap} type="button" onClick={() => setBudgetCap(cap)}>${cap}/day</button>
          ))}
        </div>
      </section>

      <form onSubmit={onSave}>
        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
          Your prompt (voice + free-form preferences)
        </label>
        <div style={{ minHeight: 200, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <MarkdownEditor value={promptUser} onChange={setPromptUser} mode="ir" outline="left" minHeight={200} />
        </div>

        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
          Preferences notebook (free-form markdown)
        </label>
        <div style={{ minHeight: 240, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <MarkdownEditor value={preferences} onChange={setPreferences} mode="ir" outline="left" minHeight={240} />
        </div>

        <button
          type="submit"
          disabled={saving}
          style={{
            padding: '8px 16px',
            background: 'var(--cta-bg, #1f2937)',
            color: 'var(--cta-fg, #ffffff)',
            border: 'none',
            borderRadius: 6,
            cursor: saving ? 'wait' : 'pointer',
            fontWeight: 600,
            marginBottom: 24,
          }}
        >
          {saving ? 'Saving…' : 'Save prompt + preferences'}
        </button>
      </form>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Per-entry view</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {(['all', 'user-typed', 'operator-proposed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                background: filter === f ? '#1f2937' : 'transparent',
                color: filter === f ? '#fff' : 'inherit',
                border: '1px solid var(--border)',
                borderRadius: 4,
              }}
            >
              {f}
            </button>
          ))}
        </div>
        {filteredEntries.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>(no entries match)</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {filteredEntries.map((e) => (
              <li key={e.key} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
                  <span>{e.date} · {e.tags.join(' ')}</span>
                  <button type="button" onClick={() => removeEntry(e.key)} style={{ fontSize: 11 }}>remove</button>
                </div>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{e.body}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Substrate prompt (read-only)</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', marginBottom: 8 }}>
          Tier rules, schema, and anti-patterns. Ships with the substrate; cannot be edited here.
        </p>
        <pre style={{ background: 'rgba(0,0,0,0.04)', padding: 12, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>
          {cfg?.substrate_prompt}
        </pre>
      </section>
    </div>
  );
}
