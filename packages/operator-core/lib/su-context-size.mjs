/**
 * Canonical agent launch-context policy.
 *
 * `full` used to eagerly advertise the entire Papercusp tool catalog. That is
 * both wasteful and, for Codex, transport-invalid once the code-mode IPC frame
 * exceeds 64 MiB. The trimmed surface is growable: tools:find/list_changed and
 * tools:invoke retain reachability to the complete catalog.
 *
 * Keep accepting the legacy spelling at durable/CLI boundaries so old launch
 * rows do not become traps. It is an alias, never an effective launch mode.
 */
export const SU_CONTEXT_SIZE = "trimmed";
export const LEGACY_SU_CONTEXT_SIZE = "full";

/**
 * @param {unknown} input
 * @returns {
 *   | { ok: true, contextSize: "trimmed", explicit: boolean, normalizedLegacyFull: boolean }
 *   | { ok: false, error: string, received: string }
 * }
 */
export function normalizeSuContextSize(input) {
  const received = input == null ? "" : String(input).trim();
  if (!received) {
    return { ok: true, contextSize: SU_CONTEXT_SIZE, explicit: false, normalizedLegacyFull: false };
  }
  if (received === SU_CONTEXT_SIZE) {
    return { ok: true, contextSize: SU_CONTEXT_SIZE, explicit: true, normalizedLegacyFull: false };
  }
  if (received === LEGACY_SU_CONTEXT_SIZE) {
    return { ok: true, contextSize: SU_CONTEXT_SIZE, explicit: true, normalizedLegacyFull: true };
  }
  return {
    ok: false,
    received,
    error: `context size must be '${SU_CONTEXT_SIZE}' (legacy '${LEGACY_SU_CONTEXT_SIZE}' is normalized to '${SU_CONTEXT_SIZE}'; got ${received || "empty"})`,
  };
}
