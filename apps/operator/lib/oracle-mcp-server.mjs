#!/usr/bin/env node
/**
 * Oracle MCP server — exposes UI/server tools to claude -p.
 *
 * Spawned by the operator's /api/oracle/chat endpoint per-request with
 * `ORACLE_SESSION_ID` and `ORACLE_BASE` env vars. Tools either:
 *   (a) do work directly and return the result to claude (shared with
 *       the delegate MCP server via lib/agent-tools-shared.mjs), or
 *   (b) forward a UI command to the dock by POSTing to the operator's
 *       /api/oracle/sessions/:id/ui-command endpoint, which relays the
 *       command to the connected browser via the chat's SSE stream.
 *
 * Oracle-specific tools (have a UI channel via ORACLE_SESSION_ID):
 *   - navigate
 *   - resumeChat
 *   - dispatchToAgent (extends the shared dispatch with auto-navigate)
 *
 * Shared with delegate-mcp-server (no UI bolt-on needed):
 *   - listHarnesses, getHarnessStatus, listChats
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
import { SHARED_TOOLS, runSharedTool, runDispatchToAgent, text, errText } from './agent-tools-shared.mjs';
import { listSharedResources, runSharedResource } from './agent-resources-shared.mjs';
import { SHARED_PROMPTS, runSharedPrompt } from './agent-prompts-shared.mjs';

const SESSION_ID = process.env.ORACLE_SESSION_ID;
const BASE = process.env.ORACLE_BASE ?? 'http://localhost:3055';

if (!SESSION_ID) {
  console.error('[oracle-mcp] ORACLE_SESSION_ID env var required');
  process.exit(1);
}

async function pushUiCommand(command) {
  const r = await fetch(`${BASE}/api/oracle/sessions/${SESSION_ID}/ui-command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ui-command push failed: HTTP ${r.status} ${t}`);
  }
}

// Oracle-specific tools — the ones with a UI-command bolt-on. listAgents
// + the read-only shared tools come from agent-tools-shared.mjs.
const ORACLE_ONLY_TOOLS = [
  {
    name: 'navigate',
    description:
      "Navigate the user's browser to a path within the operator app. " +
      'Use this when the user asks you to take them somewhere, or when an ' +
      'action requires the user to be on a specific page. Returns immediately; ' +
      'the browser executes the navigation asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to navigate to, starting with /. Examples: "/harness", "/marketplace/plugins", "/settings/oracle".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'resumeChat',
    description:
      'Open an existing chat panel for the user (identified by chatId). Use after listChats has ' +
      'surfaced a candidate id.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Harness slug.' },
        chatId: { type: 'string', description: 'Existing chat id (use listChats to find).' },
      },
      required: ['slug', 'chatId'],
    },
  },
];

// dispatchToAgent has shared logic + Oracle-specific UI bolt-on, so we
// override the shared definition to keep the auto-navigate description.
const ORACLE_DISPATCH_TOOL = {
  name: 'dispatchToAgent',
  description:
    'Start a new chat with a role-scoped agent in a harness and send the first message. The user is ' +
    'auto-navigated to the harness dashboard and the chat panel opens. Common roles: orchestrator, scoper, ' +
    'worker, validator, reviewer, documenter, architect, debugger, project_manager.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Harness slug (use listHarnesses to find).' },
      role: { type: 'string', description: 'Agent role.' },
      message: { type: 'string', description: 'The first message to send the agent.' },
      featureId: { type: 'string', description: 'Optional feature/issue id (F-001, BRIEF-BRF-12).' },
    },
    required: ['slug', 'role', 'message'],
  },
};

// SHARED_TOOLS includes a generic dispatchToAgent — strip it and use Oracle's variant.
const SHARED_MINUS_DISPATCH = SHARED_TOOLS.filter((t) => t.name !== 'dispatchToAgent');
const TOOLS = [...ORACLE_ONLY_TOOLS, ORACLE_DISPATCH_TOOL, ...SHARED_MINUS_DISPATCH];

const server = new Server(
  { name: 'oracle', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Resources — see agent-resources-shared.mjs (shared with delegate).
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
    if (name === 'navigate') {
      const path = String(args?.path ?? '');
      if (!path.startsWith('/')) return errText('path must start with /');
      await pushUiCommand({ type: 'navigate', path });
      return text(`Navigation to ${path} dispatched.`);
    }

    if (name === 'resumeChat') {
      const slug = String(args?.slug ?? '').trim();
      const chatId = String(args?.chatId ?? '').trim();
      if (!slug || !chatId) return errText('slug and chatId required');
      const r = await fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`);
      if (!r.ok) return errText(`chat not found: HTTP ${r.status}`);
      const chat = await r.json();
      await pushUiCommand({
        type: 'openChat',
        slug,
        chatId,
        role: chat.role ?? 'agent',
        title: chat.title ?? chat.role,
        featureId: chat.feature_id ?? undefined,
      });
      return text(`Resuming chat ${chatId} (${chat.role}) in ${slug}; navigating now.`);
    }

    if (name === 'dispatchToAgent') {
      const result = await runDispatchToAgent(args, { base: BASE });
      if (result.error) return result.error;
      const { chat, slug, role, featureId } = result;
      await pushUiCommand({
        type: 'openChat',
        slug,
        chatId: chat.id,
        role,
        title: chat.title ?? (featureId ? `${role} · ${featureId}` : role),
        featureId,
      });
      return text(
        `Started chat ${chat.id} with ${role} in harness ${slug}; message dispatched. Navigating the user there.`,
      );
    }

    if (SHARED_TOOLS.some((t) => t.name === name)) {
      return await runSharedTool(name, args, { base: BASE });
    }

    return errText(`unknown tool: ${name}`);
  } catch (e) {
    return errText(`tool error: ${e?.message ?? String(e)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
