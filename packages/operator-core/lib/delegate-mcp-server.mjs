#!/usr/bin/env node
/**
 * Delegate MCP server — exposes cross-harness agent-dispatch tools to
 * the `claude -p` delegate spawned by /api/agent-mcp/delegate-chat.
 *
 * Per Plan v6 phase B: the operator routes any agent-touching work
 * through a delegate, so the delegate needs the cross-harness surface.
 *
 * Defines the listHarnesses / getHarnessStatus / listChats /
 * dispatchToAgent surface from lib/agent-tools-shared.mjs (which is
 * delegate-only now — the Oracle migrated to the unified HTTP MCP
 * via mcp-remote on 2026-05-11, and its stdio shim was deleted).
 * Adds two delegate-specific tools:
 *   - listAgents — enumerate active roles per harness in the workspace
 *   - followUpInChat — append to an existing chat by id
 *
 * No UI-command channel — the delegate has no browser session of its
 * own. The operator panel auto-opens on delegation completion and
 * displays the transcript; user navigates manually if desired.
 *
 * Env: DELEGATE_BASE (default http://localhost:3055).
 * No bearer needed — same trust model as oracle-mcp (delegate runs in
 * the same process tree as the operator that minted it).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SHARED_TOOLS, runSharedTool, text, errText } from './agent-tools-shared.mjs';
import { listSharedResources, runSharedResource } from './agent-resources-shared.mjs';
import { SHARED_PROMPTS, runSharedPrompt } from './agent-prompts-shared.mjs';

const BASE = process.env.DELEGATE_BASE ?? 'http://localhost:3055';

const DELEGATE_ONLY_TOOLS = [
  {
    name: 'followUpInChat',
    description:
      'Append a follow-up message to an existing chat by id. No new chat created. Use after listChats has ' +
      'surfaced an in-flight thread you want to continue rather than restart.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        chatId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['slug', 'chatId', 'message'],
    },
  },
];

const TOOLS = [...SHARED_TOOLS, ...DELEGATE_ONLY_TOOLS];

const server = new Server(
  { name: 'delegate', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Resources — see agent-resources-shared.mjs (delegate-only since
// the Oracle stdio shim was deleted on 2026-05-11).
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = await listSharedResources({ base: BASE });
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const contents = await runSharedResource(req.params.uri, { base: BASE });
  return { contents: [contents] };
});

// Prompts — see agent-prompts-shared.mjs.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: SHARED_PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  return runSharedPrompt(req.params.name, req.params.arguments ?? {});
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  try {
    if (SHARED_TOOLS.some((t) => t.name === name)) {
      return await runSharedTool(name, args, { base: BASE });
    }

    if (name === 'followUpInChat') {
      const slug = String(args?.slug ?? '').trim();
      const chatId = String(args?.chatId ?? '').trim();
      const message = String(args?.message ?? '').trim();
      if (!slug || !chatId || !message) return errText('slug, chatId, message required');
      const r = await fetch(
        `${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: message }) },
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return errText(`followUp failed: HTTP ${r.status} ${t}`);
      }
      return text(JSON.stringify({ ok: true, slug, chatId }, null, 2));
    }

    return errText(`unknown tool: ${name}`);
  } catch (e) {
    return errText(`tool error: ${e?.message ?? String(e)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
