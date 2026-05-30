/**
 * su-agents.ts — the three Papercusp superuser CLI agents and their
 * installed `*-su` wrapper names.
 *
 * The `*-su` wrappers (omp-su / claude-su / codex-su), installed by
 * apps/operator/scripts/install-standalone-mcp.sh, already inject the
 * engineer-collaborator playbook + skip-permissions + the papercusp-su
 * MCP server (codex-su via a dedicated CODEX_HOME). The plan-tracked
 * launcher and the bootstrap-su endpoint only need to know WHICH wrapper
 * backs each agent — they exec the wrapper rather than re-deriving its
 * flags. See `psu-wrappers-and-plan-tracked-launch-2026-05-30` (pivot).
 */

export type SuAgent = 'claude' | 'omp' | 'codex';

export const SU_AGENTS: readonly SuAgent[] = ['claude', 'omp', 'codex'];

export function isSuAgent(x: unknown): x is SuAgent {
  return x === 'claude' || x === 'omp' || x === 'codex';
}

/** On-PATH `*-su` wrapper that launches each agent in engineer mode. */
export const SU_WRAPPER_BIN: Record<SuAgent, string> = {
  claude: 'claude-su',
  omp: 'omp-su',
  codex: 'codex-su',
};
