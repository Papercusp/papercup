'use client';

/**
 * `useLexicon()` — the client half of the flag-gated lexicon layer
 * (the-hive-lexicon-2026-06-06 P-003).
 *
 * Returns a term resolver bound to the active brand pack, selected by the
 * `the-hive` feature flag. Built on the reactive `useFlag` (./flag-hooks), so a
 * live flag flip (admin toggle → SSE) re-renders consuming components with the
 * new labels.
 *
 * Lives in apps/operator/lib (not operator-vite) so BOTH the operator-vite
 * components and the apps/operator/app page implementations they render can
 * import it via `@/lib/useLexicon`. The lib (@papercusp/lexicon) stays
 * brand-neutral; this hook is the host glue that maps the flag → a BrandPackId.
 * Internal identifiers never change — presentation only (D-001).
 */
import { useMemo } from 'react';

import { FLAGS } from '@papercusp/flags';
import { type BoundLexicon, type BrandPackId, lexiconFor } from '@papercusp/lexicon';

import { useFlag } from './flag-hooks';

/**
 * The active brand pack id, reactive to live flag changes. Prefer
 * {@link useLexicon} unless you need the raw id (e.g. to branch on it).
 */
export function useLexiconPackId(): BrandPackId {
  return useFlag(FLAGS.THE_HIVE) ? 'the-hive' : 'classic';
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
