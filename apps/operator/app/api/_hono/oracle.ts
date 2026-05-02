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
const ORACLE_DIR = papercuspPath('oracle');
const PROMPT_PATH = join(ORACLE_DIR, 'prompt.md');
const MEMORY_PATH = join(ORACLE_DIR, 'memory.md');
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
      'Explain: this is the home base. A *harness* is a project with a crew of role-scoped agents (architect, orchestrator, worker, validator, plan-gate, documenter, debugger, project_manager). From here they pick an existing harness or create a new one. Mention they can spin one up from a marketplace template later in the tour.',
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

async function ensureDefaults() {
  await fs.mkdir(ORACLE_DIR, { recursive: true, mode: 0o700 });
  for (const [path, content] of [
    [PROMPT_PATH, DEFAULT_PROMPT],
    [MEMORY_PATH, DEFAULT_MEMORY],
  ] as const) {
    try { await fs.access(path); }
    catch { await fs.writeFile(path, content, { mode: 0o600 }); }
  }
}

async function readConfig() {
  await ensureDefaults();
  const [prompt, memory] = await Promise.all([
    fs.readFile(PROMPT_PATH, 'utf8'),
    fs.readFile(MEMORY_PATH, 'utf8'),
  ]);
  return { prompt, memory, prompt_path: PROMPT_PATH, memory_path: MEMORY_PATH };
}

export function registerOracle(app: Hono) {
  app.get('/oracle/config', async (c) => c.json(await readConfig()));

  app.put('/oracle/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await ensureDefaults();
    if (typeof body.prompt === 'string') {
      await fs.writeFile(PROMPT_PATH, body.prompt, { mode: 0o600 });
    }
    if (typeof body.memory === 'string') {
      await fs.writeFile(MEMORY_PATH, body.memory, { mode: 0o600 });
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
      `  - mcp__oracle__dispatchToAgent({ slug, role, message, featureId? }): start a chat with a role-scoped agent in a harness and send the first message. Roles include architect, orchestrator, scoper, worker, validator, plan-gate, documenter, debugger, project_manager. The user is auto-navigated to the harness and the chat opens. Use when the user says things like "ask the architect to ..." or "have the orchestrator do ...".\n` +
      `  - mcp__oracle__listChats({ slug, role? }): list recent chats in a harness (id, role, title, message_count, updated_at), optionally filtered by role. Use before resumeChat to find a chatId, or to answer "what chats have I had with X".\n` +
      `  - mcp__oracle__resumeChat({ slug, chatId }): re-open an existing chat (use listChats to discover the id).\n`;

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
        const stream = runClaudeChat({
          promptText,
          mcpConfig: {
            mcpServers: {
              oracle: {
                command: 'node',
                args: [MCP_SERVER_PATH],
                env: { ORACLE_SESSION_ID: sessionId, ORACLE_BASE: oracleBase },
              },
            },
          },
          allowedTools: [
            'mcp__oracle__navigate',
            'mcp__oracle__listHarnesses',
            'mcp__oracle__dispatchToAgent',
            'mcp__oracle__getHarnessStatus',
            'mcp__oracle__listChats',
            'mcp__oracle__resumeChat',
          ],
          // Strip the mcp__oracle__ prefix when surfacing tool_call events,
          // so the dock shows "navigate" / "listHarnesses" rather than the
          // full MCP-mangled name.
          toolEventFilter: (raw) =>
            raw.startsWith('mcp__oracle__') ? raw.replace(/^mcp__oracle__/, '') : null,
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
