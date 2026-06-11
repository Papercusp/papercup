'use client';

/**
 * HiveHeaderStrip — the selected hive's "face" inside the Harnesses tab
 * (harnesses-tab-hive-model-2026-06-07 P-022). Read-only v1.
 *
 * A compact header above the member dock summarising the hive the tab is
 * scoped to: its name, kind, member count (the Colony size), how many members
 * are set up (the rail's zero-new-poller `hasState` liveness signal), and a
 * shared badge. A deploy badge shows only when the hive carries a non-local
 * deployment (D-022 "deploy:status when deployed").
 *
 * Labels route through `useLexicon` (D-006 — "Pot"/"Hive", "Harness(es)",
 * "Fleet"/"Colony"); flag default off keeps the classic words. Derived purely
 * from data the tab already loaded (projects/lite + the P-021 grouping) — no
 * new poller, consistent with the member rail.
 *
 * v1 SCOPE NOTE: blueprint-id, LIVE Colony/Queen presence (coord), and live
 * deploy:status are intentionally NOT wired here yet — they need a per-hive
 * data source the registry/grouping payload doesn't carry (fleet presence is
 * keyed by agent, not hive). Tracked as a P-022 follow-up; this v1 ships the
 * facets that are correct + free from the loaded data rather than mis-attribute
 * fleet-wide presence to one hive.
 */

import { useState } from 'react';
import { Share2, Users, Cloud } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';

export interface HiveHeaderMember {
  slug: string;
  hasState?: boolean;
}

export interface HiveHeaderStripProps {
  /** The hive root slug (the `?slug=` scope). */
  hiveSlug: string;
  /** The hive root's kind, if any (`'hive'` ⇒ a formal Hive home). */
  hiveKind?: string | null;
  /** Whether the hive root is a shared harness. */
  isShared?: boolean;
  /** The hive's members (root + members), for the Colony count + liveness. */
  members: readonly HiveHeaderMember[];
  /** Truthy ⇒ the hive is deployed to a non-local execution plane (badge only). */
  deployed?: boolean;
  /**
   * P-015 (hive-from-github-url): the directory visibility flip seam — tests
   * inject; default POSTs /api/discovery/set-hive (private withdraws + unlists,
   * public/invite runs the full publish set). Only rendered for formal Hive
   * homes (kind 'hive').
   */
  setVisibility?: (
    hiveSlug: string,
    visibility: 'public' | 'invite' | 'private',
    inviteSecret?: string,
  ) => Promise<{ ok: boolean; announced?: boolean; withdrawn?: boolean; error?: string }>;
}

