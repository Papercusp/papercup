'use client';

import './h-proposals.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryState, parseAsStringEnum, parseAsBoolean, parseAsString } from 'nuqs';
import { MarkdownPreview } from '../_components/MarkdownEditor';
import * as Tabs from '@radix-ui/react-tabs';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { useSyncQuery } from '@restart/sync';
import { Group as PanelGroup, Panel as RPanel, Separator } from 'react-resizable-panels';
import { SingleSubpanelHeader } from './HarnessDashboard';
import { CollapsedInboxRail } from './CollapsedRails';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { Select } from './Select';
import { Checkbox } from './Checkbox';
import { useConfirmDialog } from './useConfirmDialog';

interface Proposal {
  id: string;
  title?: string;
  summary?: string;
  proposalCount?: number;
  sizeBytes: number;
  ts: number;
  status: 'pending' | 'applied' | 'rejected';
  reviewVerdict?: 'accept' | 'reject' | 'defer' | null;
  reviewedAt?: number | null;
  reviewSummary?: string | null;
}

// Row shape from harness_shared.harness_proposals_shared (Phase 2.5).
type SharedProposalRow = {
  proposalId: string;
  status: string;
  reviewVerdict?: string | null;
  reviewSummary?: string | null;
  reviewedAt?: number | string | null;
  appliedAt?: number | string | null;
  rejectedAt?: number | string | null;
  sizeBytes?: number | string | null;
  ts: number | string;
  /** jsonb mirror of the source proposal file. Includes a `body` field
   *  with the markdown content; consumed eagerly by the body viewer. */
  payload?: { body?: string; [k: string]: unknown };
};
function rowToProposal(r: SharedProposalRow): Proposal {
  const body = typeof r.payload?.body === 'string' ? r.payload.body : '';
  return {
    id: r.proposalId,
    sizeBytes: Number(r.sizeBytes ?? 0) || 0,
    ts: Number(r.ts) || 0,
    status: (r.status as Proposal['status']) ?? 'pending',
    reviewVerdict: (r.reviewVerdict ?? null) as Proposal['reviewVerdict'],
    reviewedAt: r.reviewedAt == null ? null : Number(r.reviewedAt),
    reviewSummary: r.reviewSummary ?? null,
    title: body ? titleFromContent(body, r.proposalId) : undefined,
    summary: body ? summaryFromContent(body, r.proposalId) : undefined,
    proposalCount: body ? countSubproposals(body) : undefined,
  };
}

interface Props {
  slug: string;
  /** Optional left sidebar (rendered by HarnessDashboard with ArchitectInbox). */
  architectInbox?: ReactNode;
}

type ProposalStatus = Proposal['status'];
type StatusFilter = 'all' | ProposalStatus;
type SortMode = 'newest' | 'oldest' | 'largest' | 'smallest';
const STATUS_ORDER: ProposalStatus[] = ['pending', 'applied', 'rejected'];

const STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: 'Pending',
  applied: 'Applied',
  rejected: 'Rejected',
};

const STATUS_COPY: Record<ProposalStatus, string> = {
  pending: 'Needs a product decision',
  applied: 'Appended to SPEC.md',
  rejected: 'Declined / archived',
};

const STATUS_HINT: Record<ProposalStatus, string> = {
  pending: 'needs review',
  applied: 'in SPEC.md',
  rejected: 'kept out',
};

const SORT_LABEL: Record<SortMode, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Most detail',
  smallest: 'Least detail',
};


function fmtTs(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAge(ts: number): string {
  if (!ts) return 'unknown age';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return fmtTs(ts);
}


function humanizeId(id: string): string {
  const cleaned = id
    .replace(/\.(md|txt|json)$/i, '')
    .replace(/^proposal[-_:\s]*/i, '')
    .replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_:\s]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  return cleaned || id;
}

