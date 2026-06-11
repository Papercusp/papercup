/**
 * GET / POST /api/agent-config
 *
 * GET  — saved AgentConfig + detected binary paths + the backend that
 *        would actually be used now (after env-var fallbacks).
 * POST — replace AgentConfig (full body). Mirrors into process.env so
 *        subsequent spawns pick it up immediately.
 *
 * Ported from app/api/agent-config/route.ts. `auth: 'public'` preserves
 * the original (un-authed) behavior.
 */
import { readAgentConfig, writeAgentConfig, effectiveBackend, parseBackends, parseSurfaceModels, type AgentConfig } from '../../../agent-config';
import { detectBinaries } from '../../../agent-bin-detect';
import { defineTool } from '@papercusp/agent-mcp';

export default [
  defineTool({
    method: 'GET',
    path: '/agent-config',
    auth: 'public',
    async handler() {
      const cfg = await readAgentConfig();
      return Response.json({
        config: cfg,
        binaries: detectBinaries(),
        effectiveBackend: effectiveBackend(cfg),
        envOverrides: {
          AGENT_BACKEND: process.env.AGENT_BACKEND ?? null,
          AGENT_CMD: process.env.AGENT_CMD ?? null,
          CLAUDE_CMD: process.env.CLAUDE_CMD ?? null,
        },
      });
    },
  }),
  defineTool({
    method: 'POST',
    path: '/agent-config',
    auth: 'loopback',
    async handler(req) {
      const body = (await req.json().catch(() => null)) as Partial<AgentConfig> | null;
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const next: AgentConfig = {
        backend:
          body.backend === 'claude-code' || body.backend === 'omp' || body.backend === 'codex'
            ? body.backend
            : 'auto',
        cmd: typeof body.cmd === 'string' ? body.cmd : '',
        models:
          body.models && typeof body.models === 'object' && !Array.isArray(body.models)
            ? Object.fromEntries(
                Object.entries(body.models)
                  .filter(
                    ([k, v]) => typeof k === 'string' && typeof v === 'string' && v.trim(),
                  )
                  .map(([k, v]) => [k, (v as string).trim()]),
              )
            : {},
        backends: parseBackends(body.backends),
        surfaceModels: parseSurfaceModels(body.surfaceModels),
      };
      await writeAgentConfig(next);
      return Response.json({
        config: next,
        binaries: detectBinaries(),
        effectiveBackend: effectiveBackend(next),
      });
    },
  }),
];
