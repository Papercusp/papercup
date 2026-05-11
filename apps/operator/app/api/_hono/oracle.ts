/**
 * /api/oracle/* — global "Oracle" assistant.
 *
 * The Oracle is an app-wide concierge agent (always-mounted dock). Unlike
 * the per-harness role agents in agent-chats.ts, Oracle config lives at
 * user scope under `~/.papercusp/oracle/`:
 *   - prompt.md  — the system prompt the user can edit
 *   - memory.md  — persistent notes Oracle should keep in mind
 *
 * Endpoints:
 *   GET  /oracle/config              → { prompt, memory, prompt_path, memory_path }
 *   PUT  /oracle/config              body: { prompt?, memory? } → same shape
 *   POST /oracle/chat                body: { messages: [{role, content}] } → SSE stream
 *
 * Phase 1 (this file): pure text completion. No tool calls yet.
 * Phase 2: a tool-call channel (navigate, dispatchToAgent, ...) layered on top.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { papercuspPath } from '@/lib/papercusp-root';
import { runClaudeChat } from '@/lib/claude-chat-stream';
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';
import { listAgentsAcrossWorkspace } from '@/lib/agents-list';
import { activeWorkspaceId } from '@/lib/workspace-registry';
// Oracle prompt + memory now PG-backed (migration 024). Display paths kept
// for legacy callers that surfaced them in the settings UI.
const ORACLE_PROMPT_TABLE = 'harness_shared.operator_oracle_prompt';
const ORACLE_MEMORY_TABLE = 'harness_shared.operator_oracle_memory';
const MCP_SERVER_PATH = join(process.cwd(), 'lib', 'oracle-mcp-server.mjs');

/**
 * Per-chat-request bridge between the spawned MCP server (separate process)
 * and the SSE stream back to the dock. The MCP server pushes UI commands
 * via POST /oracle/sessions/:id/ui-command; that handler looks up the
 * emitter here and forwards to the browser.
 */
type UiCommand =
  | { type: 'navigate'; path: string }
  | { type: 'openChat'; slug: string; chatId: string; role: string; title?: string; featureId?: string };
const sessionEmitters = new Map<string, (cmd: UiCommand) => void>();

const DEFAULT_PROMPT = `You are the Oracle — Papercusp's built-in concierge assistant.

You know everything about how this app works (operator at :3055: harnesses,
agents, snapshots, plugins, marketplace, settings) and you help the user
get things done. Be concise, friendly, and direct.

You have access to tools that let you act on the user's behalf:
  - mcp__oracle__navigate(path): take the user to a path within the app.
    Use it when the user asks you to go somewhere, or when an action
    requires being on a specific page.

When the user asks you to take them to a page, call navigate immediately,
then briefly tell them where you went. If the user asks for something
that needs a tool you don't yet have, describe what you'd do and which
agent or page is involved.

If the user asks about their own setup, don't fabricate state — say "I'd
need to check" if you don't know.
`;

