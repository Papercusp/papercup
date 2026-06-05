/**
 * /api/oracle/* — the global "Oracle" assistant. Phase A1
 * (endpoint-hono-elimination-2026-05-21). Ported off `_hono/oracle.ts`
 * (mounted via `registerOracle`). URLs unchanged.
 *
 *   GET  /api/oracle/config
 *   PUT  /api/oracle/config   body: { prompt?, memory? }
 *   POST /api/oracle/chat     body: { messages: [...] }  → SSE stream
 *
 * The legacy router gated `/oracle/*` with a Hono middleware that 404s
 * when `FLAGS.ORACLE` is off (V1 ship-state gate). `defineTool` has no
 * per-prefix middleware, so each handler runs `oracleEnabled()` first —
 * same behavior, no shared middleware.
 *
 * `auth: 'public'` — the legacy router gated only on the flag.
 */
import { sseResponse } from '@papercusp/sse';
import { dispatchProjectedToolStream, lookupByMcpName } from '@papercusp/agent-mcp';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readOracleConfig, writeOracleConfig } from '../../../agent-tools/oracle/prompts';
import { getSessionUserOrDefault } from '../../../auth';
import '../../../agent-tools/index';

/** V1 ship-state gate — Oracle is dark unless `FLAGS.ORACLE` is on. */
async function oracleEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.ORACLE, 'system');
}

const NOT_FOUND = () => new Response(null, { status: 404 });

const configGet = defineTool({
  method: 'GET',
  path: '/oracle/config',
  auth: 'public',
  async handler() {
    if (!(await oracleEnabled())) return NOT_FOUND();
    return Response.json(await readOracleConfig());
  },
});

const configPut = defineTool({
  method: 'PUT',
  path: '/oracle/config',
  auth: 'public',
  async handler(req) {
    if (!(await oracleEnabled())) return NOT_FOUND();
    const body = await req.json().catch(() => ({}));
    if (typeof body.prompt === 'string' || typeof body.memory === 'string') {
      await writeOracleConfig({
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        memory: typeof body.memory === 'string' ? body.memory : undefined,
      });
    }
    return Response.json(await readOracleConfig());
  },
});

const chat = defineTool({
  method: 'POST',
  path: '/oracle/chat',
  auth: 'public',
  // Pure SSE transport — don't flood route_invocations per chat turn.
  sampleRate: 0,
  async handler(req) {
    if (!(await oracleEnabled())) return NOT_FOUND();
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return Response.json({ error: 'messages required' }, { status: 400 });
    }

    // Resolve the session user (or seeded `default`) so mem0 dual-scope
    // memory injection inside composeOraclePrompt has a userId.
    let userId: string | undefined;
    try {
      userId = (await getSessionUserOrDefault()).id;
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
      return Response.json({ error: 'oracle:chat tool not registered' }, { status: 500 });
    }

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        const dispatchCtx = {
          workspaceId: activeWorkspaceId(),
          harnessSlug: undefined,
          role: 'operator' as const,
          runId: globalThis.crypto.randomUUID(),
          spawnId: 'oracle-shim',
          log: () => { /* */ },
          progress: () => { /* */ },
          emit: () => { /* overridden by dispatcher */ },
          signal: req.signal,
          spawn: async () => { throw new Error('spawn not available in oracle shim'); },
          secret: async () => null,
          projectDir: '',
          stateDir: '',
        };

        for await (const ev of dispatchProjectedToolStream(
          tool,
          'oracle:chat',
          input,
          dispatchCtx as never,
          {},
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
          } else if (ev.kind === 'done' && ev.result) {
            sink.event('done', ev.result.content);
          }
        }
        // A chat turn is finite — close so the consumer's reader returns
        // { done: true } instead of hanging on heartbeats (round-10 regression).
        sink.close();
      },
    });
  },
});

export default [configGet, configPut, chat];