const TIMESTAMPISH_TITLE_RE = /^(?:\d{4}[-_]\d{2}[-_]\d{2}(?:[tT\s_-]\d{2}[:_-]\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|[tT]\d{2}[:_-]\d{2}(?::\d{2})?Z?)$/i;
const SCAFFOLDING_HEADINGS = new Set([
  'context',
  'inputs',
  'review',
  'review notes',
  'risk',
  'risks',
  'tradeoffs',
  'trade-offs',
  'validation',
  'metrics',
  'rollout',
  'acceptance bar',
  'implied features',
]);

function normalizeProposalHeading(raw: string): string | null {
  const withoutHash = raw.replace(/^#{1,6}\s+/, '').trim().replace(/\s+/g, ' ');
  const stripped = withoutHash
    .replace(/^proposal\s*(?:\d+)?\s*[:—-]\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  const normalized = stripped || withoutHash;
  if (!normalized || /^<.*>$/.test(normalized)) return null;
  if (/^proposal(?:\s+\d+)?$/i.test(normalized)) return null;
  if (TIMESTAMPISH_TITLE_RE.test(normalized)) return null;
  if (SCAFFOLDING_HEADINGS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function titleFromContent(content: string, fallback: string): string {
  const headings = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line));

  for (const heading of headings) {
    if (!/^#{1,6}\s+proposal\b/i.test(heading)) continue;
    const title = normalizeProposalHeading(heading);
    if (title) return title;
  }

  for (const heading of headings) {
    const title = normalizeProposalHeading(heading);
    if (title) return title;
  }

  return humanizeId(fallback);
}

function countSubproposals(content: string): number | undefined {
  const count = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{2,6}\s+proposal\s+\d+\b/i.test(line)).length;
  return count > 0 ? count : undefined;
}

function decorateProposalTitle(title: string, proposalCount?: number): string {
  if (!proposalCount || proposalCount <= 1) return title;
  return `${title} + ${proposalCount - 1} more`;
}

function cleanProposalLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function summaryFromContent(content: string, fallback: string): string | undefined {
  const title = titleFromContent(content, fallback).toLowerCase();
  const lines = content.split('\n').map((line) => line.trim());
  const preferred = lines.find((line) => /^\s*[-*]\s+\*\*(?:user story|why|scope|goal)\*\*\s*:/i.test(line));
  const candidates = [
    preferred,
    ...lines.filter((line) => /^\s*[-*]\s+\S/.test(line)),
    ...lines.filter((line) => !/^#/.test(line) && /:\s+\S/.test(line)),
  ].filter(Boolean) as string[];

  for (const line of candidates) {
    const cleaned = cleanProposalLine(line)
      .replace(/^(?:user story|why|scope|goal|context)\s*:\s*/i, '')
      .trim();
    if (cleaned.length < 24) continue;
    if (cleaned.toLowerCase() === title) continue;
    return cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}…` : cleaned;
  }

  return undefined;
}

function reviewBadgeLabel(proposal: Proposal, compact = false): string | null {
  if (!proposal.reviewVerdict) return null;
  if (proposal.reviewVerdict === 'accept') {
    if (proposal.status === 'applied') return compact ? 'auto-accepted' : 'auto-accepted by reviewer';
    return compact ? 'review: accept' : 'reviewer says accept';
  }
  if (proposal.reviewVerdict === 'reject') return compact ? 'review: reject' : 'reviewer says reject';
  return compact ? 'review: defer' : 'reviewer says defer';
}

function reviewBadgeTitle(proposal: Proposal): string | undefined {
  if (!proposal.reviewVerdict) return undefined;
  const summary = proposal.reviewSummary?.trim();
  if (summary) return summary;
  if (proposal.reviewVerdict === 'accept' && proposal.status === 'applied') {
    return 'Reviewer accepted this proposal and it has already been applied to SPEC.md.';
  }
  if (proposal.reviewVerdict === 'accept') {
    return 'Reviewer recommends accepting this proposal. Use Apply to write it to SPEC.md.';
  }
  if (proposal.reviewVerdict === 'reject') return 'Reviewer recommends rejecting this proposal.';
  return 'Reviewer recommends deferring this proposal.';
}

function compareProposal(a: Proposal, b: Proposal, sortMode: SortMode): number {
  if (sortMode === 'oldest') return a.ts - b.ts || a.id.localeCompare(b.id);
  if (sortMode === 'largest') return (b.sizeBytes || 0) - (a.sizeBytes || 0) || b.ts - a.ts;
  if (sortMode === 'smallest') return (a.sizeBytes || 0) - (b.sizeBytes || 0) || b.ts - a.ts;
  return b.ts - a.ts || a.id.localeCompare(b.id);
}


async function copyText(text: string): Promise<boolean> {
  try {
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    return true;
  } catch {
    return false;
  }
}

function shortlistKey(slug: string): string {
  return `harness.proposalShortlist.${slug}`;
}

function readShortlist(slug: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(shortlistKey(slug));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeShortlist(slug: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(shortlistKey(slug), JSON.stringify([...ids]));
  } catch {}
}

function ProposalsPanelInner({ slug, architectInbox }: Props) {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [inboxCollapsed, setInboxCollapsed] = useQueryState(
    'inboxCollapsed',
    parseAsBoolean.withDefault(true),
  );
  const [items, setItems] = useState<Proposal[]>([]);
  // Selected proposal — URL-backed for deep-links + agent visibility.
  const [selected, setSelected] = useQueryState('proposal', parseAsString);
  const [content, setContent] = useState<string>('');
  const [goal, setGoal] = useState<string>('');
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  // Top-level toggle inside the proposals panel: list of proposals
  // vs. read-only preview of SPEC.md. Read-only by design — we want
  // the user to flow through the proposal pipeline (propose → review
  // → accept → replan) rather than freehand-editing SPEC.md. They
  // can still edit it directly via Config → Harness → SPEC.md if they
  // really want.
  const [view, setView] = useQueryState(
    'pview',
    parseAsStringEnum<'proposals' | 'spec'>(['proposals', 'spec']).withDefault('proposals'),
  );
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pendingReplanPrompt, setPendingReplanPrompt] = useState<number>(0);
  const [replanOnAccept, setReplanOnAccept] = useState<boolean>(true);
  const [query, setQuery] = useQueryState('proposalQuery', parseAsString.withDefault(''));
  const [statusFilter, setStatusFilter] = useQueryState(
    'proposalStatus',
    parseAsStringEnum<StatusFilter>(['all', 'pending', 'applied', 'rejected']).withDefault('all'),
  );
  const [sortMode, setSortMode] = useQueryState(
    'proposalSort',
    parseAsStringEnum<SortMode>(['newest', 'oldest', 'largest', 'smallest']).withDefault('newest'),
  );
  const [shortlisted, setShortlisted] = useState<Set<string>>(() => readShortlist(slug));
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Phase 2.5: ProposalsPanel reads harness_shared.harness_proposals_shared
  // directly. Source-of-truth: .harness/proposals/*.json — accept/reject
  // endpoints write status/applied_at/rejected_at into the JSON file, the
  // FS watcher (apps/operator/lib/harness-fs-watcher.ts) mirrors here.
  // Single PG writer = no race; per-schema harness_<slug>.harness_proposals
  // is no longer the source for the panel.
  const workspaceId = useWorkspaceId();
  const { data: zeroRows, loading } = useSyncQuery<SharedProposalRow>({
    queryName: 'proposalsShared.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });

  // Trigger periodic dual-write by hitting the list endpoint — needed so
  // newly-created proposals on disk get mirrored into PG. The actual
  // data display reads from Zero, so this is just a sync ping that also
  // refreshes the replanOnAccept flag.
  const triggerSync = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/proposals`).then((r) => r.json());
      setReplanOnAccept(d.replanOnAccept !== false);
    } catch (e) {
      setToast(`load: ${e}`);
    }
  }, [slug]);

  // Eager via Zero — harnessProjectFiles.byHarness mirrors PG's
  // harness_project_files row that holds SPEC.md content. Replaces the
  // lazy /spec round-trip on panel mount; goal/goalDraft hydrate
  // same-frame and update across tabs when SPEC.md is edited elsewhere.
  // loadGoal kept as a back-stop for harnesses that pre-date the mirror.
  const { data: goalSpecRows } = useSyncQuery<{
    harnessSlug: string;
    spec?: string | null;
  }>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  useEffect(() => {
    if (!Array.isArray(goalSpecRows) || goalSpecRows.length === 0) return;
    const spec = goalSpecRows[0]?.spec ?? '';
    setGoal(spec);
    setGoalDraft((prev) => (prev ? prev : spec));
  }, [goalSpecRows]);
  const loadGoal = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/spec`).then((r) => r.json());
      setGoal(d.spec ?? '');
      setGoalDraft(d.spec ?? '');
    } catch {}
  }, [slug]);

  useEffect(() => {
    if (loading || !Array.isArray(zeroRows)) return;
    const adapted = zeroRows.map(rowToProposal);
    setItems(adapted);
    setSelected((prev) => {
      if (prev && adapted.some((p) => p.id === prev)) return prev;
      return adapted[0]?.id ?? null;
    });
    setChecked((prev) => new Set([...prev].filter((id) => adapted.some((p) => p.id === id && p.status === 'pending'))));
    setShortlisted((prev) => new Set([...prev].filter((id) => adapted.some((p) => p.id === id))));
  }, [zeroRows, loading]);

  useEffect(() => {
    // One-shot triggerSync at mount: pulls replanOnAccept flag and any
    // PG-side state the panel depends on. The 10s periodic interval
    // is gone — Phase 2.5 ProposalsPanel reads harness_proposals_shared
    // directly, and the FS watcher mirrors live. No kick needed.
    triggerSync();
    loadGoal();
  }, [triggerSync, loadGoal]);

  useEffect(() => {
    setShortlisted(readShortlist(slug));
    setShortlistOnly(false);
  }, [slug]);

  useEffect(() => {
    writeShortlist(slug, shortlisted);
  }, [slug, shortlisted]);


  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
    // Eager read from the already-subscribed proposalsShared.byHarness
    // rows. Each row's payload.body holds the markdown content (avg
    // ~15KB, max ~26KB per row at current scale — well under the 100KB
    // threshold for eager subscription). Falls back to REST if the row
    // somehow lacks a body (older mirror state, manual edits, etc.).
    const row = (zeroRows ?? []).find((r) => r.proposalId === selected);
    const eagerBody = (row?.payload as { body?: string } | undefined)?.body;
    if (typeof eagerBody === 'string') {
      setContent(eagerBody);
      return;
    }
    let cancelled = false;
    setContent('');
    fetch(`/api/harness/${slug}/proposals/${selected}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setContent(d.content ?? ''); })
      .catch(() => { if (!cancelled) setContent(''); });

    return () => { cancelled = true; };
  }, [slug, selected, zeroRows]);

  const saveGoal = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/spec`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: goalDraft }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setGoal(goalDraft);
      setEditingGoal(false);
      setToast('SPEC.md saved');
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, goalDraft]);

  const accept = useCallback(async (id: string) => {
    const ok = await askConfirm({
      title: `Accept proposal ${id}?`,
      description: 'Its acceptance bullets will be appended to SPEC.md.',
      confirmLabel: 'Accept',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/proposals/${id}/accept`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `${r.status}`);
      setToast(`accepted: +${d.bulletsAdded} bullet(s) appended to SPEC.md`);
      setPendingReplanPrompt((prev) => prev + (d.bulletsAdded ?? 0));
      await triggerSync();
      if (selected === id) {
        fetch(`/api/harness/${slug}/proposals/${id}`).then((r) => r.json()).then((d) => setContent(d.content ?? '')).catch(() => {});
      }
    } catch (e) {
      setToast(`accept failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, triggerSync, selected, askConfirm]);

  const reject = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/proposals/${id}/reject`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      setToast('rejected');
      await triggerSync();
      if (selected === id) {
        fetch(`/api/harness/${slug}/proposals/${id}`).then((r) => r.json()).then((d) => setContent(d.content ?? '')).catch(() => {});
      }
    } catch (e) {
      setToast(`reject failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, triggerSync, selected]);

  const counts = useMemo(() => {
    const next = { all: items.length, pending: 0, applied: 0, rejected: 0, bytes: 0 };
    for (const item of items) {
      next[item.status] += 1;
      next.bytes += item.sizeBytes || 0;
    }
    return next;
  }, [items]);



  const emptyStateCopy = useMemo(() => {
    if (shortlistOnly) {
      return {
        title: 'No starred matches',
        body: 'Your starred proposals do not match the current filters. Reset filters or show all proposals.',
      };
    }
    if (statusFilter === 'pending') {
      return {
        title: 'No pending decisions',
        body: 'Everything in this view is already in SPEC.md or archived.',
      };
    }
    if (statusFilter === 'applied') {
      return {
        title: 'No applied proposals',
        body: 'Nothing in this view has been written into SPEC.md yet.',
      };
    }
    if (statusFilter === 'rejected') {
      return {
        title: 'No rejected proposals',
        body: 'Decision radar clear — nothing in this workspace has been rejected yet.',
      };
    }
    return {
      title: 'No matches',
      body: 'Try another search term or reset filters.',
    };
  }, [shortlistOnly, statusFilter]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => {
        if (shortlistOnly && !shortlisted.has(item.id)) return false;
        if (statusFilter !== 'all' && item.status !== statusFilter) return false;
        if (!needle) return true;
        return item.id.toLowerCase().includes(needle) || (item.title ?? '').toLowerCase().includes(needle) || (item.summary ?? '').toLowerCase().includes(needle) || humanizeId(item.id).toLowerCase().includes(needle) || item.status.includes(needle);
      })
      .sort((a, b) => compareProposal(a, b, sortMode));
  }, [items, query, shortlisted, shortlistOnly, sortMode, statusFilter]);

  const selectedItem = useMemo(() => items.find((p) => p.id === selected) ?? null, [items, selected]);
  const pendingIds = useMemo(() => items.filter((p) => p.status === 'pending').map((p) => p.id), [items]);
  const visiblePendingIds = useMemo(() => filteredItems.filter((p) => p.status === 'pending').map((p) => p.id), [filteredItems]);
  const checkedPending = useMemo(() => pendingIds.filter((id) => checked.has(id)), [pendingIds, checked]);
  const checkedVisiblePending = useMemo(() => visiblePendingIds.filter((id) => checked.has(id)), [visiblePendingIds, checked]);
  const nextPending = useMemo(() => items
    .filter((p) => p.status === 'pending')
    .sort((a, b) => compareProposal(a, b, sortMode))[0] ?? null, [items, sortMode]);

  // ── RichGrid columns for the proposals list ─────────────────────────
  // Uses the existing inline JSX as the cell content, preserving all
  // CSS classes (h-proposal-pin, h-proposal-row-button, badges) so the
  // existing styling and tooltip behaviour keep working.
  const toggleCheck = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleShortlist = useCallback((id: string) => {
    setShortlisted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const proposalColumns: ColumnDef<Proposal>[] = useMemo(
    () => [
      {
        key: 'check',
        header: '',
        width: 0.18,
        align: 'center',
        render: ({ row }) => {
          const isPending = row.status === 'pending';
          const isChecked = checked.has(row.id);
          if (!isPending) return <span className="h-proposal-item-spacer" aria-hidden="true" />;
          return (
            <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
              <Checkbox
                checked={isChecked}
                onChange={() => toggleCheck(row.id)}
                ariaLabel={`Select proposal ${row.id}`}
                className="h-proposal-check"
              />
            </span>
          );
        },
      },
      {
        key: 'pin',
        header: '',
        width: 0.18,
        align: 'center',
        render: ({ row }) => {
          const isShort = shortlisted.has(row.id);
          return (
            <button
              type="button"
              className={`h-proposal-pin ${isShort ? 'on' : ''}`}
              aria-label={`${isShort ? 'Remove from' : 'Add to'} proposal shortlist`}
              aria-pressed={isShort}
              onClick={(e) => { e.stopPropagation(); toggleShortlist(row.id); }}
            >
              {isShort ? '★' : '☆'}
            </button>
          );
        },
      },
      {
        key: 'main',
        header: 'proposal',
        width: 5,
        render: ({ row }) => {
          const rowTitle = decorateProposalTitle(row.title ?? humanizeId(row.id), row.proposalCount);
          const rowReviewLabel = reviewBadgeLabel(row, true);
          const rowReviewTitle = reviewBadgeTitle(row);
          const rowMeta = `${STATUS_LABEL[row.status]} · ${fmtTs(row.ts)} · ${STATUS_COPY[row.status]}`;
          const isoTs = row.ts ? new Date(row.ts).toISOString() : undefined;
          return (
            <button
              type="button"
              onClick={() => setSelected(row.id)}
              className="h-proposal-row-button"
              title={row.summary ? `${rowTitle} — ${row.summary} · ${rowMeta}` : rowMeta}
              aria-label={`${rowTitle}${row.summary ? ` — ${row.summary}` : ''} — ${rowMeta}`}
            >
              <span className="h-proposal-row-text">
                <span className="h-proposal-row-title">{rowTitle}</span>
                {row.summary && <span className="h-proposal-row-subtitle">{row.summary}</span>}
              </span>
              <span className={`h-proposal-badge status-${row.status}`}>{STATUS_LABEL[row.status]}</span>
              {rowReviewLabel && (
                <span
                  className={`h-proposal-badge review-${row.reviewVerdict}`}
                  title={rowReviewTitle}
                >
                  {rowReviewLabel}
                </span>
              )}
              <time className="h-proposal-row-age" dateTime={isoTs}>{fmtAge(row.ts)}</time>
            </button>
          );
        },
      },
    ],
    [checked, shortlisted, toggleCheck, toggleShortlist, setSelected],
  );

  const contentStats = useMemo(() => {
    const lines = content.split('\n');
    const outline = lines
      .map((line) => line.trim())
      .filter((line) => /^#{2,3}\s+\S/.test(line))
      .map((line) => line.replace(/^#{2,3}\s+/, '').trim())
      .map((line) => normalizeProposalHeading(line))
      .filter((heading): heading is string => Boolean(heading))
      .slice(0, 6);
    return {
      outline,
      title: selectedItem ? decorateProposalTitle(titleFromContent(content, selectedItem.title ?? selectedItem.id), selectedItem.proposalCount) : 'Select a proposal',
    };
  }, [content, selectedItem]);

  const bulkAccept = useCallback(async () => {
    if (checkedPending.length === 0) return;
    const ok = await askConfirm({
      title: `Accept ${checkedPending.length} proposal(s)?`,
      description: "Each one's acceptance bullets will be appended to SPEC.md in order.",
      confirmLabel: 'Accept all',
    });
    if (!ok) return;
    setBusy(true);
    let totalBullets = 0;
    let errors = 0;
    try {
      for (const id of checkedPending) {
        try {
          const r = await fetch(`/api/harness/${slug}/proposals/${id}/accept`, { method: 'POST' });
          const d = await r.json();
          if (r.ok) totalBullets += d.bulletsAdded ?? 0;
          else errors += 1;
        } catch {
          errors += 1;
        }
      }
      setChecked(new Set());
      setPendingReplanPrompt((prev) => prev + totalBullets);
      setToast(`bulk accept: +${totalBullets} bullets${errors ? `, ${errors} errors` : ''}`);
      await triggerSync();
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, checkedPending, triggerSync, askConfirm]);

  const bulkReject = useCallback(async () => {
    if (checkedPending.length === 0) return;
    const ok = await askConfirm({
      title: `Reject ${checkedPending.length} proposal(s)?`,
      confirmLabel: 'Reject all',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      for (const id of checkedPending) {
        try { await fetch(`/api/harness/${slug}/proposals/${id}/reject`, { method: 'POST' }); } catch {}
      }
      setChecked(new Set());
      setToast(`rejected ${checkedPending.length} proposal(s)`);
      await triggerSync();
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, checkedPending, triggerSync, askConfirm]);

  const replanNow = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Run /replan now?',
      body: 'Existing features (harness_features) + validation-contract.md are backed up and replaced.',
      confirmLabel: 'Replan',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setToast('Re-planning… (may take a few minutes)');
    try {
      const r = await fetch(`/api/harness/${slug}/replan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overwrite: true }),
      });
      const d = await r.json();
      if (d.ok && d.produced) {
        setToast(`re-planned — backup at ${d.backupDir}`);
        setPendingReplanPrompt(0);
      } else {
        setToast(`replan: ${d.error ?? 'did not produce artifacts'}`);
      }
    } catch (e) {
      setToast(`replan failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  }, [slug, askConfirm]);

  const toggleVisiblePending = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      const allVisibleChecked = visiblePendingIds.length > 0 && visiblePendingIds.every((id) => next.has(id));
      for (const id of visiblePendingIds) {
        if (allVisibleChecked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const selectRelative = useCallback((direction: number) => {
    if (filteredItems.length === 0) return;
    const currentIndex = selected ? filteredItems.findIndex((p) => p.id === selected) : -1;
    const fallbackIndex = direction > 0 ? 0 : filteredItems.length - 1;
    const nextIndex = currentIndex < 0
      ? fallbackIndex
      : (currentIndex + direction + filteredItems.length) % filteredItems.length;
    setSelected(filteredItems[nextIndex]?.id ?? null);
  }, [filteredItems, selected]);


  const focusNextPending = useCallback(() => {
    if (!nextPending) return;
    setQuery('');
    setStatusFilter('pending');
    setShortlistOnly(false);
    setSelected(nextPending.id);
  }, [nextPending]);

  const resetView = useCallback(() => {
    setQuery('');
    setStatusFilter('all');
    setSortMode('newest');
    setShortlistOnly(false);
  }, []);

  const copyProposal = useCallback(async () => {
    if (!content.trim()) return;
    const ok = await copyText(content);
    setToast(ok ? 'proposal markdown copied' : 'copy failed');
    setTimeout(() => setToast(null), 2200);
  }, [content]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTextTarget = target && (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable);
      if (isTextTarget) {
        if (event.key === 'Escape') target.blur();
        return;
      }
      if (document.querySelector('[data-harness-modal="true"]')) return;

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        selectRelative(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        selectRelative(-1);
      } else if (event.key === 'n') {
        event.preventDefault();
        focusNextPending();
      } else if (event.key === 's' && selectedItem) {
        event.preventDefault();
        toggleShortlist(selectedItem.id);
      } else if (event.key === 'x' && selectedItem?.status === 'pending') {
        event.preventDefault();
        toggleCheck(selectedItem.id);
      } else if (event.key === 'c' && content.trim()) {
        event.preventDefault();
        copyProposal();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, copyProposal, focusNextPending, selectRelative, selectedItem, toggleCheck, toggleShortlist]);

  const statusCount = (status: StatusFilter) => (status === 'all' ? counts.all : counts[status]);
  const toastKind = toast && /failed|error|reject/i.test(toast) ? 'bad' : 'good';
  const hasGoal = goal.trim().length > 0;

  const panelBody = (
    <div className="h-proposals-panel" data-proposals-panel>
      <Tabs.Root value={view} onValueChange={(v) => setView(v as 'proposals' | 'spec')} asChild>
        <Tabs.List
          className="h-proposals-view-tabs"
          aria-label="Proposals view"
        >
          {(['proposals', 'spec'] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="h-proposals-view-tab"
            >
              {value === 'proposals' ? 'Proposals' : 'SPEC.md preview'}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      {toast && (
        <div className={`h-proposal-toast ${toastKind}`}>
          <span>{toastKind === 'bad' ? '!' : '✓'}</span>
          {toast}
        </div>
      )}

      {pendingReplanPrompt > 0 && !replanOnAccept && (
        <div className="h-proposal-replan">
          <span><b>{pendingReplanPrompt}</b> new acceptance bullet(s) appended to SPEC.md. Run <code>/replan</code> to regenerate features + contract.</span>
          <button type="button" onClick={replanNow} disabled={busy} className="h-proposal-btn primary">{busy ? '…' : 'replan now'}</button>
          <button type="button" onClick={() => setPendingReplanPrompt(0)} className="h-proposal-btn ghost">dismiss</button>
        </div>
      )}

      {view === 'spec' && (
        <div
          className="h-proposals-spec-preview"
          aria-label="SPEC.md preview (read only)"
          style={{
            margin: '12px 0',
            padding: '14px 18px',
            border: '1px solid var(--border, #2a3142)',
            borderRadius: 10,
            background: 'color-mix(in oklab, var(--bg-2, #131722), white 3%)',
            maxHeight: 'calc(100vh - 320px)',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              fontSize: 11,
              color: 'var(--fg-dim, #64748b)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 700,
            }}
          >
            <span>SPEC.md · read only</span>
            <span aria-hidden="true">·</span>
            <span style={{ textTransform: 'none', letterSpacing: 'normal', opacity: 0.85 }}>
              To edit, open Config → Harness → SPEC.md.
            </span>
          </div>
          {hasGoal ? (
            <MarkdownPreview value={goal} />
          ) : (
            <p style={{ margin: 0, color: 'var(--fg-mute, #94a3b8)', fontSize: 13 }}>
              SPEC.md is empty. Set a north-star goal in Config → Harness → SPEC.md before proposing scope.
            </p>
          )}
        </div>
      )}

      {view === 'proposals' && (
      <div className="h-proposals-workbench">
        <aside className="h-proposals-sidebar" aria-label="Proposal list">
          <div className="h-proposal-toolbar">
            <div className="h-proposal-toolbar-main">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search proposals…"
                aria-label="Search proposals"
                className="h-proposal-search"
              />
              <label className="h-proposal-sort">
                <span>Sort</span>
                <Select
                  value={sortMode}
                  onChange={(v) => setSortMode(v as SortMode)}
                  ariaLabel="Sort proposals"
                  options={(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => ({ value: mode, label: SORT_LABEL[mode] }))}
                />
              </label>
            </div>
            <div className="h-proposal-toolbar-controls" aria-label="Proposal queue tools">
              <Tabs.Root value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)} asChild>
                <Tabs.List className="h-proposal-filter-row" aria-label="Filter proposals by status">
                  {(['all', ...STATUS_ORDER] as StatusFilter[]).map((status) => (
                    <Tabs.Trigger
                      key={status}
                      value={status}
                      className={`h-proposal-filter ${status !== 'all' ? `status-${status}` : ''}`}
                      aria-label={status === 'all'
                        ? `All proposals, ${statusCount(status)} total`
                        : `${STATUS_LABEL[status]} proposals: ${STATUS_HINT[status]}, ${statusCount(status)} total`}
                    >
                      <span>{status === 'all' ? 'All' : STATUS_LABEL[status]}</span>
                      <b>{statusCount(status)}</b>
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
              {shortlisted.size > 0 && (
                <button
                  type="button"
                  onClick={() => setShortlistOnly((on) => !on)}
                  className={`h-proposal-mini ghost ${shortlistOnly ? 'on' : ''}`}
                >
                  {shortlistOnly ? 'show all' : `show starred · ${shortlisted.size}`}
                </button>
              )}
              {(query || statusFilter !== 'all' || sortMode !== 'newest' || shortlistOnly) && (
                <button type="button" onClick={resetView} className="h-proposal-mini ghost">reset filters</button>
              )}
              <div className="h-proposal-hotkeys" aria-label="Proposal keyboard shortcuts">
                <kbd>/</kbd><span>search</span>
                <kbd>j/k</kbd><span>move</span>
                <kbd>n</kbd><span>pending</span>
                <kbd>s</kbd><span>star</span>
                <kbd>x</kbd><span>select</span>
                <kbd>c</kbd><span>copy</span>
              </div>
            </div>
          </div>

          {visiblePendingIds.length > 0 && (
            <label className="h-proposal-select-all">
              <Checkbox
                checked={checkedVisiblePending.length === visiblePendingIds.length && visiblePendingIds.length > 0}
                indeterminate={checkedVisiblePending.length > 0 && checkedVisiblePending.length < visiblePendingIds.length}
                onChange={() => toggleVisiblePending()}
                ariaLabel="Select all visible pending proposals"
              />
              <span>{checkedVisiblePending.length > 0 ? `${checkedVisiblePending.length} selected for bulk review` : `Select ${visiblePendingIds.length} pending for bulk review`}</span>
            </label>
          )}

          {checkedPending.length > 0 && (
            <div className="h-proposal-bulkbar">
              <span><b>{checkedPending.length}</b> pending selected</span>
              <button type="button" onClick={bulkAccept} disabled={busy} className="h-proposal-mini good">apply selected</button>
              <button type="button" onClick={bulkReject} disabled={busy} className="h-proposal-mini bad">reject selected</button>
              <button type="button" onClick={() => setChecked(new Set())} className="h-proposal-mini ghost">clear</button>
            </div>
          )}

          <div className="h-proposal-list" role="list">
            {items.length === 0 ? (
              <div className="h-proposal-empty">
                <b>No proposals yet</b>
                <span>Click <em>Propose</em> in the top toolbar to have the scoper agent (MODE=proposal) read SPEC.md and suggest scoped features.</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="h-proposal-empty">
                <b>{emptyStateCopy.title}</b>
                <span>{emptyStateCopy.body}</span>
                <button type="button" onClick={resetView} className="h-proposal-mini ghost">reset filters</button>
              </div>
            ) : (
              <RichGrid<Proposal>
                rows={filteredItems}
                columns={proposalColumns}
                getRowId={(p) => p.id}
                rowProps={(ctx) => {
                  const isActive = selected === ctx.row.id;
                  const isShort = shortlisted.has(ctx.row.id);
                  return {
                    className: `h-proposal-item status-${ctx.row.status}${isActive ? ' is-active' : ''}${isShort ? ' is-shortlisted' : ''}`,
                    role: 'listitem',
                    'aria-current': isActive ? 'true' : undefined,
                    // Override legacy .h-proposal-item `display:grid` — see
                    // IssuesList migration note for the same fix on .h-issue.
                    style: { display: 'block' } as const,
                  };
                }}
                inline
              />
            )}
          </div>
        </aside>

        <section className="h-proposal-detail" aria-label="Proposal detail">
          {selectedItem ? (
            <>
              <div className={`h-proposal-detail-head status-${selectedItem.status}`}>
                <div className="h-proposal-detail-title">
                  <span className={`h-proposal-badge status-${selectedItem.status}`}>{STATUS_LABEL[selectedItem.status]}</span>
                  {selectedItem.reviewVerdict && (
                    <span className={`h-proposal-badge review-${selectedItem.reviewVerdict}`} title={reviewBadgeTitle(selectedItem)}>
                      {reviewBadgeLabel(selectedItem)}
                    </span>
                  )}
                  <h3>{contentStats.title}</h3>
                  <p>source: {selectedItem.id}</p>
                  {selectedItem.reviewSummary && (
                    <p className="h-proposal-review-summary" title={selectedItem.reviewSummary}>
                      <em>reviewer:</em> {selectedItem.reviewSummary}
                    </p>
                  )}
                </div>
                <div className="h-proposal-detail-actions">
                  <button type="button" onClick={copyProposal} disabled={!content.trim()} className="h-proposal-btn ghost">copy markdown</button>
                  {selectedItem.status === 'pending' && (
                    <>
                      <button type="button" onClick={() => accept(selectedItem.id)} disabled={busy} className="h-proposal-btn good">apply to SPEC.md</button>
                      <button type="button" onClick={() => reject(selectedItem.id)} disabled={busy} className="h-proposal-btn danger">reject proposal</button>
                    </>
                  )}
                </div>
              </div>
              {contentStats.outline.length > 0 && (
                <div className="h-proposal-outline" aria-label="Proposal outline">
                  <span>Outline</span>
                  {contentStats.outline.map((heading, index) => <b key={`${heading}-${index}`}>{heading}</b>)}
                </div>
              )}
              <div className="h-proposal-doc-shell" style={{ overflow: 'auto' }}>
                {content ? (
                  <MarkdownPreview value={content} outline="left" />
                ) : (
                  <div className="h-proposal-loading">loading proposal…</div>
                )}
              </div>
            </>
          ) : (
            <div className="h-proposal-detail-empty">
              <b>Select a proposal</b>
              <span>The detail pane shows the proposal body, acceptance bullets, and decision actions.</span>
            </div>
          )}
        </section>
      </div>
      )}
    </div>
  );

  if (!architectInbox) return panelBody;
  return (
    <div
      className="h-proposals-with-inbox"
      style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0, flex: 1 }}
    >
      {confirmEl}
      <CollapsedInboxRail slug={slug} onExpand={() => setInboxCollapsed((c) => !c)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!inboxCollapsed ? (
          <PanelGroup orientation="horizontal">
            <RPanel
              defaultSize="26%"
              minSize="18%"
              maxSize="42%"
              collapsible
              collapsedSize={0}
            >
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
