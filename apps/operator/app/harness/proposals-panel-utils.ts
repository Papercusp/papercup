/**
 * Pure helper functions for ProposalsPanel — extracted for testability (P-029).
 */

/** Row emitted by sync-query `plansDrafts.bySlug` (P-022). */
export interface DraftPlanRow {
  slug: string;
  title: string;
  status: 'draft';
  nowState: string | null;
  nowNext: string | null;
  itemCount: number;
  source: 'user' | 'scoper';
  created: string | null;
  updated: string | null;
}

/** Legacy row from harness_proposals_shared — kept during Phase E transition. */
export type LegacyProposalRow = {
  proposalId: string;
  status: string;
  ts: number | string;
  payload?: { body?: string; [k: string]: unknown };
};

/** Unified card shown in the list. */
export interface ProposalCard {
  kind: 'draft-plan' | 'legacy';
  id: string;
  title: string;
  summary: string | null;
  source: 'user' | 'scoper' | null;
  itemCount: number | null;
  updatedAt: string | null;
}

export function draftPlanToCard(r: DraftPlanRow): ProposalCard {
  return {
    kind: 'draft-plan',
    id: r.slug,
    title: r.title,
    summary: r.nowState ?? null,
    source: r.source,
    itemCount: r.itemCount,
    updatedAt: r.updated ?? r.created,
  };
}

export function titleFromBody(body: string, fallback: string): string {
  const line = body.split('\n').find((l) => /^#{1,3}\s+\S/.test(l.trim()));
  if (line) return line.replace(/^#{1,3}\s+/, '').trim();
  return fallback;
}

export function legacyRowToCard(r: LegacyProposalRow): ProposalCard {
  const body = typeof r.payload?.body === 'string' ? r.payload.body : '';
  const title = body ? titleFromBody(body, r.proposalId) : r.proposalId;
  return {
    kind: 'legacy',
    id: r.proposalId,
    title,
    summary: null,
    source: null,
    itemCount: null,
    updatedAt: null,
  };
}

export function fmtAge(isoOrNull: string | null): string {
  if (!isoOrNull) return '';
  const ts = new Date(isoOrNull).getTime();
  if (isNaN(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Merge draft plan cards + legacy proposal cards.
 * Draft cards take priority; legacy rows whose id matches a draft slug are filtered out.
 */
export function mergeProposalCards(
  draftRows: DraftPlanRow[],
  legacyRows: LegacyProposalRow[],
): ProposalCard[] {
  const draftCards = draftRows.map(draftPlanToCard);
  const draftSlugs = new Set(draftCards.map((c) => c.id));
  const legacyCards = legacyRows
    .filter((r) => r.status === 'pending' && !draftSlugs.has(r.proposalId))
    .map(legacyRowToCard);
  return [...draftCards, ...legacyCards];
}

export function filterCards(cards: ProposalCard[], query: string): ProposalCard[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter(
    (c) =>
      c.title.toLowerCase().includes(needle) ||
      (c.summary ?? '').toLowerCase().includes(needle) ||
      c.id.toLowerCase().includes(needle),
  );
}
