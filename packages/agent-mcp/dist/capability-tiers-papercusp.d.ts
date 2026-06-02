/**
 * Papercusp's capability → tier table — the host half of plan P-012 / D-006.
 *
 * Tiers per spec/capabilities §10.6.1. This table used to live baked inside
 * the engine (`@papercusp/tooldef`'s `capability-tiers.ts`); P-012 moved it out
 * so the engine ships only a pluggable resolver (defaulting everything to
 * `'low'`). Importing this module registers `papercuspTierFor` as the active
 * resolver, so `defineTool`/`defineResource`/`definePrompt` stamp each tool's
 * `tier` from this table. The registration is a load-time side effect; it is
 * imported at the top of `index.ts` (before `bootstrap`) so it runs before any
 * tool self-registers.
 *
 * Unenumerated capabilities default to `'medium'` (NOT the engine's `'low'`) —
 * adding a capability without a deliberate tier choice should raise an eyebrow
 * at install time, not silently land at low.
 */
import type { CapabilityTier } from '@papercusp/tooldef';
/**
 * Papercusp's capability→tier policy. Returns `'medium'` when no deliberate
 * classification is found — see file header.
 */
export declare function papercuspTierFor(capability: string): CapabilityTier;
