#!/usr/bin/env node
/**
 * Static assertion: every chat-surface route (the things that spawn a
 * claude-code subprocess to do MCP-tool reasoning) must include the
 * new "ui control" + introspection tools in its allowedTools list.
 *
 * This catches the regression Oracle surfaced: chat surfaces each
 * hardcode their own `allowedTools` whitelist, and when we add new
 * MCP tools to the catalog the model can't actually call them until
 * the corresponding chat surface's list is updated.
 *
 * Pure-static check — no operator process needed. Greps the route
 * files for the expected MCP tool names. If any surface is missing,
 * the test prints the surface + the missing tools.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/marsh-office/papercupai-workspace/papercup';

// Tools that should be available to every chat surface (after fix).
// Each entry is `mcp__<server>__<name>` because claude-code prefixes
// MCP tool names with their server alias from mcpConfig.
const REQUIRED = [
  'mcp__agentmcp__agent_tools:list',
  'mcp__agentmcp__ui:list_clients',
  'mcp__agentmcp__ui:get_state',
  'mcp__agentmcp__ui:dispatch',
  'mcp__agentmcp__chat:ask_choice',
];

// Each surface: route file + a label + a `kind`.
//   kind='chat'      — interactive: REQUIRED tools (including chat:*)
//                       MUST be present.
//   kind='oneshot'   — one-shot scanner: NON-interactive tools may be
//                       present, but chat:* tools MUST NOT be (model
//                       would call them expecting an answer that never
//                       comes; suggestion stream incompletes).
//   kind='url-bridge'— hands an MCP server config out; no allowedTools
//                       of its own. Test verifies the bridge URL/transport.
const SURFACES = [
  { label: 'operator-converse', kind: 'chat',       file: 'apps/operator/app/api/agent-mcp/operator-converse/route.ts' },
  { label: 'delegate-chat',     kind: 'chat',       file: 'apps/operator/app/api/agent-mcp/delegate-chat/route.ts' },
  { label: 'oracle',            kind: 'chat',       file: 'apps/operator/app/api/_hono/oracle.ts' },
  { label: 'operator-scan',     kind: 'oneshot',    file: 'apps/operator/app/api/agent-mcp/operator-scan/route.ts' },
  { label: 'spawn-pi',          kind: 'url-bridge', file: 'apps/operator/app/api/agent-mcp/spawn-pi/route.ts' },
];

// Tools that are interactive-only — chat surfaces include them; one-shot
// surfaces (operator-scan, spawn-pi) must NOT include them in
// allowedTools, since calling them expects a user response in chat.
const INTERACTIVE_ONLY = [
  'mcp__agentmcp__chat:ask_choice',
];

// Surfaces that delegate to the shared list — count as having a tool
// if the file imports from operator-mcp-tools.
const SHARED = readFileSync(join(REPO, 'apps/operator/lib/operator-mcp-tools.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

// Helper: expand shared content if the surface imports the shared list.
// Returns the effective source we should grep for tool names.
function effectiveSourceFor(src) {
  const importsShared = /from\s+'@\/lib\/operator-mcp-tools'/.test(src);
  return importsShared ? src + '\n' + SHARED : src;
}

for (const surface of SURFACES) {
  console.log(`--- ${surface.label} (${surface.kind}) ---`);
  const src = readFileSync(join(REPO, surface.file), 'utf8');

  if (surface.kind === 'url-bridge') {
    // spawn-pi hands an MCP server config to the pi process. It doesn't
    // build an allowedTools list — instead, it just points the pi at the
    // operator's projected dispatcher URL, which exposes the full
    // catalog. Verify the URL hookup.
    check(`points at /api/mcp?superuser=1 (full operator catalog)`,
      /\/api\/mcp\?superuser=1/.test(src));
    check(`uses mcp-remote bridge (HTTP, not standalone stdio)`,
      /mcp-remote/.test(src));
    continue;
  }

  const effectiveSrc = effectiveSourceFor(src);

  if (surface.kind === 'chat') {
    // Chat surfaces must include the full required catalog (including
    // interactive chat:* tools).
    for (const tool of REQUIRED) {
      check(`includes ${tool}`, effectiveSrc.includes(tool));
    }
  } else if (surface.kind === 'oneshot') {
    // One-shot surfaces (operator-scan): must NOT include interactive
    // chat:* tools — the agent has no user-facing chat to wait on.
    // They MUST include the non-interactive base (or use
    // NON_INTERACTIVE_AGENT_MCP_TOOLS in their allowedTools).
    for (const tool of REQUIRED) {
      if (INTERACTIVE_ONLY.includes(tool)) {
        // Negative test: tool MUST NOT appear as a string literal in
        // the surface's own source (importing the shared list still
        // counts the tool as "present" because effectiveSrc concatenates
        // it; for the negative check we look at the surface file ONLY).
        check(`one-shot surface DOES NOT include ${tool} as a string literal`,
          !new RegExp(`['"\`]${tool.replace(/:/g, '\\:')}['"\`]`).test(src));
      } else {
        check(`includes ${tool}`, effectiveSrc.includes(tool));
      }
    }
    // Belt-and-suspenders: assert the file references the non-interactive
    // import name (catches a future refactor that accidentally puts
    // ALL_AGENT_MCP_TOOLS back into operator-scan).
    check(`uses NON_INTERACTIVE_AGENT_MCP_TOOLS (not ALL_AGENT_MCP_TOOLS)`,
      /NON_INTERACTIVE_AGENT_MCP_TOOLS/.test(src) || !/ALL_AGENT_MCP_TOOLS/.test(src));
  }
  // Surface-specific regression checks.
  if (surface.label === 'oracle') {
    // Oracle's legacy stdio tools (navigate / resumeChat / dispatchToAgent
    // / listHarnesses / getHarnessStatus / listChats / listAgents) were
    // retired 2026-05-11 — every one has a first-party agent_tool. If
    // someone re-introduces an mcp__oracle__ prefix, the migration has
    // partially regressed.
    // Match QUOTED tool names (string literal) so we catch real
    // allowedTools entries / mcpServers references and ignore
    // historical mentions inside comments.
    check(`oracle no longer references legacy mcp__oracle__ tools (string literals)`,
      !/['"]mcp__oracle__[a-zA-Z]+['"]/.test(src));
    check(`oracle wires agent_chats:create + send_message (dispatch replacement)`,
      src.includes('mcp__agentmcp__agent_chats:create') &&
      src.includes('mcp__agentmcp__agent_chats:send_message'));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
