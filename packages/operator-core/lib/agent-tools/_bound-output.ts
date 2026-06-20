/**
 * EI-1597 — shared bound for high-fanout agent-facing read tools.
 *
 * Several read tools return a row array whose total output scales with workspace
 * size and overflows the agent result cap (coord:inbox = EI-1752, plans:get =
 * WI-274, work_items:list, coord:feed). The common lever is: excerpt each row's
 * big text field(s), budget-aware, so the total text for that field stays bounded
 * at ANY row count while small results keep most rows full.
 *
 * Per-row cap = min(perItemCap, floor(totalBudget / n)). A cut row gains
 * `<field>_truncated: true` + `<field>_full_chars`. Non-breaking: the field stays a
 * string. Bound at the TOOL layer (not the data layer) so internal callers + the UI
 * keep full bodies — only the agent-facing projection is excerpted.
 */
export function boundRowField<T extends object>(
  rows: T[],
  field: string,
  perItemCap: number,
  totalBudget: number,
): T[] {
  const n = rows.length;
  if (n === 0) return rows;
  const cap = Math.max(0, Math.min(perItemCap, Math.floor(totalBudget / n)));
  return rows.map((r) => {
    const v = (r as Record<string, unknown>)[field];
    const full = typeof v === 'string' ? v : '';
    if (full.length <= cap) return r;
    return {
      ...r,
      [field]: full.slice(0, cap),
      [`${field}_truncated`]: true,
      [`${field}_full_chars`]: full.length,
    } as T;
  });
}
