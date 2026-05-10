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
  /** Eager-loaded raw markdown content (from the dashboard's
   *  featureNotes.byHarness Zero subscription). When provided, the form
   *  parses it client-side and skips the per-feature REST fetch. Falls
   *  back to fetch for callers that haven't been migrated yet. */
  initialNotes?: string;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

// Parse the markdown notes file into blocks. Header line: "## <author> <ts>".
// Bodies run from one header to the next. Mirrors the parser in the GET route
// handler so client and server agree on the block shape.
function parseNoteBlocks(raw: string): NoteBlock[] {
  if (!raw || !raw.trim()) return [];
  const blocks: NoteBlock[] = [];
  const headerRe = /^##\s+(\S+)\s+(\S+)\s*$/gm;
  const headers: { idx: number; author: string; ts: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw)) !== null) {
    headers.push({ idx: m.index, author: m[1], ts: m[2] });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].idx;
    const end = i + 1 < headers.length ? headers[i + 1].idx : raw.length;
    const lineEnd = raw.indexOf('\n', start);
    const body = raw.slice(lineEnd + 1, end).trim();
    blocks.push({ author: headers[i].author, ts: headers[i].ts, body });
  }
  return blocks;
}

export default function OperatorNoteForm({ slug, featureId, initialNotes }: OperatorNoteFormProps) {
  const [notes, setNotes] = useState<NoteBlock[]>(() => parseNoteBlocks(initialNotes ?? ''));
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [loadError, setLoadError] = useState<string | null>(null);

  // Re-parse when the eager subscription pushes a new value (other tab
  // submitted a note, etc.). Only fall back to fetch when no eager
  // value was provided at all.
  useEffect(() => {
    if (initialNotes !== undefined) {
      setNotes(parseNoteBlocks(initialNotes));
      setLoadError(null);
      return;
    }
    // Legacy path: fetch when caller didn't pass eager notes.
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(featureId)}/notes`);
        if (!r.ok) { if (!cancelled) setLoadError(`HTTP ${r.status}`); return; }
        const data = (await r.json()) as NotesResponse;
        if (!cancelled) { setNotes(data.blocks ?? []); setLoadError(null); }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [slug, featureId, initialNotes]);

  const load = useCallback(async () => {
    // Kept as a no-op for back-compat with callers that invoked it after
    // submit. The Zero subscription handles refreshing now (SSE invalidate
    // in appendOperatorNote pushes the new content to all open tabs).
    return;
  }, []);

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
      // Notify other surfaces that show the same notes (e.g. the right
      // side FeaturePeekPanel) so they re-fetch immediately rather than
      // waiting for the user to close and reopen the panel.
      try {
        window.dispatchEvent(new CustomEvent('operator-notes:updated', {
          detail: { slug, featureId },
        }));
      } catch {}
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
          autoFocus
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
