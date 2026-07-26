/**
 * Shared `updated`-timestamp formatters — the coarse relative one
 * (`formatRelativeUpdated`) and the precise absolute one
 * (`formatAbsoluteUpdated`). They live together because callers routinely
 * want both of the same value, and a caller that finds one should find the
 * other. Pure; no I/O.
 *
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Absolute, to-the-minute rendering in the viewer's LOCAL timezone —
 * "26 Jul 2026, 14:03".
 *
 * Added for `hud-session-launcher-and-board-tabs-2026-07-26` P-007 (owner ask
 * 2026-07-26: "display the full time details not just 'today'").
 * `formatRelativeUpdated` deliberately collapses anything inside 24h to
 * "today", which is exactly the information loss the owner hit — a plan
 * touched a minute ago and one touched 23 hours ago read identically.
 *
 * Hand-composed rather than `toLocaleString` on purpose: locale-dependent
 * output would render differently per machine and make assertions on it
 * either non-deterministic or tautological. Same lenient contract as its
 * sibling — an unparseable value comes back verbatim rather than as
 * "Invalid Date".
 */
export function formatAbsoluteUpdated(updated: string | number | null | undefined): string {
  if (updated == null) return '';
  const t = typeof updated === 'number' ? updated : Date.parse(updated);
  if (!Number.isFinite(t)) return typeof updated === 'string' ? updated : '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
