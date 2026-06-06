/**
 * Server-side wiring for `@papercusp/lexicon` — the twin of operator-vite's
 * `useLexicon()` hook.
 *
 * The lexicon lib is brand-neutral and pack-agnostic; the one host-specific
 * bit is "which brand pack is active right now", which here = the `the-hive`
 * feature flag. The ambient `term()` resolver must be SYNC, so we keep a
 * process-cached pack id (the branding flag is machine-global — see
 * flag-distinct-id) refreshed on an initial read + every flag change.
 *
 * Loaded for side effect by flag-bus.ts so it boots with the flag subsystem.
 * Server code that emits user-facing strings resolves via `term()` (re-exported
 * from this directory's index, or imported from `@papercusp/lexicon` directly —
 * either works once this module has loaded).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { type BrandPackId, configureLexicon } from '@papercusp/lexicon';

import { systemDistinctId } from '../flag-distinct-id';

let cachedPackId: BrandPackId = 'classic';

/** Re-read the the-hive flag and update the cached active pack id. */
export async function refreshLexiconPack(): Promise<BrandPackId> {
  try {
    const on = await getFlag(FLAGS.THE_HIVE, systemDistinctId());
    cachedPackId = on ? 'the-hive' : 'classic';
  } catch {
    cachedPackId = 'classic';
  }
  return cachedPackId;
}

/** The cached active pack id (sync). */
export function activeServerPackId(): BrandPackId {
  return cachedPackId;
}

// Wire the seam synchronously so `term()` is correct from the first call (it
// reads `cachedPackId` live). The async refresh + subscription keep it fresh.
configureLexicon({ activePackId: () => cachedPackId });
void refreshLexiconPack();
onFlagChange((key) => {
  if (key === null || key === FLAGS.THE_HIVE) void refreshLexiconPack();
});
