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
];

// Each surface: route file + a label.
const SURFACES = [
  { label: 'operator-converse', file: 'apps/operator/app/api/agent-mcp/operator-converse/route.ts' },
  { label: 'operator-chat',     file: 'apps/operator/app/api/agent-mcp/operator-chat/route.ts' },
  { label: 'operator-scan',     file: 'apps/operator/app/api/agent-mcp/operator-scan/route.ts' },
  { label: 'delegate-chat',     file: 'apps/operator/app/api/agent-mcp/delegate-chat/route.ts' },
  { label: 'oracle',            file: 'apps/operator/app/api/_hono/oracle.ts' },
  // spawn-pi returns an mcpServer config to the pi process; uses HTTP
  // via mcp-remote so pi sees the full operator catalog. Grep target
  // for the test is the URL of the projected dispatcher.
  { label: 'spawn-pi',          file: 'apps/operator/app/api/agent-mcp/spawn-pi/route.ts', urlOnly: true },
];

// Surfaces that delegate to the shared list — count as having a tool
// if the file imports from operator-mcp-tools.
const SHARED = readFileSync(join(REPO, 'apps/operator/lib/operator-mcp-tools.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

for (const surface of SURFACES) {
  console.log(`--- ${surface.label} ---`);
  const src = readFileSync(join(REPO, surface.file), 'utf8');
  if (surface.urlOnly) {
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
  const importsShared = /from\s+'@\/lib\/operator-mcp-tools'/.test(src);
  const effectiveSrc = importsShared ? src + '\n' + SHARED : src;
  for (const tool of REQUIRED) {
    const found = effectiveSrc.includes(tool);
    check(`includes ${tool}`, found);
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
