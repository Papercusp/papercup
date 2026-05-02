'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MarkdownEditor } from '../../_components/MarkdownEditor';

interface OperatorConfig {
  prompt: string;
  preferences: string;
  prompt_path: string;
  prefs_path: string;
}

export default function OperatorSettingsPage() {
  const [cfg, setCfg] = useState<OperatorConfig | null>(null);
  const [prompt, setPrompt] = useState('');
  const [preferences, setPreferences] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent-mcp/operator-config')
      .then((r) => r.json())
      .then((d: OperatorConfig) => {
        if (cancelled) return;
        setCfg(d);
        setPrompt(d.prompt);
        setPreferences(d.preferences);
      })
      .catch((e) => {
        if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, preferences }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: OperatorConfig = await r.json();
      setCfg(d);
      toast.success('Operator config saved');
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: '8px 4px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Operator</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
        The Operator is the proactive concierge accessed from the top-bar Operator button.
        Edit its system prompt and workspace-scoped preferences here. Files live at{' '}
        <code>{cfg?.prompt_path}</code> and <code>{cfg?.prefs_path}</code>.
      </p>

      <form onSubmit={onSave}>
        <label
          style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}
        >
          System prompt
        </label>
        <div style={{ minHeight: 320, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <MarkdownEditor value={prompt} onChange={setPrompt} mode="ir" minHeight={320} />
        </div>

        <label
          style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}
        >
          Preferences notebook (workspace-scoped)
        </label>
        <div style={{ minHeight: 240, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
          <MarkdownEditor value={preferences} onChange={setPreferences} mode="ir" minHeight={240} />
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
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}
