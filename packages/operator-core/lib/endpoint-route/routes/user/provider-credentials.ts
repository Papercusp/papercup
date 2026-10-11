/**
 * Settings → Integrations: pasted provider credentials (plan cupboard-distributable-integrations-
 * 2026-10-10 P-001; SPEC-R-2-P-001, SPEC-R-7-P-001).
 *
 * Thin HTTP over packages/operator-core/lib/integrations/provider-credentials.ts, which checks and
 * stores each value host-side. These routes never return a stored value: every response is the
 * per-field status (configured or not, and when it was saved).
 *
 *   GET    /user/integrations/providers/:providerId/credentials        each declared field's status
 *   PUT    /user/integrations/providers/:providerId/credentials        { values: { key: value } } — all or nothing
 *   DELETE /user/integrations/providers/:providerId/credentials/:key   forget one value
 *
 * Values are stored under the harness the provider's sources read their tokens from
 * (DEFAULT_SOURCE_TOKEN_HARNESS), the same one the OAuth connect link writes. Every write
 * invalidates `integrations.tickets`, whose provider summaries carry the same status.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../../../external-triggers/source-store';
import { ProviderRegistryNotReadyError, readyProviderRegistry, type RegisteredProvider } from '../../../integrations/provider-registry';
import {
  clearProviderCredential,
  providerCredentialStatus,
  saveProviderCredentials,
  ProviderCredentialError,
  type ProviderCredentialErrorCode,
} from '../../../integrations/provider-credentials';
import { TICKET_INTEGRATIONS_QUERY } from './ticket-integrations';

const STATUS_BY_CODE: Record<ProviderCredentialErrorCode, number> = {
  'no-credential-fields': 409,
  'unknown-field': 404,
  'invalid-value': 422,
  'empty-request': 400,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

class RouteRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A named refusal maps to its status. The error text never carries a submitted value. */
function failure(error: unknown): Response {
  if (error instanceof ProviderCredentialError) {
    return Response.json(
      { ok: false, error: error.code, detail: error.message, ...(error.field ? { field: error.field } : {}) },
      { status: STATUS_BY_CODE[error.code] },
    );
  }
  if (error instanceof RouteRefusal) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.status });
  }
  if (error instanceof ProviderRegistryNotReadyError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: 503 });
  }
  return Response.json({ ok: false, error: 'provider_credentials_failed', detail: 'the credential store could not be read or written' }, { status: 500 });
}

async function provider(providerId: string | undefined): Promise<RegisteredProvider> {
  const entry = providerId ? (await readyProviderRegistry()).get(providerId) : undefined;
  if (!entry) throw new RouteRefusal('unknown_provider', `no provider "${providerId ?? ''}" is installed`, 404);
  return entry;
}

async function invalidate(req: Request): Promise<void> {
  const user = await getSessionUserOrDefault(req.headers).catch(() => null);
  if (user) void notifySyncInvalidate(TICKET_INTEGRATIONS_QUERY, { workspaceId: activeWorkspaceId(), userId: user.id }).catch(() => {});
  void notifySyncInvalidate(TICKET_INTEGRATIONS_QUERY).catch(() => {});
}

const status = defineTool({
  method: 'GET',
  path: '/user/integrations/providers/:providerId/credentials',
  auth: 'loopback',
  async handler(_req, ctx) {
    try {
      const entry = await provider(ctx.params.providerId);
      const credentials = await providerCredentialStatus(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS);
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials });
    } catch (error) {
      return failure(error);
    }
  },
});

const save = defineTool({
  method: 'PUT',
  path: '/user/integrations/providers/:providerId/credentials',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await req.json().catch(() => null);
    if (!isPlainObject(body) || !isPlainObject(body.values)) {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be { values: { <field>: <value> } }' }, { status: 400 });
    }
    try {
      const entry = await provider(ctx.params.providerId);
      const credentials = await saveProviderCredentials(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, body.values);
      await invalidate(req);
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials });
    } catch (error) {
      return failure(error);
    }
  },
});

const clear = defineTool({
  method: 'DELETE',
  path: '/user/integrations/providers/:providerId/credentials/:key',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    try {
      const entry = await provider(ctx.params.providerId);
      const credentials = await clearProviderCredential(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, ctx.params.key ?? '');
      await invalidate(req);
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials });
    } catch (error) {
      return failure(error);
    }
  },
});

export default [status, save, clear];
