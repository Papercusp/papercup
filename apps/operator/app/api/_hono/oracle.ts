/**
 * /api/oracle/* — global "Oracle" assistant.
 *
 * Thin Hono shim over the projected `oracle:chat` tool (registered via
 * apps/operator/lib/agent-tools/oracle/chat.ts side-effect import in
 * agent-tools/index.ts). Prompt assembly, MCP config build, system-
 * principal load, and superuser-token resolution all live in
 * `apps/operator/lib/agent-tools/oracle/prompts.ts` so the IPC fast-
 * path can call the tool directly without going through HTTP for
 * prompt composition.
 *
 * Endpoints:
 *   GET  /oracle/config              → { prompt, memory, prompt_path, memory_path }
 *   PUT  /oracle/config              body: { prompt?, memory? } → same shape
 *   POST /oracle/chat                body: { messages: [{role, content}] } → SSE stream
 *
 * The /chat route shim will be retired once consumers (OracleDock,
 * VoiceAppBridge, mobile-voice-dispatch) POST the projected URL
 * directly. Matches the T1.2 architect/brainstorm trajectory.
 */
import type { Hono } from 'hono';
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  lookupByMcpName,
} from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readOracleConfig, writeOracleConfig } from '@/lib/agent-tools/oracle/prompts';
import { getSessionUserOrDefault } from '@/lib/auth';
import '@/lib/agent-tools/index';

export function registerOracle(app: Hono) {
  // V1 ship-state gate: when FLAGS.ORACLE is off (default), all
  // /oracle/* endpoints return 404 — keeps Oracle backend dark for
  // production builds while preserving the route surface for dev.
  app.use('/oracle/*', async (c, next) => {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    const enabled = await getFlag(FLAGS.ORACLE, 'system');
    if (!enabled) return c.notFound();
    return next();
  });

  app.get('/oracle/config', async (c) => c.json(await readOracleConfig()));

  app.put('/oracle/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.prompt === 'string' || typeof body.memory === 'string') {
      await writeOracleConfig({
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        memory: typeof body.memory === 'string' ? body.memory : undefined,
      });
    }
    return c.json(await readOracleConfig());
  });

  app.post('/oracle/chat', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return c.json({ error: 'messages required' }, 400);

    // Resolve the session user (or fall through to seeded `default`) so
    // mem0 dual-scope memory injection inside composeOraclePrompt has
    // a userId to scope user-side memories with.
    let userId: string | undefined;
    try {
      const u = await getSessionUserOrDefault();
      userId = u.id;
    } catch {
      userId = undefined;
    }

    const input = {
      messages,
      currentPath: typeof body.currentPath === 'string' ? body.currentPath : '',
      tutorialMode: body.tutorialMode === true,
      uiClientId:
        typeof body.uiClientId === 'string' && body.uiClientId.length > 0
          ? body.uiClientId
          : undefined,
      userId,
    };

    const tool = lookupByMcpName('oracle:chat');
    if (!tool) {
      return c.json({ error: 'oracle:chat tool not registered' }, 500);
    }

    return sseResponse({
      signal: c.req.raw.signal,
      setup: async (sink) => {
        const ctx = {
          workspaceId: activeWorkspaceId(),
          harnessSlug: undefined,
          role: 'operator' as const,
          runId: `oracle-${Date.now()}`,
          spawnId: 'oracle-shim',
          log: () => { /* */ },
          progress: () => { /* */ },
          emit: () => { /* overridden by dispatcher */ },
          signal: c.req.raw.signal,
          // spawn/secret/projectDir/stateDir are unused for oracle:chat
          // (workspace-scoped, not harness-scoped) but UnifiedToolContext
          // requires them — fill with no-op stubs.
          spawn: async () => { throw new Error('spawn not available in oracle shim'); },
          secret: async () => null,
          projectDir: '',
          stateDir: '',
        };

        for await (const ev of dispatchProjectedToolStream(
          tool,
          'oracle:chat',
          input,
          ctx as never,
          undefined as never,
        )) {
          if (ev.kind === 'event') {
            const kind = tool.eventWireKinds?.[ev.name];
            if (kind === 'string') {
              sink.eventRaw(ev.name, ev.data as string);
            } else {
              sink.event(ev.name, ev.data as Record<string, unknown>);
            }
          } else if (ev.kind === 'error') {
            sink.event('error', { message: ev.error.message });
          }
          // ev.kind === 'done' — framework auto-emits event: done via sink
        }
      },
    });
  });
}
