/**
 * queue-authorizer — the pure A1 grouping helpers behind the Queue's
 * authorizer-split view (queue-authorization-redesign-2026-06-14 P-004/P-005).
 *
 * Extracted from PlanOtherList.tsx so they're unit-testable without the
 * component's React/nuqs/radix import graph. No React here — just data shaping
 * over the AttentionItem wire type.
 */
import type { AttentionGroup, AttentionItem } from './plans-api';

/** Human reason for each whyGated value — the tail of the per-card why-line. */
export const WHYGATED_REASON: Record<string, string> = {
  protected: 'protected category — your call by right',
  'owner-only': 'your ratification',
  unarmed: 'the Queen isn’t armed yet',
  'above-ceiling': 'above the Queen’s autonomy ceiling',
};

/** The "why it's here" line: who must sign off + why. Null for non-decisions. */
export function whyLine(it: AttentionItem): string | null {
  if (!it.authorizer) return null;
  const who = it.authorizer === 'you' ? 'needs you' : 'the Queen could take this';
  const reason = it.whyGated ? WHYGATED_REASON[it.whyGated] : null;
  return reason ? `${who} · ${reason}` : who;
}

/** A rendered section of the Other list — either an authorizer bucket or, in the
 *  legacy view, one plan/harness AttentionGroup. */
export interface DisplaySection {
  key: string;
  title: string;
  /** Authorizer-bucket explainer (new view). */
  hint?: string;
  /** Source harness pill (legacy plan/harness grouping). */
  harnessSlug?: string | null;
  /** Render the "Let the Queen handle these →" link (queen-eligible bucket). */
  queenLink?: boolean;
  items: AttentionItem[];
}

const AUTH_BUCKETS: {
  key: string;
  match: 'you' | 'queen-eligible' | 'other';
  title: string;
  hint: string;
  queenLink?: boolean;
}[] = [
  {
    key: 'auth:you',
    match: 'you',
    title: 'Needs your call',
    hint: 'Only you can decide these — protected actions and your ratifications.',
  },
  {
    key: 'auth:queen',
    match: 'queen-eligible',
    title: 'Automatable — for now',
    hint: 'The Queen could handle these once her autonomy is widened.',
    queenLink: true,
  },
  {
    key: 'auth:other',
    match: 'other',
    title: 'Alerts & activity',
    hint: 'Signals and FYI — not a decision waiting on anyone.',
  },
];

/** Partition flat items into the three authorizer buckets, dropping empties. */
export function byAuthorizer(items: AttentionItem[]): DisplaySection[] {
  return AUTH_BUCKETS.map((b) => ({
    key: b.key,
    title: b.title,
    hint: b.hint,
    queenLink: b.queenLink,
    items: items.filter((i) => (b.match === 'other' ? !i.authorizer : i.authorizer === b.match)),
  })).filter((s) => s.items.length > 0);
}

/** Legacy: one section per plan/harness AttentionGroup. */
export function planSections(groups: AttentionGroup[]): DisplaySection[] {
  return groups.map((g) => ({ key: g.key, title: g.title, harnessSlug: g.harnessSlug, items: g.items }));
}
