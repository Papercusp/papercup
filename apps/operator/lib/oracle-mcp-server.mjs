#!/usr/bin/env node
/**
 * Oracle MCP server — exposes UI/server tools to claude -p.
 *
 * Spawned by the operator's /api/oracle/chat endpoint per-request with
 * `ORACLE_SESSION_ID` and `ORACLE_BASE` env vars. Each tool either
 * (a) does work directly and returns the result to claude, or
 * (b) forwards a UI command to the dock by POSTing to the operator's
 *     /api/oracle/sessions/:id/ui-command endpoint, which in turn relays
 *     the command to the connected browser via the chat's SSE stream.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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
    const text = await r.text().catch(() => '');
    throw new Error(`ui-command push failed: HTTP ${r.status} ${text}`);
  }
}

const TOOLS = [
  {
    name: 'navigate',
    description:
      'Navigate the user\'s browser to a path within the operator app. ' +
      'Use this when the user asks you to take them somewhere, or when an ' +
      'action requires the user to be on a specific page (e.g. /harness, ' +
      '/marketplace/templates, /settings/oracle). Returns immediately; the ' +
      'browser executes the navigation asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to navigate to, starting with /. Examples: "/harness", ' +
            '"/marketplace/plugins", "/settings/oracle".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'listHarnesses',
    description:
      'List harnesses registered on this machine (slug, path, whether they have state and a SPEC.md). ' +
      'Use to answer questions like "what harnesses do I have", or to find the right slug ' +
      'before navigating to /harness/<slug>.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'listChats',
    description:
      'List recent agent chats in a harness, optionally filtered by role. Returns id, role, ' +
      'title, feature_id, last-message timestamp, and message count for each. Use to find a chatId ' +
      'before calling resumeChat, or to answer "what chats have I had", "where did I leave off with the architect".',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Harness slug.' },
        role: { type: 'string', description: 'Optional role filter (architect, orchestrator, etc).' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'resumeChat',
    description:
      'Open an existing chat panel for the user (the chat they had earlier, identified by chatId). ' +
      'Use after listChats has surfaced a candidate id. Navigates the user to the harness dock and ' +
      'opens that chat tab.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Harness slug.' },
        chatId: { type: 'string', description: 'The id of an existing chat (use listChats to find).' },
      },
      required: ['slug', 'chatId'],
    },
  },
  {
    name: 'getHarnessStatus',
    description:
      'Get the current status of a harness: its summary (latest progress notes) plus a compact ' +
      'breakdown of features by status (passed/in-progress/failed/blocked). Use to answer ' +
      '"what\'s the state of <slug>", "is <slug> still running", "what is <slug> working on".',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Harness slug (use listHarnesses to find).' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'dispatchToAgent',
    description:
      'Start a new chat with a role-scoped agent in a specific harness, and send the agent a message ' +
      'on the user\'s behalf. The user is navigated to the harness dashboard and the chat panel opens ' +
      'automatically so they can watch the agent respond. Use this when the user asks you to "ask the architect ' +
      'to ...", "have the orchestrator do ...", etc. Common roles: architect, orchestrator, scoper, worker, ' +
      'validator, plan-gate, documenter, debugger, project_manager.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Harness slug (use listHarnesses to find).' },
        role: {
          type: 'string',
          description:
            'Agent role to chat with. One of: orchestrator, scoper, worker, validator, plan-gate, ' +
            'documenter, summarizer, architect, curator, debugger, crosscheck, ui-qa, project_manager, ' +
            'director, coordinator, auditor.',
        },
        message: { type: 'string', description: 'The first message to send the agent.' },
        featureId: {
          type: 'string',
          description: 'Optional feature/issue id to scope the chat to (e.g. F-001, BRIEF-BRF-12).',
        },
      },
      required: ['slug', 'role', 'message'],
    },
  },
];

const server = new Server(
  { name: 'oracle', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'navigate') {
      const path = String(args?.path ?? '');
      if (!path.startsWith('/')) {
        return { content: [{ type: 'text', text: `error: path must start with /` }], isError: true };
      }
      await pushUiCommand({ type: 'navigate', path });
      return { content: [{ type: 'text', text: `Navigation to ${path} dispatched.` }] };
    }
    if (name === 'listChats') {
      const slug = String(args?.slug ?? '').trim();
      if (!slug) return { content: [{ type: 'text', text: 'error: slug required' }], isError: true };
      const r = await fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats`);
      if (!r.ok) return { content: [{ type: 'text', text: `listChats failed: HTTP ${r.status}` }], isError: true };
      const d = await r.json();
      const wantRole = args?.role ? String(args.role).trim() : null;
      const chats = (Array.isArray(d?.chats) ? d.chats : [])
        .filter((c) => !wantRole || c.role === wantRole)
        .map((c) => ({
          id: c.id,
          role: c.role,
          title: c.title,
          feature_id: c.feature_id ?? null,
          message_count: Array.isArray(c.transcript) ? c.transcript.length : 0,
          updated_at: c.updated_at,
        }))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 20);
      return { content: [{ type: 'text', text: JSON.stringify(chats, null, 2) }] };
    }
    if (name === 'resumeChat') {
      const slug = String(args?.slug ?? '').trim();
      const chatId = String(args?.chatId ?? '').trim();
      if (!slug || !chatId) {
        return { content: [{ type: 'text', text: 'error: slug and chatId required' }], isError: true };
      }
      // Validate the chat exists so we don't navigate to an empty panel.
      const r = await fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`);
      if (!r.ok) return { content: [{ type: 'text', text: `chat not found: HTTP ${r.status}` }], isError: true };
      const chat = await r.json();
      await pushUiCommand({
        type: 'openChat',
        slug,
        chatId,
        role: chat.role ?? 'agent',
        title: chat.title ?? chat.role,
        featureId: chat.feature_id ?? undefined,
      });
      return {
        content: [{ type: 'text', text: `Resuming chat ${chatId} (${chat.role}) in ${slug}; navigating now.` }],
      };
    }
    if (name === 'getHarnessStatus') {
      const slug = String(args?.slug ?? '').trim();
      if (!slug) return { content: [{ type: 'text', text: 'error: slug required' }], isError: true };
      const [statusR, summaryR] = await Promise.all([
        fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`),
        fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/summary`),
      ]);
      if (!statusR.ok) {
        return { content: [{ type: 'text', text: `status fetch failed: HTTP ${statusR.status}` }], isError: true };
      }
      const status = await statusR.json();
      const summary = summaryR.ok ? await summaryR.json().catch(() => null) : null;
      const features = Array.isArray(status?.features) ? status.features : [];
      const counts = features.reduce((acc, f) => {
        const s = f?.status ?? 'unknown';
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      const result = {
        slug,
        path: status?.project?.path,
        feature_counts: counts,
        feature_total: features.length,
        recent_features: features.slice(-5).map((f) => ({ id: f.id, status: f.status, title: f.title })),
        summary_excerpt: typeof summary?.summary === 'string' ? summary.summary.slice(0, 1200) : null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'dispatchToAgent') {
      const slug = String(args?.slug ?? '').trim();
      const role = String(args?.role ?? '').trim();
      const message = String(args?.message ?? '').trim();
      const featureId = args?.featureId ? String(args.featureId).trim() : undefined;
      if (!slug || !role || !message) {
        return { content: [{ type: 'text', text: 'error: slug, role, and message are required' }], isError: true };
      }
      const createR = await fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, feature_id: featureId, title: featureId ? `${role} · ${featureId}` : role }),
      });
      if (!createR.ok) {
        const t = await createR.text().catch(() => '');
        return { content: [{ type: 'text', text: `failed to create chat: HTTP ${createR.status} ${t}` }], isError: true };
      }
      const chat = await createR.json();
      const chatId = chat.id;
      // Kick off the first message — fire-and-forget. The server-side
      // claude run will finish even if we don't read the SSE response;
      // the assistant's reply is persisted to the chat transcript and the
      // user's chat panel will load it on mount.
      fetch(`${BASE}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: message }),
      }).catch(() => {});
      await pushUiCommand({
        type: 'openChat',
        slug,
        chatId,
        role,
        title: chat.title ?? (featureId ? `${role} · ${featureId}` : role),
        featureId,
      });
      return {
        content: [{
          type: 'text',
          text: `Started chat ${chatId} with ${role} in harness ${slug}; message dispatched. Navigating the user there.`,
        }],
      };
    }
    if (name === 'listHarnesses') {
      const r = await fetch(`${BASE}/api/harness/projects`);
      if (!r.ok) {
        return { content: [{ type: 'text', text: `listHarnesses failed: HTTP ${r.status}` }], isError: true };
      }
      const d = await r.json();
      const summary = (d?.projects ?? []).map((p) => ({
        slug: p.slug,
        path: p.path,
        hasState: !!p.hasState,
        hasSpec: !!p.hasSpec,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `tool error: ${e?.message ?? String(e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
