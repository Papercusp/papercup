'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MarkdownEditor } from '../../_components/MarkdownEditor';

interface OracleConfig {
  prompt: string;
  memory: string;
  prompt_path: string;
  memory_path: string;
}

export default function OracleSettingsPage() {
  const [cfg, setCfg] = useState<OracleConfig | null>(null);
  const [prompt, setPrompt] = useState('');
  const [memory, setMemory] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/oracle/config')
      .then((r) => r.json())
      .then((d: OracleConfig) => {
        if (cancelled) return;
        setCfg(d);
        setPrompt(d.prompt);
        setMemory(d.memory);
      })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await fetch('/api/oracle/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, memory }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: OracleConfig = await r.json();
      setCfg(d);
      toast.success('Oracle config saved');
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: '8px 4px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Oracle</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
        The Oracle is the always-mounted assistant in the bottom-right of every page.
        Edit its system prompt and persistent memory here. Files live at{' '}
        <code>{cfg?.prompt_path}</code> and <code>{cfg?.memory_path}</code>.
      </p>

      <form onSubmit={onSave}>
        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
          System prompt
        </label>
        <div style={{ minHeight: 320, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <MarkdownEditor value={prompt} onChange={setPrompt} mode="ir" outline="left" minHeight={320} />
        </div>

        <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginTop: 20, marginBottom: 6 }}>
          Persistent memory
        </label>
        <div style={{ minHeight: 240, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <MarkdownEditor value={memory} onChange={setMemory} mode="ir" outline="left" minHeight={240} />
        </div>

        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={saving} className="pc-button">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
