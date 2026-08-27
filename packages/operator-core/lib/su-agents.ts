/**
 * su-agents.ts — the three Papercusp superuser CLI agents (claude / omp /
 * codex).
 *
 * As of psu-only-launch-unification (P-041) the `*-su` wrappers are retired:
 * `psu` → `bootstrap-su` → `buildLaunchSpec({kind:'su'})` assembles the
 * playbook + MCP + flags per-launch and execs the RAW CLI (see
 * `suLaunchArgs`/`resumeArgsFor` in psu-launcher.mjs). The old
 * `SU_WRAPPER_BIN` map (claude-su / omp-su / codex-su) is gone — nothing
 * execs a wrapper anymore.
 */

export type SuAgent = 'claude' | 'omp' | 'codex';

export const SU_AGENTS: readonly SuAgent[] = ['claude', 'omp', 'codex'];

export function isSuAgent(x: unknown): x is SuAgent {
  return x === 'claude' || x === 'omp' || x === 'codex';
}

/** Effective/public launch context. The trimmed seed remains fully growable via
 * tools:find/tools:invoke; `full` exists only as a legacy decoder input. */
export type SuContextSize = 'trimmed';
export type LegacySuContextSize = 'full' | SuContextSize;

export const SU_CONTEXT_SIZES: readonly SuContextSize[] = ['trimmed'];

export function isSuContextSize(x: unknown): x is SuContextSize {
  return x === 'trimmed';
}

export { SU_CONTEXT_SIZE, LEGACY_SU_CONTEXT_SIZE, normalizeSuContextSize } from './su-context-size.mjs';