interface TutorialStep {
  id: string;
  navigate: string | null;
  pre?: string;
  body: string;
  closer: string;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'greeting',
    navigate: null,
    body:
      'Greet the user. In two short sentences tell them: Papercusp is an autonomous-harness framework where multi-agent crews ("harnesses") build features for them, and you\'ll show them around in 6 stops.',
    closer: 'Ask: "Ready? Say **next** when you are."',
  },
  {
    id: 'harness-list',
    navigate: '/harness',
    body:
      'Explain: this is the home base. A *harness* is a project with a crew of role-scoped agents (architect, orchestrator, worker, validator, reviewer, documenter, debugger, project_manager). From here they pick an existing harness or create a new one. Mention they can spin one up from a marketplace template later in the tour.',
    closer: 'End with: "Say **next** to continue, or **stop** to exit."',
  },
  {
    id: 'harness-console',
    pre:
      'Call `mcp__oracle__listHarnesses` first. Pick the first slug from the result. If the result is empty, stay on `/harness` instead and tell them they\'ll see the per-harness console once they create one.',
    navigate: '/harness/<first-slug-or-/harness>',
    body:
      'Inside a harness, point out: the feature list (work the crew is doing), the agent chat dock (talk to any role on the crew), and the panel tabs (Snapshots, Decisions, Memory, Hooks, Usage, Tests).',
    closer: 'End with: "Say **next** to continue, or **stop** to exit."',
  },
  {
    id: 'marketplace-templates',
    navigate: '/marketplace/templates',
    body:
      'Explain: starter harnesses they can clone. Each comes pre-wired with a SPEC, agent roster, and plugins. Clicking one brings up an install flow that creates a local harness on their machine.',
    closer: 'End with: "Say **next** to continue, or **stop** to exit."',
  },
  {
    id: 'marketplace-plugins',
    navigate: '/marketplace/plugins',
    body:
      'Explain: plugins extend a harness with capabilities — publishing to Cloudflare Pages, syncing Linear issues, custom UI panels, lifecycle hooks. Plugins are enabled per harness and can ship their own UI tabs that appear inside the harness console.',
    closer: 'End with: "Say **next** to continue, or **stop** to exit."',
  },
  {
    id: 'snapshots',
    navigate: '/snapshots',
    body:
      'Explain: a snapshot freezes a harness\'s full state (spec, code, history) into a portable artifact they can publish to the marketplace or fork later. This is how work travels between harnesses and machines.',
    closer: 'End with: "Say **next** to continue, or **stop** to exit."',
  },
  {
    id: 'settings-oracle',
    navigate: '/settings/oracle',
    body:
      'Explain: this is where they teach *you* (the Oracle) about their workflow. The prompt and memory shown here are loaded into every conversation, so editing them changes how you respond across the whole app.',
    closer: 'End with: "Say **next** for the wrap-up."',
  },
  {
    id: 'wrap',
    navigate: null,
    body:
      'Tell them the tour is done. Mention they can re-open it any time from the **Tutorial** button in the top nav. Offer to (a) take them back to `/harness` to start working, or (b) answer any question.',
    closer: 'Wait for their answer. If they pick (a), call `navigate` with `/harness`.',
  },
];

