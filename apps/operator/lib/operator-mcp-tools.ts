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
  'mcp__agentmcp__harness:get',
  'mcp__agentmcp__harness:status',
  'mcp__agentmcp__tasks:list',
  'mcp__agentmcp__tasks:get',
  'mcp__agentmcp__tasks:create',
  'mcp__agentmcp__tasks:update',
  'mcp__agentmcp__tasks:close',
  'mcp__agentmcp__goals:list',
  'mcp__agentmcp__goals:get',
  'mcp__agentmcp__issues:list',
  'mcp__agentmcp__messages:inbox',
  'mcp__agentmcp__messages:outbox',
  'mcp__agentmcp__messages:send',
  'mcp__agentmcp__audit:list',
  'mcp__agentmcp__pending_events:list',
  'mcp__agentmcp__hindsight:recall',
  'mcp__agentmcp__search:query',

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
  // Model-driven choice cards. Renders question + buttons in the chat
  // instead of asking the question as free text. Fire-and-forget;
  // the user's click becomes the next user message. See
  // apps/operator/lib/agent-tools/chat/ask_choice.ts.
  'mcp__agentmcp__chat:ask_choice',
];
