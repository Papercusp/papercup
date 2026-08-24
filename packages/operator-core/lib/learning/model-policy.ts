/**
 * Canonical model contract for every model-bearing learning path.
 *
 * Keep the bare model id and reasoning effort independently addressable for
 * APIs that expose separate fields, and use {@link LEARNING_MODEL_SPEC} at the
 * existing Papercusp model-spec seams (LLM calls and spawned roles). The Codex
 * Responses bridge splits the suffix before sending the request upstream.
 */
export const LEARNING_MODEL_ID = 'gpt-5.6-sol' as const;
export const LEARNING_MODEL_EFFORT = 'xhigh' as const;
export const LEARNING_MODEL_SPEC = `${LEARNING_MODEL_ID}:${LEARNING_MODEL_EFFORT}` as const;

/** True only for the exact owner-directed learning model contract. */
export function isCanonicalLearningModel(value: unknown): value is typeof LEARNING_MODEL_SPEC {
  return value === LEARNING_MODEL_SPEC;
}
