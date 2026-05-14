'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';

interface Props {
  slug: string;
  alive: boolean;
  onClose: () => void;
}

// supervisor-notes.md is already mirrored to harness_shared.harness_escalations
// (supervisor_notes column) by harness-fs-watcher.ts — reuse that subscription
// instead of adding another mirror.
type HarnessEscalationRow = {
  harnessSlug: string;
  phase: string;
  escalation?: string | null;
  supervisorNotes?: string | null;
  mtimeMs: number;
};

export default function InterventionPanel({ slug, alive, onClose }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const notesRef = useRef<HTMLPreElement>(null);

  // Live-pushed via Zero. Replaces useSseOrPoll(/notes/sse, load, 5000).
  const { data: escalationRows } = useSyncQuery<HarnessEscalationRow>({
    queryName: 'harnessEscalations.byHarness',
    args: { harnessSlug: slug, phase: 'staging' },
  });
  const notes = useMemo(() => escalationRows?.[0]?.supervisorNotes ?? null, [escalationRows]);
  const mtimeMs = useMemo(() => escalationRows?.[0]?.mtimeMs ?? null, [escalationRows]);

  // Auto-scroll notes to bottom when content changes
  useEffect(() => {
    if (notesRef.current) notesRef.current.scrollTop = notesRef.current.scrollHeight;
  }, [notes]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) {
      setToast('type a message first');
      setTimeout(() => setToast(null), 2000);
      return;
    }
    setSending(true);
    try {
      const r = await fetch(`/api/harness/${slug}/escalation/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: text, action: 'keep' }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setDraft('');
      setToast('appended to supervisor-notes.md');
      // Zero pushes the new mtime+content once chokidar mirrors the file write.
    } catch (e) {
      setToast(`send failed: ${e}`);
    } finally {
      setSending(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [draft, slug]);

  // Ctrl/Cmd+Enter to send
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [send]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Intervention`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '70vw', maxWidth: 900, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: 'var(--fg)' }}>Intervention — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>.harness/supervisor-notes.md</span>
          {alive && (
            <span style={{ color: 'var(--good)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
              ● mission running — next orchestrator iteration will read your note
            </span>
          )}
          {toast && (
            <span style={{ marginLeft: 'auto', color: /failed|first/i.test(toast) ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>
              {toast}
            </span>
          )}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem', marginLeft: toast ? 0 : 'auto' }}
          >
            close
          </button>
        </div>

        {/* Notes read pane */}
        <div style={{ flex: '1 1 60%', display: 'flex', flexDirection: 'column', minHeight: 0, borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-mute)', padding: '0.4rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            history
            {mtimeMs && (
              <span style={{ color: 'var(--fg-mute)' }}>
                · updated {Math.round((Date.now() - mtimeMs) / 1000)}s ago
              </span>
            )}
            <span style={{ marginLeft: 'auto', color: 'var(--fg-mute)' }}>polls every 5s</span>
          </div>
          <pre
            ref={notesRef}
            style={{ flex: 1, overflow: 'auto', margin: 0, padding: '0.75rem 1rem', fontSize: '0.8rem', fontFamily: 'ui-monospace, monospace', color: 'var(--fg-dim)', whiteSpace: 'pre-wrap', background: 'var(--bg)' }}
          >
            {notes ?? '(no notes yet — send your first message below to seed supervisor-notes.md)'}
          </pre>
        </div>

        {/* Compose */}
        <div style={{ flex: '0 0 auto', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Your message to the orchestrator. Gets appended to supervisor-notes.md with a timestamp. Next iteration will read it as authoritative guidance. (Cmd/Ctrl+Enter to send)"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--bg-2)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 3,
              padding: '0.5rem 0.7rem',
              fontSize: '0.85rem',
              fontFamily: 'ui-monospace, monospace',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--fg-mute)' }}>
              Cmd/Ctrl+Enter to send
            </span>
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              style={{
                marginLeft: 'auto',
                background: draft.trim() ? '#2563eb' : '#374151',
                color: 'white', border: 'none', borderRadius: 3,
                padding: '0.4rem 0.9rem',
                cursor: sending ? 'wait' : (draft.trim() ? 'pointer' : 'not-allowed'),
                fontWeight: 600, fontSize: '0.85rem',
              }}
            >
              {sending ? 'sending…' : 'append to notes'}
            </button>
          </div>
        </div>
      </Modal>
  );
}