function buildTutorialBlock(stepIndex: number, lastUser: string): string {
  const stop = /^(stop|exit|end|skip|that'?s enough|no thanks|quit)\b/i.test(lastUser.trim());
  const idx = stop ? TUTORIAL_STEPS.length - 1 : Math.min(stepIndex, TUTORIAL_STEPS.length - 1);
  const step = TUTORIAL_STEPS[idx];
  const navLine = step.navigate
    ? `1. Call \`mcp__oracle__navigate\` with path \`${step.navigate}\` (skip the call if the user is already on that path).\n`
    : '1. Do not navigate this turn.\n';
  const preLine = step.pre ? `0. ${step.pre}\n` : '';
  return `

---

## Tutorial mode — Step ${idx + 1} of ${TUTORIAL_STEPS.length} (${step.id})

You are running a hardcoded walkthrough of Papercusp. **Do exactly the
step below — do not split it, do not skip it, do not invent extra
sub-steps.** One navigate call, then 2–4 plain sentences, then the
closer. No emoji, no marketing prose, no bullet lists.

${preLine}${navLine}2. Then write 2–4 short sentences: ${step.body}
3. ${step.closer}

If the user asked a question instead of saying "next", answer it briefly
in one sentence and then re-prompt with the closer above. Do not
dispatch to agents during the tour.
`;
}


const DEFAULT_MEMORY = `# Oracle memory

Add notes here you want the Oracle to keep in mind across conversations.
Examples:
- Preferred default project location
- Names of teammates / agents you collaborate with
- Conventions specific to your workflow
`;

/**
 * Workspace-at-a-glance block injected into the Oracle's prompt every
 * turn. Saves a round-trip on the most common questions ("what
 * harnesses do I have", "who's working on X").
 *
 * Stays small — top 6 harnesses + top 8 active agents. The Oracle
 * still has listHarnesses / listAgents / getHarnessStatus tools for
 * deeper queries.
 */
async function buildWorkspaceInventoryBlock(): Promise<string> {
  const workspace = activeWorkspaceId();
  const port = process.env.PORT ?? '3055';
  const base = process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
  let projects: Array<{ slug: string; path: string }> = [];
  try {
    const r = await fetch(`${base}/api/harness/projects`);
    if (r.ok) {
      const d = await r.json();
      projects = (d?.projects ?? []).map((p: any) => ({ slug: p.slug, path: p.path }));
    }
  } catch { /* degraded */ }

  let agents: Array<{ slug: string; role: string; chat_count: number; last_active: string | null }> = [];
  try { agents = await listAgentsAcrossWorkspace({ limit: 8 }); } catch { /* degraded */ }

  if (!projects.length && !agents.length) return '';

  const projectLines = projects.slice(0, 6).map((p) => `  - ${p.slug}`);
  const agentLines = agents.map((a) => {
    const ago = a.last_active ? `${Math.round((Date.now() - new Date(a.last_active).getTime()) / 60000)}m ago` : 'idle';
    return `  - ${a.slug}/${a.role} (${a.chat_count} chats, ${ago})`;
  });

  return [
    '\n\n## Workspace at a glance',
    `\nWorkspace: ${workspace}`,
    projectLines.length ? `\nHarnesses (${projects.length}${projects.length > 6 ? ', showing 6' : ''}):\n${projectLines.join('\n')}` : '',
    agentLines.length ? `\nMost-active agents:\n${agentLines.join('\n')}` : '',
    '\n\nThis is a snapshot. For deeper info call listHarnesses / listAgents / getHarnessStatus.',
  ].join('');
}

async function ensureDefaults() {
  // Initialize the two PG rows with default content if missing.
  for (const [table, content] of [
    ['operator_oracle_prompt', DEFAULT_PROMPT],
    ['operator_oracle_memory', DEFAULT_MEMORY],
  ] as const) {
    const existing = await readOperatorState<{ content?: string }>(table);
    if (existing && typeof existing.content === 'string') continue;
    await writeOperatorState(table, { content });
  }
}

async function readConfig() {
  await ensureDefaults();
  const [pRow, mRow] = await Promise.all([
    readOperatorState<{ content?: string }>('operator_oracle_prompt'),
    readOperatorState<{ content?: string }>('operator_oracle_memory'),
  ]);
  return {
    prompt: pRow?.content ?? '',
    memory: mRow?.content ?? '',
    prompt_path: ORACLE_PROMPT_TABLE,
    memory_path: ORACLE_MEMORY_TABLE,
  };
}

export function registerOracle(app: Hono) {
  app.get('/oracle/config', async (c) => c.json(await readConfig()));

  app.put('/oracle/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.prompt === 'string') {
      await writeOperatorState('operator_oracle_prompt', { content: body.prompt });
    }
    if (typeof body.memory === 'string') {
      await writeOperatorState('operator_oracle_memory', { content: body.memory });
    }
    return c.json(await readConfig());
  });

  app.post('/oracle/chat', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return c.json({ error: 'messages required' }, 400);
    const currentPath = typeof body.currentPath === 'string' ? body.currentPath : '';
    const tutorialMode = body.tutorialMode === true;

    const { prompt, memory } = await readConfig();

    const history = messages
      .slice(0, -1)
      .map((m: any) => `${m.role === 'user' ? 'User' : 'You (assistant)'}: ${m.content}`)
      .join('\n\n');
    const last = messages[messages.length - 1];
    const userContent = typeof last?.content === 'string' ? last.content : '';

    const toolBlock = `\n\n## Tools available\n\n` +
      `  - mcp__oracle__navigate({ path }): navigate the user's browser to a path (e.g. "/harness", "/marketplace/templates"). Don't ask permission — just navigate and tell them where you went.\n` +
      `  - mcp__oracle__listHarnesses(): list all registered harnesses (slug, path, hasState, hasSpec). Use to answer "what harnesses do I have" or to look up a slug before navigating.\n` +
      `  - mcp__oracle__getHarnessStatus({ slug }): get the current state of a harness — feature counts by status, recent features, and a summary excerpt. Use for "what's the state of <slug>", "is X done", "what is X working on".\n` +
      `  - mcp__oracle__dispatchToAgent({ slug, role, message, featureId? }): start a chat with a role-scoped agent in a harness and send the first message. Roles include architect, orchestrator, scoper, worker, validator, reviewer, documenter, debugger, project_manager. The user is auto-navigated to the harness and the chat opens. Use when the user says things like "ask the architect to ..." or "have the orchestrator do ...".\n` +
      `  - mcp__oracle__listChats({ slug, role? }): list recent chats in a harness (id, role, title, message_count, updated_at), optionally filtered by role. Use before resumeChat to find a chatId, or to answer "what chats have I had with X".\n` +
      `  - mcp__oracle__listAgents({ slug? }): enumerate role-scoped agents with recent activity, optionally scoped to one harness. Returns [{slug, role, chat_count, last_active}]. Use to answer "which agents are working on X" or to pick the most-active matching role before dispatchToAgent.\n` +
      `  - mcp__oracle__resumeChat({ slug, chatId }): re-open an existing chat (use listChats to discover the id).\n`;

    // Auto-context: cheap workspace inventory the Oracle would
    // otherwise have to round-trip an MCP tool to get. Refreshed every
    // turn so the snapshot stays current; lookups are local PG / file
    // scans so cost is ~10-30ms.
    const inventoryBlock = await buildWorkspaceInventoryBlock().catch(() => '');

    const ctxBlock = currentPath
      ? `\n\n## Runtime context\n\nThe user is currently on path: ${currentPath}\n`
      : '';

    let tutorialBlock = '';
    let tutorialIsFinalStep = false;
    if (tutorialMode) {
      const userTurns = messages.filter((m: any) => m?.role === 'user').length;
      const stepIndex = Math.max(0, userTurns - 1);
      const stop = /^(stop|exit|end|skip|that'?s enough|no thanks|quit)\b/i.test(userContent.trim());
      tutorialBlock = buildTutorialBlock(stepIndex, userContent);
      tutorialIsFinalStep = stop || stepIndex >= TUTORIAL_STEPS.length - 1;
    }

    const promptText = [
      prompt.trim(),
      toolBlock,
      inventoryBlock,
      ctxBlock,
      tutorialBlock,
      memory.trim() ? `\n---\n\n## Persistent memory\n\n${memory.trim()}\n` : '',
      history ? `\n---\n\n## Conversation history\n\n${history}\n` : '',
      `\n---\n\n## User\n\n${userContent}\n`,
    ].join('');

    return streamSSE(c, async (sseStream) => {
      const sessionId = randomUUID();
      const oracleBase = process.env.ORACLE_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;

      const send = async (event: string, data: Record<string, unknown>) => {
        try { await sseStream.writeSSE({ event, data: JSON.stringify(data) }); }
        catch { /* client disconnected */ }
      };

      sessionEmitters.set(sessionId, (cmd) => { void send('ui_command', cmd); });

      if (tutorialIsFinalStep) {
        void send('tutorial_end', {});
      }

      let costUsd = 0;
      try {
        // Oracle gets two MCP servers:
        //   1. `oracle` — UI-routing tools (navigate, resumeChat,
        //      dispatchToAgent's UI side). Lives in lib/oracle-mcp-server.mjs.
        //   2. `agentmcp` — workspace-state reads (tasks, goals, harness
        //      status, audit, hindsight, search) shared with Operator and pi.
        //      Bearer is loaded from the system:oracle config file if
        //      provisioned; absent, agentmcp tools are simply unavailable.
        let oracleBearer: string | null = null;
        try {
          const { readSystemPrincipal } = await import('@/lib/system-principal');
          const p = await readSystemPrincipal('oracle');
          oracleBearer = p?.bearer ?? null;
        } catch {
          oracleBearer = null;
        }
        const agentMcpPath = join(
          process.cwd(),
          'packages/agent-mcp/src/server-entry.ts',
        );
        const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
        const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
          oracle: {
            command: 'node',
            args: [MCP_SERVER_PATH],
            env: { ORACLE_SESSION_ID: sessionId, ORACLE_BASE: oracleBase },
          },
        };
        if (oracleBearer) {
          mcpServers.agentmcp = {
            command: tsxBin,
            args: [agentMcpPath],
            env: {
              AGENT_MCP_BEARER: oracleBearer,
              OPERATOR_BASE_URL: oracleBase,
            },
          };
        }
        const allowedTools = [
          'mcp__oracle__navigate',
          'mcp__oracle__listHarnesses',
          'mcp__oracle__listAgents',
          'mcp__oracle__dispatchToAgent',
          'mcp__oracle__getHarnessStatus',
          'mcp__oracle__listChats',
          'mcp__oracle__resumeChat',
        ];
        if (oracleBearer) {
          allowedTools.push(
            'mcp__agentmcp__harness:list',
            'mcp__agentmcp__harness:get',
            'mcp__agentmcp__harness:status',
            'mcp__agentmcp__tasks:list',
            'mcp__agentmcp__tasks:get',
            'mcp__agentmcp__goals:list',
            'mcp__agentmcp__goals:get',
            'mcp__agentmcp__messages:inbox',
            'mcp__agentmcp__messages:outbox',
            'mcp__agentmcp__audit:list',
            'mcp__agentmcp__hindsight:recall',
            'mcp__agentmcp__search:query',
            // Tool introspection — so Oracle can answer "what can I call?"
            // honestly. Cheap, read-only.
            'mcp__agentmcp__agent_tools:list',
            // Agent ↔ UI surface — Oracle can read the user's tab state
            // and drive panels. ui:dispatch requires either ctx.uiClientId
            // (which Oracle currently does NOT pass — see TODO below) or
            // an explicit client_id arg from a prior ui:list_clients call.
            'mcp__agentmcp__ui:list_clients',
            'mcp__agentmcp__ui:get_state',
            'mcp__agentmcp__ui:dispatch',
            // TODO(ui-control): Oracle's MCP URL doesn't currently include
            // &client=<id>, so ctx.uiClientId is null and ui:get_state /
            // ui:dispatch require an explicit client_id arg. Adding it
            // means OracleDock has to pass the browser's clientId on every
            // chat request; planned for a follow-up.
          );
        }
        const stream = runClaudeChat({
          promptText,
          mcpConfig: { mcpServers },
          allowedTools,
          // Strip the mcp__<server>__ prefix when surfacing tool_call events,
          // so the dock shows "navigate" / "harness:list" rather than the
          // full MCP-mangled name.
          toolEventFilter: (raw) => {
            if (raw.startsWith('mcp__oracle__')) return raw.replace(/^mcp__oracle__/, '');
            if (raw.startsWith('mcp__agentmcp__')) return raw.replace(/^mcp__agentmcp__/, '');
            return null;
          },
          permissionMode: 'bypassPermissions',
        });

        for await (const ev of stream) {
          if (ev.type === 'delta') {
            await send('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            await send('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            costUsd = ev.costUsd;
            await send('done', { costUsd });
          } else if (ev.type === 'error') {
            await send('error', { message: ev.message, stderr: ev.stderr });
          }
        }
      } finally {
        sessionEmitters.delete(sessionId);
        await sseStream.close();
      }
    });
  });

  app.post('/oracle/sessions/:id/ui-command', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const emit = sessionEmitters.get(id);
    if (!emit) return c.json({ error: 'unknown or expired session' }, 404);
    if (body?.type === 'navigate' && typeof body.path === 'string') {
      emit({ type: 'navigate', path: body.path });
      return c.json({ ok: true });
    }
    if (
      body?.type === 'openChat' &&
      typeof body.slug === 'string' &&
      typeof body.chatId === 'string' &&
      typeof body.role === 'string'
    ) {
      emit({
        type: 'openChat',
        slug: body.slug,
        chatId: body.chatId,
        role: body.role,
        title: typeof body.title === 'string' ? body.title : undefined,
        featureId: typeof body.featureId === 'string' ? body.featureId : undefined,
      });
      return c.json({ ok: true });
    }
    return c.json({ error: 'invalid ui-command' }, 400);
  });
}
