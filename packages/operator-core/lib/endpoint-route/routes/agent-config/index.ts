/**
 * GET / POST /api/agent-config
 *
 * GET  — saved AgentConfig + detected binary paths + the backend that
 *        would actually be used now (after env-var fallbacks).
 * POST — replace AgentConfig (full body). Mirrors into process.env so
 *        subsequent spawns pick it up immediately.
 *
 * POST is STRICT: if normalization would silently drop anything the body
 * asked to store (an invalid tier row, a dangling ceiling, an unknown
 * surface key), the request fails 422 with the reason instead of persisting
 * a gutted config. Silent normalization is how a transiently invalid edit
 * from /settings/agent used to delete stored settings — the saved config
 * looked fine until a reload re-hydrated the holes (owner bug 2026-06-11).
 * Reads stay lenient (readAgentConfig normalizes legacy rows).
 *
 * Ported from app/api/agent-config/route.ts. `auth: 'public'` preserves
 * the original (un-authed) behavior.
 */
import { readAgentConfig, writeAgentConfig, effectiveBackend, parseBackends, parseSurfaceModels, parseTiers, parseTierCeilings, type AgentConfig } from '../../../agent-config';
import { DEFAULT_MODEL_TIERS } from '../../../agent-config-constants';
import { detectBinaries } from '../../../agent-bin-detect';
import { defineTool } from '@papercusp/agent-mcp';
import { notifySyncInvalidate } from '../../../sync-sse';

export default [
  defineTool({
    method: 'GET',
    path: '/agent-config',
    auth: 'public',
    async handler() {
      const cfg = await readAgentConfig();
      const { listResumableSessions } = await import('../../../adv-sessions');
      const { readCodexHomeDiagnostics } = await import('../../../role-codex-home');
      const latestCodexSession = (await listResumableSessions(50)).find((s) => s.agent === 'codex') ?? null;
      return Response.json({
        config: cfg,
        // The committed default tier menu — the EFFECTIVE workspace baseline when
        // cfg.tiers is empty. Surfaced so the 👑-tab model-tier override editor
        // (queen-steering D-006) gets the baseline without a client-side
        // operator-core constant import. Additive; existing consumers ignore it.
        defaultTiers: DEFAULT_MODEL_TIERS,
        binaries: detectBinaries(),
        codexDiagnostics: latestCodexSession
          ? {
              sessionId: latestCodexSession.id,
              ownerId: latestCodexSession.coordOwnerId,
              startedAt: latestCodexSession.startedAt,
              endedAt: latestCodexSession.endedAt,
              home: readCodexHomeDiagnostics(latestCodexSession.id),
            }
          : null,
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
        tiers: parseTiers(body.tiers),
        tierCeilings: parseTierCeilings(body.tierCeilings, body.tiers),
      };
      // Strict-save guard: persisting LESS than the body asked for is silent
      // data loss, not normalization. Count the entries the parsers kept.
      const dropped: string[] = [];
      const sentCount = (v: unknown) =>
        Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
      if (body.models != null && sentCount(body.models) !== Object.keys(next.models).length) {
        dropped.push('models: every value must be a non-empty model id string');
      }
      if (body.backends != null && sentCount(body.backends) !== Object.keys(next.backends ?? {}).length) {
        dropped.push('backends: unknown surface key or backend');
      }
      if (body.surfaceModels != null && sentCount(body.surfaceModels) !== Object.keys(next.surfaceModels ?? {}).length) {
        dropped.push('surfaceModels: unknown surface key or empty model id');
      }
      if (body.tiers != null && sentCount(body.tiers) !== (next.tiers ?? []).length) {
        dropped.push('tiers: a row is invalid (needs a unique name and a <modelId>[:<effort>] spec)');
      }
      if (body.tierCeilings != null && sentCount(body.tierCeilings) !== Object.keys(next.tierCeilings ?? {}).length) {
        dropped.push('tierCeilings: a ceiling names a tier absent from the menu');
      }
      if (dropped.length > 0) {
        return Response.json(
          { error: `config rejected — would silently drop: ${dropped.join('; ')}`, dropped },
          { status: 422 },
        );
      }
      await writeAgentConfig(next);
      void notifySyncInvalidate('agentConfig.modelTiersBaseline', {}).catch(() => {});
      return Response.json({
        config: next,
        binaries: detectBinaries(),
        effectiveBackend: effectiveBackend(next),
      });
    },
  }),
];
