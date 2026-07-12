/**
 * Coarse write-origin of a memory row, derived from the stamps that already
 * exist (EI-10363):
 *  - settings-page writes stamp `source: 'settings-page'` (routes/user/memory.ts
 *    stamps it on both the create and the patch-journal path) — authorship
 *    outranks the `recovered_from` delivery detail when both are present;
 *  - the write-ahead journal drain / transcript miner stamp `recovered_from`;
 *  - the dominant agent path (memory:remember) stamps neither — so an absent
 *    stamp is an INFERRED agent write, not a proven one (real per-session
 *    attribution is EI-10358, blocked on ToolContext plumbing).
 */
export type MemoryOrigin = 'you' | 'recovered' | 'agent';

export function originOf(row: { metadata?: Record<string, unknown> }): MemoryOrigin {
  const meta = row.metadata ?? {};
  if (meta.source === 'settings-page') return 'you';
  if (typeof meta.recovered_from === 'string') return 'recovered';
  return 'agent';
}
