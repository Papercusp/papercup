'use client';

/**
 * CompletionRefCard — P-017 of papercusp-dogfood-v5.
 *
 * Renders the verification state for a feature's completion_ref.
 * Three states per P-016's verifier daemon output:
 *
 *   verified  — SHA confirmed present on remote → tier-B ✓
 *   pending   — completion_ref set but not yet verified → tier-C
 *   divergent — SHA gone from remote (force-push / reverted) → ⚠
 *
 * Self-contained: fetches from GET /api/harness/:slug/features/:id.
 * Re-check button calls POST /api/harness/:slug/completion-ref/recheck
 * (P-016e / P-017c).
 *
 * Design: matches the section-body style used by FeatureTagsAndSeeAlso
 * and FeatureMessagesList in the same panel.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

// ── Trust-tier badge stub ─────────────────────────────────────────────
// Encapsulated here so P-073 (Insights) can swap in the real helper
// by replacing this function only. Tier vocabulary per §17 / D-030.
export type TrustTier = 'A' | 'B' | 'C' | 'D' | 'warning';

export function getTrustTierBadge(tier: TrustTier): { label: string; color: string; title: string } {
  switch (tier) {
    case 'A': return { label: '✓ A', color: '#16a34a', title: 'Tier A — org-attested' };
    case 'B': return { label: '✓ B', color: '#2563eb', title: 'Tier B — completion_ref verified' };
    case 'C': return { label: 'C', color: '#6b7280', title: 'Tier C — self-asserted' };
    case 'D': return { label: 'D', color: '#9ca3af', title: 'Tier D — unverified' };
    case 'warning': return { label: '⚠', color: '#d97706', title: 'Divergence detected' };
  }
}

// ── Types ─────────────────────────────────────────────────────────────

interface CompletionRef {
  remote: string;
  branch: string;
  commit_sha: string;
  pr_url?: string;
  pr_number?: number;
}

interface VerifState {
  completion_ref: CompletionRef | null;
  verified_done_at_remote_ts: string | null;
  verifier_last_error: string | null;
  verifier_last_checked_at: string | null;
}

type CardState = 'loading' | 'none' | 'verified' | 'pending' | 'divergent';

const COMPLETABLE_STATUSES = new Set(['pending_done', 'shipped', 'failing']);

// ── Helpers ───────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DIM = 'var(--fg-mute, #9ca3af)';
const BORDER = '1px solid var(--border, #e5e7eb)';

// ── Component ─────────────────────────────────────────────────────────

export function CompletionRefCard({
  slug,
  featureId,
  status,
}: {
  slug: string;
  featureId: string;
  status: string;
}): React.ReactElement | null {
  if (!COMPLETABLE_STATUSES.has(status)) return null;

  const [verif, setVerif] = useState<VerifState | null>(null);
  const [cardState, setCardState] = useState<CardState>('loading');
  const [rechecking, setRechecking] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/features/${encodeURIComponent(featureId)}`);
      if (!r.ok) { setCardState('none'); return; }
      const body = (await r.json()) as { feature: Record<string, unknown> };
      const f = body.feature;
      const data: VerifState = {
        completion_ref: (f.completion_ref as CompletionRef | null) ?? null,
        verified_done_at_remote_ts: (f.verified_done_at_remote_ts as string | null) ?? null,
        verifier_last_error: (f.verifier_last_error as string | null) ?? null,
        verifier_last_checked_at: (f.verifier_last_checked_at as string | null) ?? null,
      };
      setVerif(data);
      if (!data.completion_ref) {
        setCardState('none');
      } else if (data.verified_done_at_remote_ts) {
        setCardState('verified');
      } else if (data.verifier_last_error === 'sha_not_found') {
        setCardState('divergent');
      } else {
        setCardState('pending');
      }
    } catch {
      setCardState('none');
    }
  }, [slug, featureId]);

  useEffect(() => { void reload(); }, [reload]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const r = await fetch(`/api/harness/${slug}/completion-ref/recheck`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Re-checking — updated in ~60s');
      setTimeout(() => { void reload(); }, 3000);
    } catch (e) {
      toast.error('Re-check failed', { description: (e as Error).message });
    } finally {
      setRechecking(false);
    }
  }, [slug, reload]);

  if (cardState === 'loading') {
    return (
      <div style={{ fontSize: 12, color: DIM }}>Checking verification…</div>
    );
  }
  if (cardState === 'none') return null;

  const ref = verif?.completion_ref;
  if (!ref) return null;

  if (cardState === 'verified') {
    const badge = getTrustTierBadge('B');
    const verifiedAt = verif?.verified_done_at_remote_ts;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{ color: badge.color, fontWeight: 600, fontSize: 11 }}
            title={badge.title}
          >
            {badge.label}
          </span>
          <span>
            Merged at{' '}
            <code style={{ fontSize: 11 }}>{shortSha(ref.commit_sha)}</code>
            {' '}on <code style={{ fontSize: 11 }}>{ref.branch}</code>
            {verifiedAt ? ` — verified ${relativeTime(verifiedAt)}` : ''}
          </span>
          {ref.pr_url && (
            <a
              href={ref.pr_url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--accent, #2563eb)', marginLeft: 'auto' }}
            >
              #{ref.pr_number ?? 'PR'} ↗
            </a>
          )}
        </div>
      </div>
    );
  }

  if (cardState === 'divergent') {
    const badge = getTrustTierBadge('warning');
    const checkedAt = verif?.verifier_last_checked_at;
    return (
      <div
        style={{
          border: '1px solid #fcd34d',
          borderRadius: 4,
          padding: '6px 10px',
          background: '#fffbeb',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: badge.color, fontWeight: 600 }} title={badge.title}>
            {badge.label}
          </span>
          <span>
            The recorded commit{' '}
            <code style={{ fontSize: 11 }}>{shortSha(ref.commit_sha)}</code>
            {' '}is no longer present on{' '}
            <code style={{ fontSize: 11 }}>{ref.remote}</code>.
            The PR may have been force-pushed or reverted.
          </span>
        </div>
        {checkedAt && (
          <div style={{ fontSize: 11, color: DIM }}>
            Last checked {relativeTime(checkedAt)}
          </div>
        )}
        <div>
          <button
            type="button"
            onClick={() => { void recheck(); }}
            disabled={rechecking}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              cursor: rechecking ? 'not-allowed' : 'pointer',
              opacity: rechecking ? 0.5 : 1,
            }}
          >
            {rechecking ? 'Re-checking…' : 'Re-check'}
          </button>
        </div>
      </div>
    );
  }

  // pending
  const badge = getTrustTierBadge('C');
  const checkedAt = verif?.verifier_last_checked_at;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{ color: badge.color, fontWeight: 600, fontSize: 11 }}
          title={badge.title}
        >
          {badge.label}
        </span>
        <span>
          Merged at{' '}
          <code style={{ fontSize: 11 }}>{shortSha(ref.commit_sha)}</code>
          {' '}on <code style={{ fontSize: 11 }}>{ref.branch}</code>
          {' '}— verifying…
        </span>
        {ref.pr_url && (
          <a
            href={ref.pr_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, color: 'var(--accent, #2563eb)', marginLeft: 'auto' }}
          >
            #{ref.pr_number ?? 'PR'} ↗
          </a>
        )}
      </div>
      {checkedAt && (
        <div style={{ fontSize: 11, color: DIM }}>
          Last checked {relativeTime(checkedAt)}
          {' '}·{' '}
          <button
            type="button"
            onClick={() => { void recheck(); }}
            disabled={rechecking}
            style={{
              fontSize: 11,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: rechecking ? 'not-allowed' : 'pointer',
              color: 'var(--accent, #2563eb)',
              textDecoration: 'underline',
            }}
          >
            {rechecking ? 'Re-checking…' : 'Re-check'}
          </button>
        </div>
      )}
    </div>
  );
}
