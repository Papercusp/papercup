/**
 * The kickoff first-turn text for a plan launch — a SINGLE pure source shared by
 * both delivery paths so they can never drift:
 *   - headless `plans:launch` (this lib's launch.ts) seeds it as the agent's first
 *     `role:'user'` turn;
 *   - the interactive `psu` launcher seeds it as the backend CLI's positional first
 *     turn for a scripted plan launch (improve-fleet-launch-autokickoff / EI-5503).
 *     bootstrap-su returns it on `kickoffPrompt`; the launcher delivers it.
 *
 * Deliberately dependency-free (no DB / runner / agent-mcp imports) so the bootstrap
 * route + any launcher can import it without pulling launch.ts's heavy module graph.
 */

/**
 * The first user turn for a launch — the supplied note, or a default kickoff when
 * the launch carried none. Pure.
 */
export function deriveLaunchPromptText(note: string | null | undefined): string {
  const trimmed = (note ?? '').trim();
  return trimmed.length > 0
    ? trimmed
    : 'Begin: advance this plan. Read the `## Now` block, pick up the ' +
        'next actionable item, and work it.';
}
