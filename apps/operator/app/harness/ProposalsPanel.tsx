'use client';

import './h-proposals.css';
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import * as Dialog from '@radix-ui/react-dialog';
import { useSyncQuery } from '@restart/sync';
import { Group as PanelGroup, Panel as RPanel, Separator } from 'react-resizable-panels';
import { SingleSubpanelHeader } from './HarnessDashboard';
import { CollapsedInboxRail } from './CollapsedRails';
import ArchitectChat from './ArchitectChat';
import { useConfirmDialog } from './useConfirmDialog';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { fetchPlan, promoteToHarness, rejectDraftPlan } from '@/app/admin/plans/plans-api';
import {
  type DraftPlanRow,
  type LegacyProposalRow,
  type ProposalCard,
  draftPlanToCard,
  legacyRowToCard,
  fmtAge,
  mergeProposalCards,
  filterCards,
} from './proposals-panel-utils';

/* ── ArchitectChat "New proposal" modal ───────────────────────────── */

function NewProposalModal({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const threadId = useMemo(() => `new-proposal-${Date.now()}`, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.72)',
            zIndex: 60,
          }}
        />
        <Dialog.Content
          data-harness-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 61,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
            outline: 'none',
          }}
        >
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              width: 'min(740px, 100%)',
              height: 'min(580px, 90vh)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                flexShrink: 0,
              }}
            >
              <Dialog.Title
                style={{ flex: 1, margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}
              >
                New proposal — Architect will ask questions then draft a plan
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--fg-dim)',
                    fontSize: 16,
                    padding: '2px 6px',
                  }}
                >
                  ×
                </button>
              </Dialog.Close>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <ArchitectChat slug={slug} threadId={threadId} />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Card detail panel ────────────────────────────────────────────── */