async function defaultSetVisibility(
  hiveSlug: string,
  visibility: 'public' | 'invite' | 'private',
  inviteSecret?: string,
): Promise<{ ok: boolean; announced?: boolean; withdrawn?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/discovery/set-hive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hiveId: hiveSlug,
        title: hiveSlug,
        visibility,
        ...(inviteSecret ? { inviteSecret } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      announced?: boolean;
      withdrawn?: boolean;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, announced: body.announced, withdrawn: body.withdrawn };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function HiveHeaderStrip({
  hiveSlug,
  hiveKind,
  isShared,
  members,
  deployed,
  setVisibility = defaultSetVisibility,
}: HiveHeaderStripProps) {
  const t = useLexicon();
  // P-015 flip lifecycle (busy/outcome) — transient, render-only → useState.
  const [flip, setFlip] = useState<{
    busy: boolean;
    outcome?: { ok: boolean; announced?: boolean; withdrawn?: boolean; error?: string };
    inviteSecret?: string;
  }>({ busy: false });
  if (!hiveSlug) return null;

  async function applyVisibility(v: 'public' | 'invite' | 'private'): Promise<void> {
    // An invite flip mints the secret CLIENT-side so it can be shown exactly once.
    const inviteSecret =
      v === 'invite'
        ? Array.from(crypto.getRandomValues(new Uint8Array(24)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : undefined;
    setFlip({ busy: true });
    const outcome = await setVisibility(hiveSlug, v, inviteSecret);
    setFlip({ busy: false, outcome, ...(outcome.ok && inviteSecret ? { inviteSecret } : {}) });
  }

  const hiveLabel = t('pot');
  const membersLabel = t('harness', { plural: true });
  const colonyLabel = t('fleet'); // "Fleet" | "Colony" — the live-agent collective (D-007)
  const memberCount = members.length;
  const setUp = members.filter((m) => m.hasState).length;

  return (
    <header className="pc-hive-header" data-testid="hive-header-strip" aria-label={`${hiveLabel} header`}>
      <div className="pc-hive-header__id">
        <span className="pc-hive-header__name" title={hiveSlug}>
          {hiveSlug}
        </span>
        {hiveKind === 'hive' ? (
          <span className="pc-hive-header__kind" title={`${hiveLabel} home`}>
            👑 {hiveLabel}
          </span>
        ) : hiveKind && hiveKind !== 'harness' ? (
          <span className="pc-hive-header__kind">{hiveKind}</span>
        ) : null}
        {isShared && <Share2 size={12} className="pc-hive-header__shared" aria-label="Shared" />}
        {deployed && (
          <span className="pc-hive-header__deploy" title="Deployed to a cloud Swarm">
            <Cloud size={11} aria-hidden /> deployed
          </span>
        )}
      </div>
      <div className="pc-hive-header__stats">
        <span className="pc-hive-header__stat" title={`${memberCount} member ${membersLabel.toLowerCase()}`}>
          <Users size={12} aria-hidden />
          {memberCount} {memberCount === 1 ? t('harness') : membersLabel}
        </span>
        {memberCount > 0 && (
          <span
            className="pc-hive-header__stat pc-hive-header__stat--muted"
            title={`${setUp} of ${memberCount} set up (${colonyLabel.toLowerCase()} liveness)`}
          >
            {setUp}/{memberCount} set up
          </span>
        )}
        {hiveKind === 'hive' && (
          <span
            className="pc-hive-header__stat"
            data-testid="hive-visibility-flip"
            role="group"
            aria-label="Directory visibility"
          >
            {/* Flat action pills, not a <select> (design HR3 — and this is an
                action menu, not a value selection: nothing persists in the
                control). Same applyVisibility seam as the select it replaced. */}
            <span className="pc-hive-header__viz-label">
              {flip.busy ? 'publishing…' : 'directory:'}
            </span>
            <button
              type="button"
              className="pc-hive-header__viz-btn"
              disabled={flip.busy}
              title="Publish to the directory (public)"
              onClick={() => void applyVisibility('public')}
            >
              publish
            </button>
            <button
              type="button"
              className="pc-hive-header__viz-btn"
              disabled={flip.busy}
              title="Publish invite-only (mints a one-time invite secret)"
              onClick={() => void applyVisibility('invite')}
            >
              invite-only
            </button>
            <button
              type="button"
              className="pc-hive-header__viz-btn"
              disabled={flip.busy}
              title="Withdraw from the directory (private)"
              onClick={() => void applyVisibility('private')}
            >
              withdraw
            </button>
            {flip.outcome && (
              <span
                className="pc-hive-header__stat--muted"
                data-testid="hive-visibility-outcome"
                title={flip.inviteSecret ? `Invite secret: ${flip.inviteSecret}` : undefined}
              >
                {flip.outcome.ok
                  ? flip.outcome.withdrawn
                    ? 'withdrawn'
                    : flip.outcome.announced
                      ? 'announced'
                      : 'saved'
                  : `failed: ${flip.outcome.error ?? 'error'}`}
                {flip.inviteSecret ? ` · secret: ${flip.inviteSecret.slice(0, 8)}… (hover)` : ''}
              </span>
            )}
          </span>
        )}
      </div>
      <HeaderStyles />
    </header>
  );
}

function HeaderStyles() {
  return (
    <style>{`
      .pc-hive-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 12px;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 95%);
      }
      .pc-hive-header__id {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .pc-hive-header__name {
        font-size: 13px;
        font-weight: 680;
        color: var(--fg, #e7f7ff);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-hive-header__kind {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        padding: 1px 7px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        color: var(--fg, #e7f7ff);
      }
      .pc-hive-header__shared { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-hive-header__deploy {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        font-weight: 650;
        color: var(--good, #34d399);
      }
      .pc-hive-header__stats {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        flex: 0 0 auto;
      }
      .pc-hive-header__stat {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--fg-dim, #b9d4e8);
        font-variant-numeric: tabular-nums;
      }
      .pc-hive-header__stat--muted { color: var(--fg-mute, #7f9bb4); font-weight: 500; }
      .pc-hive-header__viz-label {
        font-size: 10.5px;
        font-weight: 500;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-hive-header__viz-btn {
        padding: 1px 8px;
        font-size: 10.5px;
        font-weight: 600;
        color: var(--fg-dim, #b9d4e8);
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-hive-header__viz-btn:hover:not(:disabled) {
        color: var(--fg, #e7f7ff);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 88%);
      }
      .pc-hive-header__viz-btn:disabled { opacity: 0.5; cursor: default; }
    `}</style>
  );
}
