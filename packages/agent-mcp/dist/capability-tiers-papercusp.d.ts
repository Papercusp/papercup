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
 * Host-installed SYNC override seam (live-configurability-audit P-010, the `capability_tier:set` dial).
 * Returns a CapabilityTier to OVERRIDE the baked classification for a capability, or null/undefined to
 * fall through to the EXACT table + prefixes below. operator-core installs the real resolver (flag-
 * gated, reading its sync-cached operator_capability_tiers store) at boot; until then the baked table
 * governs (byte-identical). Consulted FIRST so a deliberate runtime re-tier (e.g. the EI-99/EI-111
 * mis-tiering class, which were LOWERINGS) takes effect without a deploy — for every consumer that
 * calls papercuspTierFor/tierFor at RUNTIME (the capability catalog/palette projection + the
 * decision-ledger posture). NOTE: consumers that read a tool's LOAD-TIME-STAMPED `tier` (the
 * endpoint-auth-tiers exposure gate, the watchdog per-tool timeout) re-stamp on the next operator boot,
 * so a tier change for THOSE applies after a restart — documented on the dial, an owner-decision to
 * widen to live consumer-side re-resolution (plan D-010 cluster).
 */
export type CapabilityTierOverride = (capability: string) => CapabilityTier | null | undefined;
/** Install (or clear, with `undefined`) the host override resolver. Called once by operator-core at boot. */
export declare function setCapabilityTierOverride(fn: CapabilityTierOverride | undefined): void;
/**
 * Papercusp's capability→tier policy. Returns `'medium'` when no deliberate
 * classification is found — see file header.
 */
export declare function papercuspTierFor(capability: string): CapabilityTier;
