'use client';

/**
 * OperatorNoteForm — inline form for sending feature-scoped guidance to a worker.
 *
 * Phase A "Steer" UI. Renders inside FeaturePeekPanel as a collapsible
 * section. On submit, POSTs the note as a timestamped block to
 * `<projectDir>/.harness/notes/<featureId>.md` — which the worker prompt's
 * Required Reads pulls on its next dispatch.
 *
 * Lists existing notes (oldest first) so the operator sees what they've
 * already said before adding more.
 */
import { useCallback, useEffect, useState } from 'react';
import { Send, Loader2, AlertTriangle, MessageSquarePlus } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from './theme';
import { Tooltip } from './Tooltip';

interface NoteBlock {
  author: string;
  ts: string;
  body: string;
}

interface NotesResponse {
  raw: string;
  blocks: NoteBlock[];
}

export interface OperatorNoteFormProps {
  slug: string;
  featureId: string;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export default function OperatorNoteForm({ slug, featureId }: OperatorNoteFormProps) {
  const [notes, setNotes] = useState<NoteBlock[]>([]);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(featureId)}/notes`);
      if (!r.ok) {
        setLoadError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as NotesResponse;
      setNotes(data.blocks ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [slug, featureId]);

  useEffect(() => { void load(); }, [load]);

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    setState({ kind: 'submitting' });
    try {
      const r = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(featureId)}/notes`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setState({ kind: 'error', message: body.error ?? `HTTP ${r.status}` });
        return;
      }
      setState({ kind: 'success' });
      setDraft('');
      void load();
      // Brief success indicator, then back to idle.
      setTimeout(() => setState((s) => (s.kind === 'success' ? { kind: 'idle' } : s)), 1500);
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [slug, featureId, draft, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {loadError && (
        <div style={{
          fontSize: SIZES.xs, color: '#fcd591',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <AlertTriangle size={11} /> failed to load existing notes: {loadError}
        </div>
      )}

      {notes.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          maxHeight: 200, overflowY: 'auto',
          padding: 8,
          background: COLORS.bg,
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm,
        }}>
          {notes.map((n) => (
            <div key={`${n.author}-${n.ts}`} style={{
              display: 'flex', flexDirection: 'column', gap: 3,
              padding: '6px 8px',
              background: COLORS.surfaceRaised,
              borderRadius: RADIUS.sm,
              border: `1px solid ${COLORS.borderSubtle}`,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontFamily: FONTS.mono, fontSize: '0.65rem',
                color: COLORS.textDim,
              }}>
                <span>{n.author}</span>
                <span>·</span>
                <span>{new Date(n.ts).toLocaleString(undefined, {
                  year: 'numeric', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}</span>
              </div>
              <div style={{
                fontSize: SIZES.sm, color: COLORS.text,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.45,
              }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={`Note to the worker on ${featureId}… (⌘/Ctrl+Enter to send)`}
          rows={3}
          disabled={state.kind === 'submitting'}
          style={{
            fontFamily: 'inherit',
            fontSize: SIZES.sm,
            color: COLORS.text,
            background: COLORS.bg,
            border: `1px solid ${COLORS.borderSubtle}`,
            borderRadius: RADIUS.sm,
            padding: 8,
            resize: 'vertical',
            outline: 'none',
            minHeight: 60,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.borderSubtle; }}
        />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: SIZES.xs, color: COLORS.textDim,
        }}>
          <span style={{ flex: 1 }}>
            Block lands at <code>.harness/notes/{featureId}.md</code> · worker reads it on its next dispatch.
          </span>
          {state.kind === 'error' && (
            <span style={{ color: COLORS.dangerText, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={11} /> {state.message}
            </span>
          )}
          {state.kind === 'success' && (
            <span style={{ color: COLORS.successText }}>sent ✓</span>
          )}
          <Tooltip label="Save this note — the worker will read it on its next dispatch (⌘/Ctrl+Enter)">
            <button
              type="submit"
              disabled={state.kind === 'submitting' || !draft.trim()}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 12px',
                background: draft.trim() ? COLORS.accent : COLORS.surfaceRaised,
                color: draft.trim() ? '#fff' : COLORS.textDim,
                border: `1px solid ${draft.trim() ? COLORS.accent : COLORS.borderSubtle}`,
                borderRadius: RADIUS.sm,
                fontSize: SIZES.xs,
                cursor: draft.trim() ? 'pointer' : 'not-allowed',
                opacity: state.kind === 'submitting' ? 0.6 : 1,
              }}
            >
              {state.kind === 'submitting' ? <Loader2 size={11} className="op-note-spin" /> : <Send size={11} />}
              send note
            </button>
          </Tooltip>
        </div>
      </form>
    </div>
  );
}
