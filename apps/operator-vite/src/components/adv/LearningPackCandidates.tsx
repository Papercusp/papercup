/**
 * LearningPackCandidates — the fleet→pack candidate review strip in the
 * Learnings view (self-improvement-consume-edges-2026-06-12 P-032 / B-11).
 *
 * Pending candidates are cross-hive recurring lessons staged by the
 * recurrence-escalation loop (`learningPacks.candidates` sync query) — each
 * carries provenance (signature, scopes, recurrence count, source items) and
 * waits for the OWNER: adopt writes it into the fleet-lessons pack (the pack
 * version bumps, so every hive carrying the pack lights `updateAvailable`
 * and adopts through the normal install/upgrade conflict review), dismiss is
 * terminal. Nothing here ever touches a hive's memory pool directly.
 *
 * Renders nothing when the queue is empty — the parent owns the layout.
 */
import { useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Inbox } from 'lucide-react';
import type { LearningPackCandidate } from '@papercusp/operator-core/lib/learning-packs/candidates';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

const actionBtn: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--fg-dim)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 7px',
};

export default function LearningPackCandidates() {
  const t = useLexicon();
  const sync = useSyncQuery<LearningPackCandidate>({
    queryName: 'learningPacks.candidates',
    args: {},
    staleTime: 30_000,
  });
  const pending = sync.data ?? [];

  // Which candidate's draft is expanded — URL state (agents drive review via
  // ui:dispatch; deep-linkable).
  const [lcand, setLcand] = useQueryState('lcand', parseAsString.withDefault(''));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adoptedNote, setAdoptedNote] = useState('');

  const decide = async (c: LearningPackCandidate, action: 'adopt' | 'dismiss') => {
    setError('');
    setAdoptedNote('');
    setBusy(c.id);
    try {
      const res = await fetch('/api/learning-packs/candidate-decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        error?: string;
        packId?: string;
        packVersion?: string;
      };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? data.reason ?? `HTTP ${res.status}`);
      } else if (action === 'adopt' && data.packId) {
        setAdoptedNote(
          `Adopted into ${data.packId} v${data.packVersion ?? '?'} — hives with the pack installed now show an update to review; others can install it from "add a pack".`,
        );
      }
    } catch (e) {
      setError((e as Error).message ?? 'network error');
    } finally {
      setBusy('');
      sync.invalidate();
    }
  };

  if (pending.length === 0 && !error && !adoptedNote) return null;

  return (
    <div
      style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', margin: '10px 0' }}
      data-testid="pack-candidates"
      aria-label="Fleet lesson candidates awaiting owner review"
    >
      <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Inbox size={13} aria-hidden /> Fleet lesson candidates
        <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--fg-mute)' }}>
          {pending.length} pending — lessons recurring across hives; adopting updates the fleet-lessons pack, never a
          hive directly
        </span>
      </p>
      {pending.map((c) => (
        <div key={c.id} style={{ borderTop: '1px solid var(--border)', padding: '7px 0', fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ flex: 1, minWidth: 200 }}>{c.title}</strong>
            <button
              type="button"
              style={actionBtn}
              onClick={() => void setLcand(lcand === c.id ? '' : c.id)}
              aria-expanded={lcand === c.id}
            >
              {lcand === c.id ? 'hide draft' : 'view draft'}
            </button>
            <Tooltip label={`Write this lesson into the fleet-lessons pack (${t('pot', { plural: true, lower: true })} adopt it through the pack update review)`}>
              <button
                type="button"
                style={{ ...actionBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                disabled={busy === c.id}
                onClick={() => void decide(c, 'adopt')}
              >
                adopt
              </button>
            </Tooltip>
            <Tooltip label="Dismiss permanently — this lesson's signature never re-files">
              <button
                type="button"
                style={actionBtn}
                disabled={busy === c.id}
                onClick={() => void decide(c, 'dismiss')}
              >
                dismiss
              </button>
            </Tooltip>
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 2 }}>
            recurred {c.recurrenceCount}× across {c.scopes.join(', ')}
            {c.sourceItemIds.length > 0 ? ` · from ${c.sourceItemIds.join(', ')}` : ''}
          </div>
          {lcand === c.id && (
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, padding: '6px 8px', background: 'var(--bg-2)', borderRadius: 4 }}>
              {c.draftText}
            </div>
          )}
        </div>
      ))}
      {adoptedNote ? <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--good, #34d399)' }}>{adoptedNote}</p> : null}
      {error ? (
        <p className="pc-learning__empty" role="alert" style={{ margin: '6px 0 0' }}>
          Candidate action failed: {error}
        </p>
      ) : null}
    </div>
  );
}
