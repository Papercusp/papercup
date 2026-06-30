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

/**
 * su-context-size-variants — the initial-context SIZE a launched SU session
 * boots with, ORTHOGONAL to the agent. The big lever is the MCP tool catalog
 * (~551 tools / ~141k tokens loaded whole, atop a ~38k static prefix):
 *
 *   'full'    — load the whole superuser catalog up-front (~180k ctx). No
 *               discovery step; every tool callable immediately. Best for a
 *               capable, large-context model.
 *   'trimmed' — only a small core loads up-front (~50k ctx); the rest is
 *               reached on demand via each client's NATIVE soft-trim
 *               (Claude ToolSearch / OMP search_tool_bm25 / Codex hard
 *               ?tools= allowlist). Best for small-context / local models.
 *
 * Omitted at launch ⇒ each client keeps its native default (Claude+OMP defer,
 * Codex loads whole).
 */
export type SuContextSize = 'full' | 'trimmed';

export const SU_CONTEXT_SIZES: readonly SuContextSize[] = ['full', 'trimmed'];

export function isSuContextSize(x: unknown): x is SuContextSize {
  return x === 'full' || x === 'trimmed';
}