function CardDetail({
  card,
  harnessSlug,
  onAccepted,
  onRejected,
}: {
  card: ProposalCard;
  harnessSlug: string;
  onAccepted: () => void;
  onRejected: () => void;
}) {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = useCallback(async () => {
    if (card.kind !== 'draft-plan') return;
    const ok = await askConfirm({
      title: `Promote "${card.title}" to features?`,
      body: `This creates ${card.itemCount ?? 'all'} feature(s) in the harness. Workers will pick up shortly.`,
      confirmLabel: 'Promote',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await fetchPlan(card.id);
      if ('error' in plan && plan.error) throw new Error(plan.error);
      const features = (plan.items ?? []).map((item) => ({
        title: item.text,
        from_items: [item.id],
      }));
      if (features.length === 0) throw new Error('Plan has no items to promote');
      const res = await promoteToHarness({
        slug: card.id,
        harness_slug: harnessSlug,
        features,
        apply: true,
      });
      if (!res.ok) throw new Error(res.error ?? 'promote failed');
      onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [card, harnessSlug, askConfirm, onAccepted]);

  const handleReject = useCallback(async () => {
    if (card.kind !== 'draft-plan') return;
    const ok = await askConfirm({
      title: `Reject "${card.title}"?`,
      body: 'The plan will be marked superseded and removed from this panel.',
      confirmLabel: 'Reject',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rejectDraftPlan(card.id);
      if (!res.ok) throw new Error(res.error ?? 'reject failed');
      onRejected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [card, askConfirm, onRejected]);

  return (
    <section className="h-proposal-detail" aria-label="Proposal detail">
      {confirmEl}
      <div className="h-proposal-detail-head">
        <div className="h-proposal-detail-title">
          {card.source && (
            <span className={`h-proposal-source-pill source-${card.source}`}>
              {card.source === 'scoper' ? 'scoper' : 'you'}
            </span>
          )}
          {card.kind === 'legacy' && (
            <span className="h-proposal-source-pill source-legacy">legacy</span>
          )}
          <h3>{card.title}</h3>
          {card.itemCount != null && (
            <p style={{ margin: '2px 0 0', color: 'var(--fg-dim)', fontSize: 12 }}>
              {card.itemCount} item{card.itemCount !== 1 ? 's' : ''}
            </p>
          )}
          {card.summary && (
            <p style={{ margin: '6px 0 0', color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5 }}>
              {card.summary}
            </p>
          )}
        </div>
        {card.kind === 'draft-plan' && (
          <div className="h-proposal-detail-actions">
            <a
              href={`/adv/plans?slug=${encodeURIComponent(card.id)}`}
              className="h-proposal-btn ghost"
              style={{ textDecoration: 'none' }}
            >
              edit plan
            </a>
            <button
              type="button"
              onClick={handleReject}
              disabled={busy}
              className="h-proposal-btn danger"
            >
              reject
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={busy}
              className="h-proposal-btn good"
            >
              {busy ? '…' : `accept → ${card.itemCount ?? '?'} feature${card.itemCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div
          style={{
            margin: '8px 0',
            padding: '8px 12px',
            background: 'color-mix(in oklab, var(--bg), red 8%)',
            border: '1px solid color-mix(in oklab, var(--border), red 20%)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--fg)',
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

/* ── Main panel ───────────────────────────────────────────────────── */

interface Props {
  slug: string;
  architectInbox?: ReactNode;
}

function ProposalsPanelInner({ slug, architectInbox }: Props) {
  const workspaceId = useWorkspaceId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useQueryState('proposal', parseAsString);
  const [query, setQuery] = useQueryState('proposalQuery', parseAsString.withDefault(''));
  const [newOpen, setNewOpen] = useState(false);
  const [inboxCollapsed, setInboxCollapsed] = useQueryState(
    'inboxCollapsed',
    parseAsBoolean.withDefault(true),
  );
  const [toast, setToast] = useState<{ msg: string; kind: 'good' | 'bad' } | null>(null);

  const showToast = useCallback((msg: string, kind: 'good' | 'bad' = 'good') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // Draft plans (new data source — P-022/P-023).
  const { data: draftRows, loading: draftLoading } = useSyncQuery<DraftPlanRow>({
    queryName: 'plansDrafts.bySlug',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });

  // Legacy proposals — kept during Phase E transition.
  const { data: legacyRows } = useSyncQuery<LegacyProposalRow>({
    queryName: 'proposalsShared.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });

  const cards = useMemo<ProposalCard[]>(
    () => mergeProposalCards(Array.isArray(draftRows) ? draftRows : [], Array.isArray(legacyRows) ? legacyRows : []),
    [draftRows, legacyRows],
  );

  const filtered = useMemo(() => filterCards(cards, query), [cards, query]);

  const selectedCard = useMemo(
    () => filtered.find((c) => c.id === selected) ?? filtered[0] ?? null,
    [filtered, selected],
  );

  const selectRelative = useCallback(
    (dir: 1 | -1) => {
      if (filtered.length === 0) return;
      const idx = selected ? filtered.findIndex((c) => c.id === selected) : -1;
      const next =
        idx < 0
          ? dir > 0
            ? 0
            : filtered.length - 1
          : (idx + dir + filtered.length) % filtered.length;
      setSelected(filtered[next]?.id ?? null);
    },
    [filtered, selected, setSelected],
  );

  // Keyboard nav.
  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        selectRelative(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectRelative(-1);
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    },
    [selectRelative],
  );

  const panelBody = (
    <div className="h-proposals-panel" data-proposals-panel onKeyDown={handleKey} tabIndex={-1}>
      {/* Header toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
        >
          Proposals
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="h-proposal-btn primary"
          onClick={() => setNewOpen(true)}
        >
          + New proposal
        </button>
      </div>

      {toast && (
        <div className={`h-proposal-toast ${toast.kind}`}>
          <span>{toast.kind === 'bad' ? '!' : '✓'}</span>
          {toast.msg}
        </div>
      )}

      <div className="h-proposals-workbench">
        {/* Left: list */}
        <aside className="h-proposals-sidebar" aria-label="Proposal list">
          <div className="h-proposal-toolbar">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search proposals…"
              aria-label="Search proposals"
              className="h-proposal-search"
            />
          </div>

          <div className="h-proposal-list" role="list">
            {draftLoading && cards.length === 0 ? (
              <div className="h-proposal-empty">
                <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>Loading…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="h-proposal-empty">
                <b>No proposals</b>
                <span>
                  {query
                    ? 'No matches — try a different search.'
                    : 'Click "+ New proposal" to draft one with the Architect.'}
                </span>
              </div>
            ) : (
              filtered.map((card) => {
                const isActive = (selected ?? filtered[0]?.id) === card.id;
                return (
                  <div
                    key={card.id}
                    role="listitem"
                    className={`h-proposal-item${isActive ? ' is-active' : ''}`}
                    style={{ display: 'block' }}
                  >
                    <button
                      type="button"
                      className="h-proposal-row-button"
                      onClick={() => setSelected(card.id)}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <span className="h-proposal-row-text">
                        <span className="h-proposal-row-title">{card.title}</span>
                        {card.summary && (
                          <span className="h-proposal-row-subtitle">{card.summary}</span>
                        )}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                        {/* P-024: source tag pill */}
                        {card.source && (
                          <span className={`h-proposal-source-pill source-${card.source}`}>
                            {card.source === 'scoper' ? 'scoper' : 'you'}
                          </span>
                        )}
                        {card.kind === 'legacy' && (
                          <span className="h-proposal-source-pill source-legacy">legacy</span>
                        )}
                        {card.itemCount != null && (
                          <span
                            style={{ fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}
                          >
                            {card.itemCount}
                          </span>
                        )}
                        {card.updatedAt && (
                          <time
                            className="h-proposal-row-age"
                            dateTime={card.updatedAt}
                          >
                            {fmtAge(card.updatedAt)}
                          </time>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right: detail */}
        {selectedCard ? (
          <CardDetail
            key={selectedCard.id}
            card={selectedCard}
            harnessSlug={slug}
            onAccepted={() => {
              showToast(
                `Promoted "${selectedCard.title}" to features. Worker will pick up shortly.`,
                'good',
              );
              setSelected(null);
            }}
            onRejected={() => {
              showToast(`Rejected "${selectedCard.title}"`, 'good');
              setSelected(null);
            }}
          />
        ) : (
          <section className="h-proposal-detail" aria-label="Proposal detail">
            <div className="h-proposal-detail-empty">
              <b>Select a proposal</b>
              <span>
                Draft plans appear here. Accept to promote all items to harness features, or Edit to
                refine the plan first.
              </span>
            </div>
          </section>
        )}
      </div>

      <NewProposalModal slug={slug} open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );

  if (!architectInbox) return panelBody;
  return (
    <div
      className="h-proposals-with-inbox"
      style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0, flex: 1 }}
    >
      <CollapsedInboxRail slug={slug} onExpand={() => setInboxCollapsed((c) => !c)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!inboxCollapsed ? (
          <PanelGroup orientation="horizontal">
            <RPanel defaultSize="26%" minSize="18%" maxSize="42%" collapsible collapsedSize={0}>
              <div
                className="h-dashboard-left-pane"
                style={{
                  height: '100%',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <SingleSubpanelHeader id="inbox" label="inbox" />
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {architectInbox}
                </div>
              </div>
            </RPanel>
            <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
            <RPanel defaultSize="74%">
              <div style={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {panelBody}
              </div>
            </RPanel>
          </PanelGroup>
        ) : (
          panelBody
        )}
      </div>
    </div>
  );
}

const ProposalsPanel = memo(ProposalsPanelInner);
export default ProposalsPanel;
