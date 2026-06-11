'use client';

/**
 * Cupboard listing detail view.
 *
 * Shows full metadata + claim status + the per-listing primary action
 * (View Hive / Fork / Install — D-005, reframed by
 * comb-retire-per-harness-sharing-2026-06-11: per-harness Join is RETIRED; a
 * `kind='harness'` row is the repo→Hive lookup index, so hive-bound rows point
 * at the owning Hive and legacy rows have no primary action). Renders against
 * either the live-worker row shape or the aspirational HarnessListing shape
 * via the cupboard/types helpers.
 *
 * The fork/install kinds execute their action directly from here:
 *   - blueprint Fork → POST /api/cupboard/install-blueprint (clone + validate +
 *     dep-check → ~/.papercusp/blueprints/<id>/, the installed tier of the
 *     local→installed→built-in resolution —
 *     official-blueprints-cupboard-publish-2026-06-05 P-004/D-001/D-004).
 *     Declared plugin deps are NOT auto-installed from this button (consent
 *     stays explicit — the toast lists what's installable instead).
 *   - plugin / pack Install → POST /api/cupboard/install-plugin (clone the
 *     listing's repo into global-plugins — EI-27). The global install only
 *     REGISTERS the unit; the manifest's requested capabilities are surfaced in
 *     the toast but NOT granted here — per-harness capability consent
 *     (acceptCapabilities) stays an explicit act at enable-time (D-009). This
 *     replaces the dead `/harness?cupboardListing=…` navigation that nothing
 *     consumed.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from '@/lib/router-compat/navigation';
import {
  Shield, ExternalLink, Users, Clock, GitBranch,
  ArrowLeft, Loader2, AlertTriangle, GitFork, Plug, Globe, Hexagon,
} from 'lucide-react';
import type { HarnessListing, ListingAction } from '@papercusp/operator-core/lib/cupboard/types';
import {
  listingActionFor,
  listingKindOf,
  listingRepoSlug,
  listingContributorCount,
  listingTopLanguage,
  listingHiveRef,
  LISTING_ACTION_LABEL,
} from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';
import { CupboardErrorState } from '../CupboardErrorState';
import { toast } from 'sonner';

/** Icon for a listing's action (null = legacy harness row — kind icon only). */
function ActionIcon({ action, size = 14 }: { action: ListingAction | null; size?: number }) {
  switch (action) {
    case 'view-hive': return <Hexagon size={size} />;
    case 'fork': return <GitFork size={size} />;
    case 'install': return <Plug size={size} />;
    default: return <Globe size={size} />;
  }
}

