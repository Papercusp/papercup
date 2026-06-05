/**
 * Shared `--allowed-tools` list for the operator's claude-code spawns.
 *
 * Both /api/agent-mcp/operator-scan and /api/agent-mcp/operator-converse
 * use this so the operator's tool surface is identical across the
 * proactive scanner and the conversational brain. Adding a tool here
 * makes it available to the operator everywhere.
 *
 * Claude-code's allowed-tools format for MCP-projected tools is
 *   mcp__<server-name>__<tool-name>
 * where server-name comes from the mcpServers key (we always use
 * `agentmcp`) and tool-name is the dotted-or-colon-separated MCP name
 * exposed by the agent-mcp catalog or a registered plugin.
 */
export const ALL_AGENT_MCP_TOOLS: readonly string[] = [
  // Read-only world model
  'mcp__agentmcp__harness:list',
  'mcp__agentmcp__harness:membership',
  'mcp__agentmcp__harness:get',
  'mcp__agentmcp__harness:status',
  'mcp__agentmcp__tasks:list',
  'mcp__agentmcp__tasks:get',
  'mcp__agentmcp__tasks:create',
  // tasks:update / tasks:close — listed in earlier iterations but no
  // `defineTool` exists; removed to keep the brain's tool surface
  // honest. Add back when the handlers ship.
  'mcp__agentmcp__goals:list',
  'mcp__agentmcp__goals:get',
  'mcp__agentmcp__issues:list',
  'mcp__agentmcp__harness:escalation',
  'mcp__agentmcp__harness:pending_reviews',
  // Plans read surface — the needs-human inbox + importance the scanner
  // weights recommendations by (planning-attention-importance P-018).
  // plans:items { needsHuman: true } and plans:attention are already
  // importance-sorted; list/get give surrounding plan context. Read-only.
  'mcp__agentmcp__plans:list',
  'mcp__agentmcp__plans:get',
  'mcp__agentmcp__plans:items',
  'mcp__agentmcp__plans:attention',
  'mcp__agentmcp__messages:inbox',
  'mcp__agentmcp__messages:outbox',
  'mcp__agentmcp__messages:send',
  'mcp__agentmcp__audit:list',
  'mcp__agentmcp__pending_events:list',
  // hindsight:recall removed 2026-05-31 — the tool was DEPRECATED 2026-05-09 and
  // is unwired (no importer registers it), so advertising it here just produced
  // "tool not found". Memory recall is features:get / features:history / features:search.
  'mcp__agentmcp__search:query',
  'mcp__agentmcp__search:fulltext',
  'mcp__agentmcp__search:semantic',

  // Persistent memory layer (Plan 3 — mem0ai/oss in library mode).
  // 5-kind schema: identity / preference / project / correction / ephemeral.
  // Per-user scoped via session cookie; workspace-shared via metadata.shared.
  'mcp__agentmcp__memory:remember',
  'mcp__agentmcp__memory:search',
  'mcp__agentmcp__memory:list',
  'mcp__agentmcp__memory:forget',
  'mcp__agentmcp__memory:update',

  // Spawn primitive (Phase 9 / @papercupai/orchestrator-spawn plugin).
  // Operator role is allowlisted to spawn any other role with a
  // perRun: 60 quota. See /docs/agent-spawning.
  //
  // KNOWN GAP (2026-05-10): listing these in allowedTools is necessary
  // but not sufficient. The standalone agent-mcp server spawned by
  // claude-code (packages/agent-mcp/src/server-entry.ts → bootstrap.ts)
  // only registers BUILT-IN tools — it does not run the plugin loader.
  // So orchestrator.spawn currently returns "tool not found" at the
  // MCP layer even though it's listed here. Real fix is one of:
  //   A) Add plugin loading to bootstrap.ts (duplicates host wiring)
  //   B) Run an HTTP MCP route on the operator (claude-code supports
  //      type:'http' mcpServers) so the subprocess proxies into the
  //      operator's already-loaded plugin catalog
  // B is the right answer; tracked for follow-up.
  // claude-code converts `.` to `_` in MCP tool names — server-side
  // these are exposed as orchestrator.spawn / poll / list_active / cancel
  // but Claude sees them as orchestrator_spawn etc. Allowlist must match
  // what Claude sees, not what the server exports.
  'mcp__agentmcp__orchestrator_spawn',
  'mcp__agentmcp__orchestrator_poll',
  'mcp__agentmcp__orchestrator_list_active',
  'mcp__agentmcp__orchestrator_cancel',

  // Tool introspection — answers "what can I call?". Companion to
  // tools/list with role+capability+quota metadata that the standard
  // MCP listing strips. Cheap, read-only, no ctx requirements.
  'mcp__agentmcp__agent_tools:list',

  // Agent ↔ UI control surface (commits 00f0bfc3, e548f121).
  // ui:list_clients + ui:get_state are read-only.
  // ui:dispatch writes a row to ui_intents that the browser tab's
  // dispatcher consumes via SSE. Defaults to ctx.uiClientId when
  // present (which requires the chat surface to pass &client=<id> in
  // the operator MCP URL — currently operator-converse does, others
  // need to follow). Even without ctx, agents can pass client_id
  // explicitly after a ui:list_clients call.
  'mcp__agentmcp__ui:list_clients',
  'mcp__agentmcp__ui:get_state',
  'mcp__agentmcp__ui:dispatch',
  // Agent ↔ TUI control surface — the pui (terminal workbench) analogue of
  // ui:dispatch. Lets the operator drive a running pui (switch tab, open the
  // chat pane, focus a worker's zellij pane, read its state) when the user is
  // talking through the terminal surface. The per-surface affordance block in
  // converse-prompt tells the brain to prefer this over ui:dispatch on the TUI.
  'mcp__agentmcp__tui:dispatch',
  // Model-driven choice cards. Renders question + buttons in the chat
  // instead of asking the question as free text. Fire-and-forget;
  // the user's click becomes the next user message. See
  // apps/operator/lib/agent-tools/chat/ask_choice.ts.
  'mcp__agentmcp__chat:ask_choice',

  // The Pot's self-declared wake (autoloop-pot-operator-rebuild-2026-06-05 P0).
  // The chat operator schedules/inspects/fires its own background wakes — the
  // user says "check the fleet in an hour" → pot:declare-wake; "wake up now" →
  // pot:wake. pot:status is read-only.
  'mcp__agentmcp__pot:declare-wake',
  'mcp__agentmcp__pot:wake',
  'mcp__agentmcp__pot:status',
];

/**
 * Subset of ALL_AGENT_MCP_TOOLS that require an INTERACTIVE chat
 * surface — i.e., a real-time user the agent can solicit a response
 * from. These should NOT be in allowedTools for one-shot surfaces
 * like operator-scan (which emits suggestions, not chat turns) or
 * spawn-pi (which boots a workspace; no chat).
 *
 * If a chat-only tool is given to a one-shot surface, the model might
 * call it expecting an answer that will never come — the suggestion
 * stream incompletes; the operator stalls.
 *
 * Keep this list in sync with the `chat:*` namespace and any other
 * tool whose contract requires an interactive responder.
 */
export const INTERACTIVE_CHAT_TOOLS: readonly string[] = [
  'mcp__agentmcp__chat:ask_choice',
];

/**
 * The non-interactive subset — everything except INTERACTIVE_CHAT_TOOLS.
 * For one-shot surfaces (operator-scan etc.) that spawn an agent but
 * don't have a user-facing chat session.
 */
export const NON_INTERACTIVE_AGENT_MCP_TOOLS: readonly string[] =
  ALL_AGENT_MCP_TOOLS.filter((t) => !INTERACTIVE_CHAT_TOOLS.includes(t));
