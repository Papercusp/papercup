/**
 * learning_packs tool-group shared bits (learning-packs-2026-06-11 P-009).
 * Thin: the real logic lives in lib/learning-packs/{load-packs,seed,manage}.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

export const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Flag gate — OFF hides pack management (LEARNING_PACKS, default ON). */
export async function learningPacksEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.LEARNING_PACKS, 'system');
  } catch {
    return true; // flag infra hiccup must not brick the verbs (default-ON flag)
  }
}

export const FLAG_OFF = {
  ok: false,
  reason: 'feature-disabled',
  flag: 'papercusp-learning-packs',
  hint: 'Learning packs are flagged off — flip papercusp-learning-packs in /admin/features.',
};
