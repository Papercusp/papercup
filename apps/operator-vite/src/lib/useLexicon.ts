/**
 * `useLexicon()` — the client half of the flag-gated lexicon layer
 * (the-hive-lexicon-2026-06-06 P-003).
 *
 * Returns a term resolver bound to the active brand pack, selected by the
 * `the-hive` feature flag. Reactive: it subscribes to the flag store, so a
 * live flag flip (admin toggle → SSE) re-renders the consuming component with
 * the new labels. (Plain `useFlag` only reads at render time and would NOT
 * re-render on a flip — so the lexicon must subscribe itself.)
 *
 * The lib stays brand-neutral; this hook is the operator-vite glue that maps
 * the flag → a `BrandPackId`. Internal identifiers never change (D-001).
 */
import { useMemo, useSyncExternalStore } from 'react';

import { FLAGS } from '@papercusp/flags';
import { getFlagSnapshot, subscribe } from '@papercusp/flags/client';
import { type BoundLexicon, type BrandPackId, lexiconFor } from '@papercusp/lexicon';

function readPackId(): BrandPackId {
  return getFlagSnapshot().flags[FLAGS.THE_HIVE] ? 'the-hive' : 'classic';
}

/**
 * The active brand pack id, reactive to live flag changes. Prefer
 * {@link useLexicon} unless you need the raw id (e.g. to branch on it).
 */
export function useLexiconPackId(): BrandPackId {
  return useSyncExternalStore(subscribe, readPackId, readPackId);
}

/**
 * A term resolver bound to the active brand pack:
 *
 *   const t = useLexicon();
 *   <h1>{t('pot', { plural: true })}</h1>   // "Pots" | "Hives"
 *   <span>{t('cupboard')}</span>            // "Cupboard" | "Comb"
 */
export function useLexicon(): BoundLexicon {
  const packId = useLexiconPackId();
  return useMemo(() => lexiconFor(packId), [packId]);
}
