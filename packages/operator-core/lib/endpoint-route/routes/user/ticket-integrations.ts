/**
 * Settings → Integrations: ticket providers (plan linear-asana-task-sync-2026-10-05 P-007, D-014).
 *
 * Thin HTTP over packages/operator-core/lib/integrations/ticket-integrations.ts, which owns every
 * read and write and scopes each one to a source the signed-in owner holds. Connecting a provider
 * is the existing `/api/oauth/start` flow (the overview hands back its link); these routes only
 * read the page and configure what is already connected.
 *
 *   GET    /user/integrations/tickets                                    providers + the owner's sources
 *   POST   /user/integrations/tickets/sources/:sourceId/containers       teams/projects for the pickers
 *   PATCH  /user/integrations/tickets/sources/:sourceId/config           merge + validate + make due
 *   POST   /user/integrations/tickets/sources/:sourceId/rules            add a preset rule (+ backfill)
 *   DELETE /user/integrations/tickets/sources/:sourceId/rules/:ruleId    disable a rule
 *
 * Every write invalidates `integrations.tickets` so an open page refetches.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { ProviderCapabilityUnsupported } from '../../../capability-verbs/provider-dispatch';
import {
  disableTicketSourceRule,
  listTicketSourceContainers,
  setTicketSourceConfig,
  setTicketSourceRule,
  ticketIntegrationsOverview,
  TicketIntegrationError,
} from '../../../integrations/ticket-integrations';

export const TICKET_INTEGRATIONS_QUERY = 'integrations.tickets';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

async function jsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return isPlainObject(body) ? body : null;
}

const badBody = () => Response.json({ ok: false, error: 'bad_request', detail: 'body must be a JSON object' }, { status: 400 });

/** A refusal the module named maps to its status; anything else is a 502 from the provider or a 500. */
function failure(error: unknown): Response {
  if (error instanceof TicketIntegrationError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.status });
  }
  if (error instanceof ProviderCapabilityUnsupported) {
    return Response.json({ ok: false, error: 'provider_capability_unsupported', detail: error.message }, { status: 409 });
  }
  const kind = isPlainObject(error) && typeof error.kind === 'string' ? error.kind : null;
  const detail = error instanceof Error ? error.message : String(error);
  // A provider signal (auth, rate-limited, transient) is the provider's answer, not our fault.
  if (kind) return Response.json({ ok: false, error: `provider_${kind}`, detail }, { status: kind === 'auth' ? 401 : 502 });
  return Response.json({ ok: false, error: 'ticket_integrations_failed', detail }, { status: 500 });
}

async function scope(req: Request) {
  const user = await getSessionUserOrDefault(req.headers);
  return { workspaceId: activeWorkspaceId(), ownerUserId: user.id };
}

function invalidate(workspaceId: string, ownerUserId: string): void {
  void notifySyncInvalidate(TICKET_INTEGRATIONS_QUERY, { workspaceId, userId: ownerUserId }).catch(() => {});
  void notifySyncInvalidate(TICKET_INTEGRATIONS_QUERY).catch(() => {});
}

const overview = defineTool({
  method: 'GET',
  path: '/user/integrations/tickets',
  auth: 'loopback',
  async handler(req) {
    try {
      const s = await scope(req);
      // `userId` is the identity every route here resolves, so the page subscribes the
      // `integrations.tickets` sync query as the same user its writes act for.
      return Response.json({ ok: true, userId: s.ownerUserId, ...(await ticketIntegrationsOverview(getOrgPg().sql, s)) });
    } catch (error) {
      return failure(error);
    }
  },
});

const containers = defineTool({
  method: 'POST',
  path: '/user/integrations/tickets/sources/:sourceId/containers',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = (await jsonObject(req)) ?? {};
    const args = isPlainObject(body.args) ? body.args : {};
    try {
      const s = await scope(req);
      return Response.json({ ok: true, ...(await listTicketSourceContainers(getOrgPg().sql, { ...s, sourceId: ctx.params.sourceId ?? '', args })) });
    } catch (error) {
      return failure(error);
    }
  },
});

const config = defineTool({
  method: 'PATCH',
  path: '/user/integrations/tickets/sources/:sourceId/config',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await jsonObject(req);
    if (!body || !isPlainObject(body.patch)) return badBody();
    try {
      const s = await scope(req);
      const result = await setTicketSourceConfig(getOrgPg().sql, { ...s, sourceId: ctx.params.sourceId ?? '', patch: body.patch });
      invalidate(s.workspaceId, s.ownerUserId);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      return failure(error);
    }
  },
});

const addRule = defineTool({
  method: 'POST',
  path: '/user/integrations/tickets/sources/:sourceId/rules',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await jsonObject(req);
    if (!body) return badBody();
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    try {
      const s = await scope(req);
      const result = await setTicketSourceRule(getOrgPg().sql, {
        ...s,
        sourceId: ctx.params.sourceId ?? '',
        preset: text(body.preset) ?? '',
        value: text(body.value),
        harness: text(body.harness) ?? '',
        workKind: text(body.workKind),
        createdBy: `owner:${s.ownerUserId}`,
      });
      invalidate(s.workspaceId, s.ownerUserId);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      return failure(error);
    }
  },
});

const disableRule = defineTool({
  method: 'DELETE',
  path: '/user/integrations/tickets/sources/:sourceId/rules/:ruleId',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    try {
      const s = await scope(req);
      const rule = await disableTicketSourceRule(getOrgPg().sql, {
        ...s,
        sourceId: ctx.params.sourceId ?? '',
        ruleId: ctx.params.ruleId ?? '',
      });
      invalidate(s.workspaceId, s.ownerUserId);
      return Response.json({ ok: true, rule });
    } catch (error) {
      return failure(error);
    }
  },
});

export default [overview, containers, config, addRule, disableRule];
