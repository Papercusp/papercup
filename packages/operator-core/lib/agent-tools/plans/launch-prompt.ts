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

/** The plan a launch is bound to — baked VERBATIM into the kickoff so the agent
 *  never has to recover the slug from context. Weak-model guard proven necessary
 *  2026-07-03: ornith leader session 10115 was handed "the plan" with no slug in
 *  the kickoff, failed to extract it from coord:orient's launched-by fact, called
 *  plans:get slug-less, listed plans twice, then PARKED on an interactive `ask`
 *  ("Which plan slug?") until killed. */
export interface LaunchPlanRef {
  slug: string;
  harness?: string | null;
}

function plansGetArgs(plan: LaunchPlanRef): string {
  const h = (plan.harness ?? '').trim();
  return `{ slug: "${plan.slug}"${h ? `, harness: "${h}"` : ''} }`;
}

/**
 * The first user turn for a launch — the supplied note, or a default kickoff when
 * the launch carried none. When `plan` is provided, the kickoff names the exact
 * slug (+ harness) and the literal `plans:get` args (appended to a custom note
 * too — the note author may not have restated the slug). Pure.
 */
export function deriveLaunchPromptText(
  note: string | null | undefined,
  autoMode = true,
  plan?: LaunchPlanRef | null,
): string {
  const trimmed = (note ?? '').trim();
  if (trimmed.length > 0) {
    return plan
      ? `${trimmed}\n\n(You were launched on plan \`${plan.slug}\` — read it with the ` +
          `\`plans:get\` MCP tool, args ${plansGetArgs(plan)}.)`
      : trimmed;
  }
  // AUTO ON — a headless fleet member / no human at the keyboard: it MUST start
  // working the plan immediately or it parks idle. Keep the direct work order —
  // but carry the SAME weak-model guards as the AUTO-off branch (proven necessary
  // by the 2026-07-03 ornith fleet run): member session 9981 had NO plans:get
  // guidance here and burned its first turns hunting a plan FILE (4× `cat
  // docs/plans/…`, `find`, then a node -e read) before recovering via coord:orient;
  // and leader 9980, after two tool timeouts, marked an item done "based on prior
  // verification" that never happened (EI-7000) — hence the completion-integrity
  // clause.
  if (autoMode) {
    const readClause = plan
      ? `Begin: advance the plan \`${plan.slug}\`. Read it by calling the \`plans:get\` MCP ` +
        `tool with EXACTLY these args: ${plansGetArgs(plan)} — copy them verbatim; do NOT ` +
        'ask which plan or hunt for one. The plan lives in the coordination system, NOT on disk, so do '
      : 'Begin: advance this plan. Read it by calling the `plans:get` MCP tool with its ' +
        'slug (pass `harness`) — the plan lives in the coordination system, NOT on disk, so do ';
    return readClause +
      'NOT hunt for a plan file with `read`, `bash`, `find`, or `grep`. Call MCP tools ' +
      'directly (or via `tools:invoke { name, args }`) — NEVER from inside `eval` (the eval ' +
      'runtime has no `tools` object; that is a NameError). Then read the `## Now` block, ' +
      'pick up the next actionable item, and work it. Completion integrity: mark an item ' +
      'done ONLY after the work was actually done and verified — a tool timeout or error ' +
      'means RETRY or report the blocker, never mark-done-anyway.';
  }
  // AUTO OFF — a lead/solo agent WITH a human present. Per the persona routing
  // gate (WHAT/HOW/WHO), it must NOT silently start editing: read the plan, then
  // present the execution options and let the owner choose.
  //
  // Every clause is a weak-model guard proven necessary by a real ornith run:
  //  · "call the `plans:get` MCP tool … NOT … read/bash/find/grep" — session 9870
  //    burned 29 turns because "read it with the plans:get tool" made it call the
  //    `read` BUILTIN with path:"plans:get", then flail with `find`/`grep`/`ls`.
  //  · "invoke it via `tools:invoke` … do NOT invent an `eval`/`code` tool" — session
  //    9885 abused `lsp` and session 9891 DOOM-LOOPED calling a HALLUCINATED `eval`
  //    tool (26 no-op calls) instead of the real MCP tool; naming the reliable
  //    tools:invoke escape hatch + forbidding the invented tool breaks that loop.
  //  · "(C) … executed with the `fleet:launch-on-plan` tool" — sessions 9870/9865
  //    chose C, then never launched (the tool was hidden) or hand-built a broken psu
  //    command; naming the exact verb makes option C real.
  const gateReadClause = plan
    ? `You've been handed the plan \`${plan.slug}\` to implement. First read it by calling ` +
      `the \`plans:get\` MCP tool with EXACTLY these args: ${plansGetArgs(plan)} — copy them ` +
      'verbatim; do NOT ask which plan or hunt for one. The plan lives in the coordination system, NOT on disk, so '
    : "You've been handed a plan to implement. First read it by calling the `plans:get` " +
      "MCP tool with the plan's slug — the plan lives in the coordination system, NOT on disk, so ";
  return gateReadClause +
    'do NOT use the `read`, `bash`, `find`, or `grep` file tools and do NOT guess a `plan://` or ' +
    'file path. If a papercusp tool is not directly callable, invoke it via `tools:invoke` with ' +
    '`{ name, args }` (e.g. `tools:invoke { name: "plans:get", args: { slug, harness } }`) — do NOT ' +
    'route a tool call through `lsp`, do NOT invent an `eval`/`code` tool, and NEVER call MCP ' +
    'tools from INSIDE `eval` (the eval runtime has no `tools` object — that is a NameError). ' +
    'Then, BEFORE doing any work, go through your routing gate: outline the approach ' +
    'and present the execution options — (A) do it yourself, (B) hand it to the Queen, or (C) ' +
    'launch a fleet of agents to parallelize it (executed in ONE call with the ' +
    '`fleet:launch-on-plan` tool — never a hand-built psu command) — recommend one based on the ' +
    'plan size, and confirm with the owner which to use. Do not start editing until they choose.';
}
