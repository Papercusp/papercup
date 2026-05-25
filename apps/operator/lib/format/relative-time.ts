/**
 * Shared relative-time formatter used by PlanRail row cards, the
 * /adv/sessions "Start from plan context" picker, and any future
 * caller that wants "today / yesterday / Nd ago / YYYY-MM-DD"
 * formatting. Pure; no I/O.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-027 / D-011.
 *
 * Input is either an ISO date string (frontmatter `updated` field) or
 * an epoch-ms number. Returns the input string verbatim if it can't
 * be parsed, so a malformed value renders something instead of
 * "undefined".
 */
export function formatRelativeUpdated(updated: string | number | null | undefined): string {
  if (updated == null) return '';
  const t = typeof updated === 'number' ? updated : Date.parse(updated);
  if (!Number.isFinite(t)) return typeof updated === 'string' ? updated : '';
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (ageMs < 0) return 'in the future';
  if (ageMs < day) return 'today';
  if (ageMs < day * 2) return 'yesterday';
  if (ageMs < day * 30) return `${Math.floor(ageMs / day)}d ago`;
  if (typeof updated === 'string') return updated.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}
