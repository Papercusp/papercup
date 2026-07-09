/**
 * flag-override-store.ts — the ONE PG-backed runtime flag-override store, installable
 * from any operator-core process.
 *
 * WHY THIS MODULE EXISTS (codex-gateway-chatgpt-live-2026-07-09, root cause of a silent
 * class of bugs):
 * `getFlag()` consults the override store ONLY when a process has called
 * `initFlagOverrideStore()`. That call lived exclusively inside `flag-bus.ts`, which the
 * inference-gateway process does NOT import (flag-bus drags in SSE + lexicon config, which a
 * standalone gateway sidecar has no business booting). So in the gateway process
 * `overrideStore` stayed null → `loadStoredOverrides()` returned `{}` → every
 * `flags:set` / `POST /api/flags/set` runtime override was INVISIBLE, and `getFlag()` silently
 * fell through to `FLAG_DEFAULTS`. A dark flag could therefore never be turned on for the
 * gateway by the documented mechanism — the flip reported success and changed nothing.
 * (Found while activating CODEX_GATEWAY_OAUTH_PROXY: `flags:set` → ok, gateway still OFF.)
 *
 * The store definition is extracted HERE so the two installers share one implementation
 * instead of forking a second copy:
 *   • `flag-bus.ts`      — the operator/web process (also wires the SSE change bus)
 *   • `inference-gateway/sidecar-main.ts` — the standalone gateway process
 *
 * Both already depend on `operator-state-pg` (the gateway reads its account pool through the
 * same idiom), so this adds no new dependency to either.
 *
 * Idempotent: installing twice is harmless (the flags lib just replaces the store + clears its
 * cache), so a process that imports both flag-bus and this module is fine.
 */
import { initFlagOverrideStore, isOverrideStoreConfigured } from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';

/** The operator-state key holding the `{ [flagKey]: boolean }` override map. */
export const FLAG_OVERRIDES_STATE_KEY = 'operator_flag_overrides';

/**
 * Install the PG-backed runtime override store into the flags lib for THIS process.
 *
 * Registered unconditionally — independent of the PostHog opt-in — so a dev box with no
 * PostHog can flip flags at runtime via `flags:set` / `/api/flags/set` instead of a
 * `PAPERCUSP_FLAG_*` env var + process restart. The flags lib layers these between test
 * overrides and PostHog, behind a short read cache.
 */
export function installFlagOverrideStore(): void {
  initFlagOverrideStore({
    // Partition the override read-cache by workspace: load() reads
    // `WHERE workspace_id = activeWorkspaceId()`, so without this the first
    // workspace to load would serve its overrides to every other workspace
    // for the cache TTL (a cross-workspace flag bleed).
    cacheKey: () => activeWorkspaceId(),
    async load() {
      return (await readOperatorState<Partial<Record<FlagKey, boolean>>>(FLAG_OVERRIDES_STATE_KEY)) ?? {};
    },
    async set(key, enabled) {
      const current = (await readOperatorState<Partial<Record<FlagKey, boolean>>>(FLAG_OVERRIDES_STATE_KEY)) ?? {};
      if (enabled === null) delete current[key];
      else current[key] = enabled;
      await writeOperatorState(FLAG_OVERRIDES_STATE_KEY, current);
    },
  });
}

/** Re-exported so a process (or a guard test) can assert the store actually got installed. */
export { isOverrideStoreConfigured };
