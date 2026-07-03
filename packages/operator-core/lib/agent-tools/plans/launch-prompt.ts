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
export function deriveLaunchPromptText(
  note: string | null | undefined,
  autoMode = true,
): string {
  const trimmed = (note ?? '').trim();
  if (trimmed.length > 0) return trimmed;
  // AUTO ON — a headless fleet member / no human at the keyboard: it MUST start
  // working the plan immediately or it parks idle. Keep the direct work order.
  if (autoMode) {
    return 'Begin: advance this plan. Read the `## Now` block, pick up the ' +
      'next actionable item, and work it.';
  }
  // AUTO OFF — a lead/solo agent WITH a human present. Per the persona routing
  // gate (WHAT/HOW/WHO), it must NOT silently start editing: read the plan, then
  // present the execution options and let the owner choose. (Also names plans:get
  // to stop weak models flailing on `plan://` / file-path guesses.)
  return "You've been handed this plan to implement. First read it with the `plans:get` " +
    'tool (not a file path or a `plan://` URI). Then, BEFORE doing any work, go through your ' +
    'routing gate: outline the approach and present the execution options — (A) do it ' +
    'yourself, (B) hand it to the Queen, or (C) launch a fleet of agents to parallelize it — ' +
    'recommend one based on the plan size, and confirm with the owner which to use. Do not ' +
    'start editing until they choose.';
}