export default function CupboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const [listing, setListing] = useState<HarnessListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // In-flight lifecycle flag for the direct-execution action (blueprint
  // install) — render-lifecycle state, not URL state.
  const [busy, setBusy] = useState(false);

  const fetchListing = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetch(`/api/cupboard/listings/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { listing: HarnessListing }) => { setListing(data.listing); })
      .catch((err: unknown) => { setError(String(err)); })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchListing(); }, [fetchListing]);

  const handleAction = () => {
    if (!listing) return;
    const kind = listingKindOf(listing);
    if (listingActionFor(listing) === 'view-hive') {
      // The owning Hive's rollup in the storefront (per-harness join is retired).
      router.push(`/cupboard?hive=${encodeURIComponent(listingHiveRef(listing))}`);
      return;
    }
    // Blueprint fork installs the listing into the local installed tier
    // (~/.papercusp/blueprints/<id>/), where it shadows a same-id built-in and
    // becomes resolvable to harness:create / blueprint:extend.
    if (kind === 'blueprint') {
      void installBlueprintFromCupboard();
      return;
    }
    // learning-pack (learning-packs P-017): fetch the pack files into the
    // installed root — it then appears in the creation picker + Learning tab,
    // and lands in a hive only through the normal conflict review.
    if (kind === 'learning-pack') {
      void fetchLearningPackFromComb();
      return;
    }
    // plugin | tool-pack — the remaining install kinds — clone into
    // global-plugins directly (EI-27). Replaces the dead
    // `/harness?cupboardListing=…` navigation no consumer ever read.
    void installPluginFromCupboard();
  };

  // learning-pack Install (learning-packs P-017): stage the pack locally.
  // Nothing is injected into any agent by the fetch itself — adding it to a
  // hive happens in the Learning tab, through the install conflict review.
  const fetchLearningPackFromComb = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/learning-packs/fetch-from-comb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        pack?: { id: string; title: string; version: string; itemCount: number };
        error?: string;
        detail?: string;
      };
      if (!r.ok || !d.ok || !d.pack) {
        toast.error(`Fetch failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      toast.success(
        `Learning pack "${d.pack.title}" v${d.pack.version} fetched (${d.pack.itemCount} learnings). ` +
          'Add it to a hive from the Learning tab → Learnings — incoming learnings go through the conflict review there.',
      );
    } catch (e) {
      toast.error(`Fetch crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const installBlueprintFromCupboard = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-blueprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No installPlugins:true — plugin-capability consent stays an explicit
        // per-plugin act; the toast lists what's installable instead.
        body: JSON.stringify({ listingId: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        version?: string | null;
        depCheck?: { installable?: { plugins?: string[] } } | null;
        error?: string;
        detail?: string;
      };
      if (!r.ok || !d.ok) {
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      const installable = d.depCheck?.installable?.plugins ?? [];
      toast.success(
        `Blueprint "${d.id}" installed${d.version ? ` v${d.version}` : ''} — usable in harness:create / blueprint:extend.` +
          (installable.length > 0
            ? ` Declares plugin deps you can install from their listings: ${installable.join(', ')}.`
            : ''),
      );
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // plugin / pack Install: clone the listing's repo into global-plugins. We do
  // NOT pass harness/acceptCapabilities — the global install only registers the
  // unit; per-harness capability consent stays explicit at enable-time (D-009).
  // The toast surfaces the manifest's requested capabilities + any installable
  // declared deps for transparency.
  const installPluginFromCupboard = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-plugin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        name?: string;
        version?: string;
        kind?: string;
        capabilities?: string[];
        installableDependencies?: { tools?: string[]; packs?: string[]; plugins?: string[] } | null;
        error?: string;
        detail?: string;
      };
      if (!r.ok || !d.ok) {
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      const unit = d.kind === 'pack' ? 'Pack' : 'Plugin';
      const caps = d.capabilities ?? [];
      const installable = [
        ...(d.installableDependencies?.tools ?? []),
        ...(d.installableDependencies?.packs ?? []),
        ...(d.installableDependencies?.plugins ?? []),
      ];
      toast.success(
        `${unit} "${d.name}" installed${d.version ? ` v${d.version}` : ''}.` +
          (caps.length > 0
            ? ` Requests capabilities (granted per-harness on enable): ${caps.join(', ')}.`
            : '') +
          (installable.length > 0
            ? ` Declares installable deps: ${installable.join(', ')}.`
            : ''),
      );
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: SIZES.lg, display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div style={{ padding: SIZES.lg }}>
        <button onClick={() => router.back()} style={backBtnStyle}>
          <ArrowLeft size={13} /> Back
        </button>
        <div style={{ marginTop: SIZES.md }}>
          {error ? (
            <CupboardErrorState raw={error} what="this listing" onRetry={fetchListing} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger)' }}>
              <AlertTriangle size={14} />
              Listing not found.
            </div>
          )}
        </div>
      </div>
    );
  }

  const kind = listingKindOf(listing);
  const repoSlug = listingRepoSlug(listing);
  const contributors = listingContributorCount(listing);
  const language = listingTopLanguage(listing);
  const action = listingActionFor(listing);
  // provides_tools (worker migration 006): JSON string[] of the MCP tool names
  // a plugin/pack unit registers — surfaced so the user sees what installing buys.
  const providesTools: string[] = (() => {
    if (!listing.provides_tools) return [];
    try {
      const parsed: unknown = JSON.parse(listing.provides_tools);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  })();

  return (
    <div style={{ padding: SIZES.lg, maxWidth: 700, margin: '0 auto' }}>
      <button onClick={() => router.back()} style={backBtnStyle}>
        <ArrowLeft size={13} /> Back to Cupboard
      </button>

      <div style={{ marginTop: SIZES.lg }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontFamily: FONTS.ui, fontWeight: 700, fontSize: 20, color: COLORS.text, margin: 0 }}>
            {listing.title || listing.slug || repoSlug || 'Untitled'}
          </h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span className="pc-badge" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted,
            }} data-testid="cupboard-detail-kind" data-kind={kind}>
              <ActionIcon action={action} size={12} /> {kind}
            </span>
            {listing.claim_status === 'claimed' && (
              <span className="pc-badge" style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'color-mix(in srgb, var(--success), transparent 86%)', color: 'var(--success)',
                border: '1px solid color-mix(in srgb, var(--success), transparent 76%)',
              }}>
                <Shield size={12} /> Claimed
              </span>
            )}
          </span>
        </div>

        {/* Description */}
        <p style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.textMuted, marginTop: 8 }}>
          {listing.description || 'No description.'}
        </p>

        {/* Metadata grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SIZES.sm,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg, padding: SIZES.md, marginTop: SIZES.md,
        }}>
          {repoSlug && (
            <MetaRow label="GitHub repo">
              <a
                href={`https://github.com/${repoSlug}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--accent-soft)', fontFamily: FONTS.mono, fontSize: SIZES.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {repoSlug} <ExternalLink size={11} />
              </a>
            </MetaRow>
          )}
          {listing.listing_ref && (
            <MetaRow label={kind === 'plugin' ? 'Plugin' : kind === 'tool-pack' ? 'Tool pack' : kind === 'learning-pack' ? 'Learning pack' : 'Listing'}>
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.listing_ref}</span>
            </MetaRow>
          )}
          {providesTools.length > 0 && (
            <MetaRow label="Provides tools">
              <span
                data-testid="cupboard-detail-provides-tools"
                style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}
              >
                {providesTools.join(', ')}
              </span>
            </MetaRow>
          )}
          {listing.project_ref && (
            <MetaRow label="Project">
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.project_ref}</span>
            </MetaRow>
          )}
          <MetaRow label="Claim status">
            <span style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text, textTransform: 'capitalize' }}>
              {listing.claim_status}
            </span>
          </MetaRow>
          {contributors > 0 && (
            <MetaRow label="Contributors">
              <span style={valueStyle}><Users size={12} /> {contributors}</span>
            </MetaRow>
          )}
          {listing.last_activity_at && (
            <MetaRow label="Last activity">
              <span style={valueStyle}><Clock size={12} /> {new Date(listing.last_activity_at).toLocaleDateString()}</span>
            </MetaRow>
          )}
          {language && (
            <MetaRow label="Language">
              <span style={valueStyle}><GitBranch size={12} /> {language}</span>
            </MetaRow>
          )}
          {listing.tags && listing.tags.length > 0 && (
            <MetaRow label="Tags">
              <span style={valueStyle}>{listing.tags.join(', ')}</span>
            </MetaRow>
          )}
        </div>

        {/* learning-pack: every learning is readable BEFORE install — the
            pre-install trust surface (learning-packs P-015, D-007). */}
        {kind === 'learning-pack' && repoSlug && (
          <LearningPackContents repoSlug={repoSlug} listingRef={listing.listing_ref ?? null} />
        )}

        {/* Per-listing primary CTA — hidden for legacy harness rows (per-harness
            join is retired; nothing to act on). */}
        <div style={{ marginTop: SIZES.lg, display: 'flex', gap: 8 }}>
          {action && (
          <button
            onClick={handleAction}
            disabled={busy}
            data-testid="cupboard-detail-action"
            data-action={action}
            className="pc-button"
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              borderColor: 'var(--accent-strong)',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? (
              <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Installing {kind}…</>
            ) : (
              <><ActionIcon action={action} /> {LISTING_ACTION_LABEL[action]}{action === 'install' || action === 'fork' ? ` ${kind}` : ''}</>
            )}
          </button>
          )}
          {repoSlug && (
            <a
              href={`https://github.com/${repoSlug}`}
              target="_blank" rel="noopener noreferrer"
              className="pc-button"
              style={{ textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> View on GitHub
            </a>
          )}
        </div>

        {/* Trust note for code-pulling kinds (D-007/D-009). */}
        {(action === 'fork' || action === 'install') && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            {action === 'fork' ? 'Forking' : 'Installing'} pulls code from this listing. Plugin capabilities are gated by manifest + your install-time consent; review the source on GitHub first.
          </p>
        )}

        {/* Harness rows are the repo→Hive lookup index (comb-retire D-003). */}
        {kind === 'harness' && action === 'view-hive' && listing.hive_title && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This repo belongs to the hive <strong>{listing.hive_title}</strong> — sharing and joining happen at the hive level.
          </p>
        )}
        {kind === 'harness' && !action && (
          <p data-testid="cupboard-detail-legacy-note" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            Per-harness sharing is retired — this is a legacy listing with no owning hive. Share the hive instead.
          </p>
        )}

        {listing.claim_status === 'unclaimed' && kind === 'harness' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This listing is unclaimed — no verified maintainer of the repo has bound it to their account yet.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * LearningPackContents — read every learning BEFORE installing
 * (learning-packs-2026-06-11 P-015): the pre-install trust surface for
 * instruction-carrying content. Fetched straight from the public GitHub repo
 * (contents API + raw download; unauthenticated, so a rate-limit or network
 * miss degrades to the "browse on GitHub" link, never an error wall).
 * Convention: the pack lives at `learning-packs/<listing_ref>/` (P-016's
 * export shape) — repo-root manifests also resolve.
 */
function LearningPackContents({ repoSlug, listingRef }: { repoSlug: string; listingRef: string | null }) {
  const [items, setItems] = useState<Array<{ name: string; text: string }> | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || items !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const dir = listingRef ? `learning-packs/${listingRef}` : '';
        const listRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/contents/${dir}`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!listRes.ok) throw new Error(`GitHub contents → ${listRes.status}`);
        const files = (await listRes.json()) as Array<{ name: string; download_url: string | null; type: string }>;
        const mds = files.filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.download_url).slice(0, 50);
        const fetched = await Promise.all(
          mds.map(async (f) => {
            const r = await fetch(f.download_url as string);
            return { name: f.name.replace(/\.md$/, ''), text: r.ok ? await r.text() : '(unreadable)' };
          }),
        );
        if (!cancelled) setItems(fetched);
      } catch (e) {
        if (!cancelled) setContentsError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, items, repoSlug, listingRef]);

  return (
    <div style={{ marginTop: SIZES.md, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.lg, padding: SIZES.md }} data-testid="learning-pack-contents">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.text, fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, padding: 0 }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Browse the learnings before installing
      </button>
      <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
        These texts are injected into your agents&rsquo; recall once installed into a hive — read them first.
        Installing also runs a per-item conflict review against the hive&rsquo;s existing learnings.
      </p>
      {open && (
        <div style={{ marginTop: 10 }}>
          {contentsError ? (
            <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
              Couldn&rsquo;t fetch the pack contents ({contentsError}) —{' '}
              <a
                href={`https://github.com/${repoSlug}${listingRef ? `/tree/HEAD/learning-packs/${listingRef}` : ''}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent-soft)' }}
              >
                browse it on GitHub
              </a>
              .
            </p>
          ) : items === null ? (
            <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>Loading…</p>
          ) : (
            items
              .filter((f) => f.name !== 'README')
              .map((f) => (
                <details key={f.name} style={{ marginBottom: 6 }}>
                  <summary style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text, cursor: 'pointer' }}>{f.name}</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: FONTS.mono, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0 14px' }}>{f.text}</pre>
                </details>
              ))
          )}
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const valueStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
};

const backBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  background: 'none', border: 'none', cursor: 'pointer',
  color: COLORS.textMuted, fontFamily: FONTS.ui, fontSize: SIZES.sm, padding: 0,
};
