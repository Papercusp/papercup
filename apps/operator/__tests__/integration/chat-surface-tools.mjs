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
];

// Surfaces that delegate to the shared list — count as having a tool
// if the file imports from operator-mcp-tools.
const SHARED = readFileSync(join(REPO, 'apps/operator/lib/operator-mcp-tools.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

for (const surface of SURFACES) {
  console.log(`--- ${surface.label} ---`);
  const src = readFileSync(join(REPO, surface.file), 'utf8');
  const importsShared = /from\s+'@\/lib\/operator-mcp-tools'/.test(src);
  const effectiveSrc = importsShared ? src + '\n' + SHARED : src;
  for (const tool of REQUIRED) {
    const found = effectiveSrc.includes(tool);
    check(`includes ${tool}`, found);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
