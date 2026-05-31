/**
 * Palette-execution safety filter (P-011) — §3 of the plan.
 *
 * The review's load-bearing catch: "principal-allowed + simple-arg" is NOT
 * "safe to fire one keystroke away with only a toast." The server catalog
 * holds destructive (`backup:promote`, `processes:kill`, deletes), streaming,
 * and interactive (`ask_choice`) tools. This decides HOW — or whether — a
 * capability may run from the command palette.
 *
 * NOTE: this is the projection-time gate (so an ineligible tool never appears,
 * or appears confirm-gated). The dispatch stack re-checks authorization at
 * execution (defense in depth) — this filter is about palette *safety*, not
 * authority.
 */
import type { Capability } from './types';

export type PaletteEligibility =
  | 'fire-and-toast' // run immediately, surface the result in a toast
  | 'confirm' // show, but require an explicit confirm step before running
  | 'exclude'; // never offered in the palette (Phase 1)

export function paletteEligibility(cap: Capability): PaletteEligibility {
  // Browser-reflexive commands run their own in-tab handler (which owns its
  // side effects). Phase 1 surfaces only those explicitly annotated for the
  // palette — i.e. today's existing `paletteEntry` commands.
  if (cap.runsIn === 'browser' || cap.runsIn === 'hybrid') {
    return cap.surfaces?.palette ? 'fire-and-toast' : 'exclude';
  }

  // Server capabilities, executed via the dispatch + toast shim.
  // The shim cannot host streaming (publishState) or interactive (askUser)
  // tools, and cannot prompt for required args — exclude them in Phase 1.
  if (cap.streaming || cap.interactive || cap.requiresArgs) return 'exclude';

  // Destructive / high-risk: show, but gate behind a confirm step. Never
  // fire-and-toast a one-keystroke irreversible action.
  if (cap.destructive || cap.tier === 'high') return 'confirm';

  return 'fire-and-toast';
}

/** Whether a capability is offered in the palette at all (confirm-gated counts as visible). */
export function isPaletteVisible(cap: Capability): boolean {
  return paletteEligibility(cap) !== 'exclude';
}

/** Whether running this capability from the palette must first prompt for confirmation. */
export function requiresPaletteConfirm(cap: Capability): boolean {
  return paletteEligibility(cap) === 'confirm';
}
