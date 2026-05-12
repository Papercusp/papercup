// Test helpers. Lets tests force flag values without standing up PostHog.
// Server-side: `initFlagBackend(null)` then `setFlagOverridesForTest({...})`.
// Client-side: assign `globalThis.__PAPERCUSP_FLAGS__` before importing client.

import type { FlagKey, FlagValues } from "./types.js";
import { FLAG_DEFAULTS } from "./types.js";

let overrides: Partial<Record<FlagKey, boolean>> | null = null;

export function setFlagOverridesForTest(
  values: Partial<Record<FlagKey, boolean>> | null,
): void {
  overrides = values;
}

export function resolveTestOverrides(): FlagValues | null {
  if (!overrides) return null;
  return { ...FLAG_DEFAULTS, ...overrides };
}
