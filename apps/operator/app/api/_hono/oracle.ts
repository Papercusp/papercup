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
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ORACLE_DIR = join(homedir(), '.papercusp', 'oracle');
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

    const promptText = [
      prompt.trim(),
      toolBlock,
      ctxBlock,
      memory.trim() ? `\n---\n\n## Persistent memory\n\n${memory.trim()}\n` : '',
      history ? `\n---\n\n## Conversation history\n\n${history}\n` : '',
      `\n---\n\n## User\n\n${userContent}\n`,
    ].join('');

    return streamSSE(c, async (sseStream) => {
      const claudeCmd = process.env.CLAUDE_CMD ?? 'claude';
      const sessionId = randomUUID();
      const oracleBase = process.env.ORACLE_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;

      const mcpConfig = JSON.stringify({
        mcpServers: {
          oracle: {
            command: 'node',
            args: [MCP_SERVER_PATH],
            env: { ORACLE_SESSION_ID: sessionId, ORACLE_BASE: oracleBase },
          },
        },
      });

      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--mcp-config', mcpConfig,
        '--allowed-tools', 'mcp__oracle__navigate mcp__oracle__listHarnesses mcp__oracle__dispatchToAgent mcp__oracle__getHarnessStatus mcp__oracle__listChats mcp__oracle__resumeChat',
        '--permission-mode', 'bypassPermissions',
      ];
      const child = spawn(claudeCmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderrBuf = '';
      let stdoutLineBuf = '';
      let costUsd = 0;

      // Track in-flight tool_use content blocks so we can pair the name
      // (from content_block_start) with the streamed input json
      // (input_json_delta) and emit one tool_call event per call when the
      // block stops.
      const liveTools = new Map<number, { name: string; input: string }>();

      const send = async (event: string, data: Record<string, unknown>) => {
        try { await sseStream.writeSSE({ event, data: JSON.stringify(data) }); }
        catch { /* client disconnected */ }
      };

      sessionEmitters.set(sessionId, (cmd) => { void send('ui_command', cmd); });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLineBuf += chunk.toString('utf8');
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
          const line = stdoutLineBuf.slice(0, nl).trim();
          stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            const inner = ev.type === 'stream_event' ? ev.event : ev;
            if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              void send('delta', { text: inner.delta.text ?? '' });
            } else if (
              inner?.type === 'content_block_start' &&
              inner.content_block?.type === 'tool_use' &&
              typeof inner.content_block.name === 'string' &&
              inner.content_block.name.startsWith('mcp__oracle__') &&
              typeof inner.index === 'number'
            ) {
              liveTools.set(inner.index, {
                name: inner.content_block.name.replace(/^mcp__oracle__/, ''),
                input: '',
              });
            } else if (
              inner?.type === 'content_block_delta' &&
              inner.delta?.type === 'input_json_delta' &&
              typeof inner.index === 'number' &&
              liveTools.has(inner.index)
            ) {
              const entry = liveTools.get(inner.index)!;
              entry.input += inner.delta.partial_json ?? '';
            } else if (
              inner?.type === 'content_block_stop' &&
              typeof inner.index === 'number' &&
              liveTools.has(inner.index)
            ) {
              const entry = liveTools.get(inner.index)!;
              liveTools.delete(inner.index);
              let parsed: unknown;
              try { parsed = entry.input ? JSON.parse(entry.input) : {}; } catch { parsed = entry.input; }
              void send('tool_call', { name: entry.name, input: parsed });
            } else if (ev.type === 'result') {
              if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
            }
          } catch { /* non-JSON */ }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

      child.stdin.write(promptText);
      child.stdin.end();

      const exitCode: number = await new Promise((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });

      sessionEmitters.delete(sessionId);

      if (exitCode !== 0) {
        await send('error', { message: `claude exited ${exitCode}`, stderr: stderrBuf.slice(-800) });
      } else {
        await send('done', { costUsd });
      }
      await sseStream.close();
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
