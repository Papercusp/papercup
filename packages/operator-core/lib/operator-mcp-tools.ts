/**
 * Shared `--allowed-tools` list for the operator's claude-code spawns.
 *
 * The operator chat surfaces (operator-converse + one-shot tools)
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
  // Scan findings live in the self-improvement backlog (unify-agent-launches
  // D-005) — improvements:digest is the operator's "what did the scanner
  // find?" read surface, replacing the retired scans_list/scans_get.
  // improvements:triage is the Queen's type-routing tool (self-learning P-020).
  'mcp__agentmcp__improvements:digest',
  'mcp__agentmcp__improvements:triage',
  // The watchdog's own health/diagnostic read (watchdog-audit-2026-06-09
  // P-010) — "is the auto-capture loop running, what did it see/decline?".
  'mcp__agentmcp__improvements:watchdog-status',
  // Queen-weighting read (self-learning-frontier P-041 / FB-13, D-005): the
  // per-persona per-domain trust weights from recorded bets — what the brain
  // consults before taking a persona's stated confidence at face value.
  'mcp__agentmcp__calibration:summary',
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
  // Inbox-triage PASS — re-tier an attention item, audit the why; + message the
  // owning agent in their context (inbox-tiering-and-message-agent-2026-06-05).
  'mcp__agentmcp__inbox:triage',
  'mcp__agentmcp__coord:message-agent',
  // Spawn admission — the brain decides worth-it (unify-agent-spawn-chokepoint
  // P-005/P-006). `new_subagent:approve` is brain-gated (requireRoles); `request`
  // is the agent-initiated side (surfaced here so the brain sees the request shape).
  'mcp__agentmcp__new_subagent:request',
  'mcp__agentmcp__new_subagent:approve',
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

  // Persistent memory layer (hybrid claude-file + mem0 store).
  // 4-kind schema: user / feedback / project / reference
  // (memory-taxonomy-and-debt-followups D-001).
  // Per-user scoped via session cookie; harness-shared via harness_slug.
  'mcp__agentmcp__memory:remember',
  'mcp__agentmcp__memory:search',
  'mcp__agentmcp__memory:list',
  'mcp__agentmcp__memory:forget',
  'mcp__agentmcp__memory:update',

  // Spawn primitive — fleet:spawn over the durable nursery
  // (harness_shared.spawned_agents), Brief 4 of agent-briefs-2026-06-05.
  // Replaces the @papercupai/orchestrator-spawn plugin's orchestrator_*
  // tools, which were dead on this surface (the plugin is not installed,
  // and the standalone agent-mcp server never ran the plugin loader —
  // every call returned "tool not found"). These are BUILT-IN tools, so
  // they exist on every surface; what's spawned shows up in fleet:tree
  // and is cancellable with fleet:cancel.
  'mcp__agentmcp__fleet:spawn',
  'mcp__agentmcp__fleet:tree',
  'mcp__agentmcp__fleet:cancel',
  // The canonical "who's on what" state query (state-not-chat-fleet-state):
  // presence + claims unified, orphaned-claim signal included.
  'mcp__agentmcp__fleet:assignments',

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

  // The Hive's self-declared wake (autoloop-pot-operator-rebuild-2026-06-05 P0).
  // The chat operator schedules/inspects/fires its own background wakes — the
  // user says "check the fleet in an hour" → hive:declare-wake; "wake up now" →
  // hive:wake. hive:status is read-only.
  'mcp__agentmcp__hive:declare-wake',
  'mcp__agentmcp__hive:wake',
  'mcp__agentmcp__hive:status',

  // The Hive's superpower surface (autoloop-pot-operator-rebuild-2026-06-05
  // P-004): discover the blueprint shapes (catalog), inspect/author one
  // (validate/extend), then create the harness whose blueprint carries its own
  // autoloop. harness:status (above) is the matching read-back.
  'mcp__agentmcp__blueprint:catalog',
  'mcp__agentmcp__blueprint:validate',
  'mcp__agentmcp__blueprint:extend',
  'mcp__agentmcp__harness:create',

  // hive-tool-namespace-2026-06-08 — local hive lifecycle. The operator manages
  // its hives: list/get to inspect; create/update/dissolve to manage. create/
  // dissolve/update are root-only (the operator is root; bees are refused). Wake
  // stays hive:wake / hive:declare-wake; bee placement stays fleet:* (no aliases).
  'mcp__agentmcp__hive:list',
  'mcp__agentmcp__hive:get',
  'mcp__agentmcp__hive:create',
  'mcp__agentmcp__hive:update',
  'mcp__agentmcp__hive:dissolve',

  // cross-hive-boundary-2026-06-08 P-002 — the owner's cross-Hive admission
  // surface. discovery:hives finds a peer Hive's pubkey on the P2P directory;
  // hive:cross_grant sets/revokes/lists which peer Hives may send which kinds
  // (ask | work-request) INTO this Hive (default-deny allow-list, federates to
  // all of this Hive's Swarms). This is the conversational path for the owner to
  // say "let Hive X send us asks" — the sovereignty boundary between Hives.
  'mcp__agentmcp__discovery:hives',
  'mcp__agentmcp__hive:cross_grant',

  // hive-network-surface-2026-06-11 P-005 (B-07) — owner beacon-publish consent.
  // The conversational twin of the desktop consent UX: enable/disable/read
  // whether THIS Hive publishes a live status beacon to the directory
  // (owner-consent, default-OFF). Federates to all of this Hive's Swarms.
  'mcp__agentmcp__hive:beacon_consent',

  // hive-network-surface-2026-06-11 P-006 (B-08) — the aggregate Network board:
  // one row per other-hive context across the capability-tier ladder (this Swarm,
  // own other hives, federated peer Swarms, foreign directory hives + beacon +
  // our grants/asks). The Queen's "what is every other hive doing" read.
  'mcp__agentmcp__network:board',

  // hive-network-surface-2026-06-11 P-003 (B-04) — the INITIATING side of the
  // cross-Hive boundary: hive:ask / hive:request_work send a signed request to a
  // peer Hive (by pubkey, from discovery:hives) and record it in this Hive's ask
  // ledger; the peer's answer arrives async (events:await the answeredEvent key).
  // hive:asks reviews the ledger (pending / answered / declined). The owner and
  // Queen share these verbs to ask another Hive that owns a domain.
  'mcp__agentmcp__hive:ask',
  'mcp__agentmcp__hive:request_work',
  'mcp__agentmcp__hive:asks',
];

/**
 * Subset of ALL_AGENT_MCP_TOOLS that require an INTERACTIVE chat
 * surface — i.e., a real-time user the agent can solicit a response
 * from. These should NOT be in allowedTools for one-shot surfaces
 * like one-shot surfaces (which emit results, not chat turns) or
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
 * For one-shot surfaces that spawn an agent but
 * don't have a user-facing chat session.
 */
export const NON_INTERACTIVE_AGENT_MCP_TOOLS: readonly string[] =
  ALL_AGENT_MCP_TOOLS.filter((t) => !INTERACTIVE_CHAT_TOOLS.includes(t));
