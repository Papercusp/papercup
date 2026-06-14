/**
 * slot-selector.ts — pure parsing of slot-addressing selectors for park-for-slot
 * (B2 — directed-wake-honesty-and-spawn-handoff-2026-06-14, P-025; D-005).
 *
 * Mirrors the @plan/@topic/@object/@file audience selectors (./audience.ts) but
 * for SLOTS that may have no agent yet — addressed in coord:send's `to[]` as:
 *
 *   @role:<role>      — the next agent spawned in that role
 *   @wave:<waveId>    — the next agent dispatched into that wave-lane
 *   @feature:<F-NNN>  — whoever next works that feature
 *
 * A `to[]` carrying these is PARKED (./slot-parked-store) instead of delivered to
 * live ownerIds; deliver-on-spawn (P-023) drains them into the spawnee's handoff.
 * Pure + dependency-free so it unit-tests without PG — the same core/host split as
 * audience.ts / audience-host.ts.
 */

export type SlotKind = 'role' | 'wave' | 'feature';

export interface SlotSelector {
  kind: SlotKind;
  ref: string;
}

const SLOT_PREFIX: Record<SlotKind, string> = {
  role: '@role:',
  wave: '@wave:',
  feature: '@feature:',
};

/**
 * Parse one `to[]` entry into a SlotSelector, or null if it isn't one (a plain
 * ownerId, `*`, `human`, or an audience selector like `@plan:`/`@topic:`). A
 * recognised prefix with an empty ref (`@role:` / `@wave:   `) is NOT a slot —
 * returns null, so we never park to an empty-ref slot.
 */
export function parseSlotSelector(entry: string): SlotSelector | null {
  for (const kind of Object.keys(SLOT_PREFIX) as SlotKind[]) {
    const prefix = SLOT_PREFIX[kind];
    if (entry.startsWith(prefix)) {
      const ref = entry.slice(prefix.length).trim();
      return ref ? { kind, ref } : null;
    }
  }
  return null;
}

/** Every distinct slot selector in a `to[]` (deduped by `kind:ref`, order kept). */
export function slotSelectorsIn(to: readonly string[]): SlotSelector[] {
  const seen = new Set<string>();
  const out: SlotSelector[] = [];
  for (const entry of to) {
    const slot = parseSlotSelector(entry);
    if (!slot) continue;
    const key = `${slot.kind}:${slot.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out;
}

/** True if any `to[]` entry is a slot selector (so the send path must park). */
export function hasSlotSelector(to: readonly string[]): boolean {
  return to.some((t) => parseSlotSelector(t) !== null);
}
