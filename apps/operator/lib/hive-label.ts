/**
 * hiveHomeLabel — strip the `-hive` home suffix for DISPLAY
 * (workspace-hive-ui-2026-06-17).
 *
 * A hive HOME's slug is canonically `<base>-hive`: repo-less coordinator
 * plumbing that owns the Queen + the federation identity. Its MEMBERS (the
 * repos) never carry the suffix. The `-hive` machinery is a backend concept —
 * the user should see the friendly `<base>` everywhere in the UI.
 *
 * This strips ONLY a trailing `-hive` (members never end in it, so a member
 * slug passes through untouched). The raw slug stays the id/value for every
 * backend call — ONLY the rendered label is stripped.
 */
export function hiveHomeLabel(slug: string | null | undefined): string {
  if (!slug) return '';
  return slug.replace(/-hive$/, '');
}
