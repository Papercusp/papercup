/**
 * Owner-facing Personal Vault HTTP projection.
 *
 * This is deliberately a thin projection over the canonical Personal Vault
 * store. The desktop never writes the vault tables directly: status, local
 * archive import, the kill switch, verified purge, and default-deny grants all
 * pass through the same invariants used by the agent tools.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { parsePlan } from '@papercusp/plan-parser';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { parsePersonalArchive } from '../../../personal-vault/archive-import';
import {
  disconnectOwnedExternalTriggerSources,
  listOwnedExternalTriggerSources,
  setOwnedExternalTriggerSourceCapability,
  type OwnedExternalTriggerSourceRow,
} from '../../../external-triggers/source-store';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  GOOGLE_WORKSPACE_SOURCE_KINDS,
  googleWorkspaceOAuthField,
} from '../../../external-triggers/google-workspace';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
  facebookPersonalVaultOAuthField,
} from '../../../external-triggers/facebook';
import {
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CONTACTS_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE,
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  getProvider,
  loadAndRegisterProvidersFromDisk,
} from '../../../oauth/providers';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import {
  isPersonalVaultEnabled,
  listPersonalGrants,
  personalScope,
  personalVaultStats,
  purgePersonalSource,
  replacePersonalGrant,
  revokePersonalGrant,
  setPersonalVaultEnabled,
  upsertPersonalDocuments,
} from '../../../personal-vault/store';
import type { PersonalPrincipalType } from '../../../personal-vault/types';

const SUPPORTED_SOURCES = ['gmail', 'calendar', 'contacts', 'facebook', 'instagram', 'x'] as const;
const PRINCIPAL_TYPES: readonly PersonalPrincipalType[] = ['plan-template', 'binding', 'agent-role'];

interface SafeIntegrationSource {
  kind: string;
  status: string;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
}

interface SafeIntegrationStatus {
  provider: 'google' | 'facebook';
  configured: boolean;
  connected: boolean;
  status: 'needs-app-config' | 'available' | 'connected' | 'degraded' | 'error';
  sources: SafeIntegrationSource[];
  capabilities?: SafeGoogleCapability[];
}

type GoogleCapabilityId = 'gmail' | 'calendar' | 'contacts' | 'youtube';

interface SafeGoogleCapability {
  id: GoogleCapabilityId;
  sourceKind: 'gmail' | 'gcal' | 'contacts' | 'youtube';
  enabled: boolean;
  connected: boolean;
  status: 'needs-app-config' | 'available' | 'connected' | 'disabled' | 'needs-consent' | 'degraded' | 'error';
  missingScopes: string[];
}

const GOOGLE_CAPABILITY_DEFS: ReadonlyArray<{
  id: GoogleCapabilityId;
  sourceKind: SafeGoogleCapability['sourceKind'];
  requiredScopes: readonly string[];
}> = [
  {
    id: 'gmail',
    sourceKind: 'gmail',
    requiredScopes: [GOOGLE_GMAIL_READONLY_SCOPE, GOOGLE_GMAIL_COMPOSE_SCOPE],
  },
  {
    id: 'calendar',
    sourceKind: 'gcal',
    requiredScopes: [GOOGLE_CALENDAR_READONLY_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
  },
  {
    id: 'contacts',
    sourceKind: 'contacts',
    requiredScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
  },
  {
    // P-015. Rides the SAME Google Workspace OAuth source as Gmail and Calendar
    // (the external-triggers D-010 one-credential-path pattern) — a scope
    // addition with an incremental-consent upgrade, never a second credential
    // path.
    //
    // ⚠ D-019: both scopes are in GOOGLE_WORKSPACE_ALLOWED_SCOPES (requestable)
    // and listed here (required), and NEITHER is in GOOGLE_WORKSPACE_SCOPES.
    // That list is presumed-granted for legacy connections, so putting them
    // there would make this capability report connected:true with no
    // missingScopes for an owner who never consented — surfacing as a 403 at
    // call time instead of as an honest needs-consent here.
    id: 'youtube',
    sourceKind: 'youtube',
    requiredScopes: [GOOGLE_YOUTUBE_READONLY_SCOPE, GOOGLE_YOUTUBE_FORCE_SSL_SCOPE],
  },
];

function jsonBody<T>(req: Request): Promise<T | null> {
  return req.json().catch(() => null) as Promise<T | null>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function importError(err: unknown): Response {
  const error = messageOf(err);
  if (error.includes('too_large') || error.includes('too_many_entries')) {
    return Response.json({ ok: false, error }, { status: 413 });
  }
  if (error === 'personal_vault_disabled') {
    return Response.json({ ok: false, error }, { status: 409 });
  }
  return Response.json({ ok: false, error }, { status: 400 });
}

function safeLastSyncAt(source: OwnedExternalTriggerSourceRow): string | null {
  const value = source.cursor.lastSyncAt ?? source.cursor.last_sync_at;
  return typeof value === 'string' && value.trim() ? value : null;
}

function safeIntegrationStatus(
  provider: SafeIntegrationStatus['provider'],
  configured: boolean,
  providerLoadFailed: boolean,
  owned: OwnedExternalTriggerSourceRow[],
  kinds: readonly string[],
): SafeIntegrationStatus {
  const sources = owned.filter((source) => kinds.includes(source.kind));
  const connected = sources.some((source) => source.credentialRef !== null);
  const status =
    providerLoadFailed || sources.some((source) => source.status === 'error')
      ? 'error'
      : sources.some((source) => source.status === 'degraded')
        ? 'degraded'
        : connected
          ? 'connected'
          : configured
            ? 'available'
            : 'needs-app-config';
  return {
    provider,
    configured,
    connected,
    status,
    sources: sources.map((source) => ({
      kind: source.kind,
      status: source.status,
      lastConnectedAt: source.lastConnectedAt,
      lastSyncAt: safeLastSyncAt(source),
    })),
  };
}

function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
          .map((scope) => scope.trim()),
      ),
    ];
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return scopeList(JSON.parse(value));
  } catch {
    return [
      ...new Set(
        value
          .split(/[\s,]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ];
  }
}

async function googleGrantedScopes(owned: OwnedExternalTriggerSourceRow[]): Promise<string[]> {
  const source = owned.find(
    (candidate) =>
      GOOGLE_WORKSPACE_SOURCE_KINDS.includes(candidate.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]) &&
      candidate.credentialRef !== null,
  );
  if (!source?.credentialRef) return [];
  const field = googleWorkspaceOAuthField(source.credentialRef);
  const config = await fsTokenStorage.read(GOOGLE_WORKSPACE_OAUTH_PLUGIN, 'papercusp');
  const stored = scopeList(config[field + '_scopes']);
  // Older connections predate granted-scope metadata. Their base read scopes
  // were mandatory, but calendar.events was not, so only the write upgrade is
  // conservatively reported missing until the next consent round-trip.
  return stored.length ? stored : [...GOOGLE_WORKSPACE_SCOPES];
}

function googleCapabilities(
  configured: boolean,
  providerLoadFailed: boolean,
  owned: OwnedExternalTriggerSourceRow[],
  grantedScopes: string[],
): SafeGoogleCapability[] {
  const sources = owned.filter((source) =>
    GOOGLE_WORKSPACE_SOURCE_KINDS.includes(source.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]),
  );
  const sharedConnected = sources.some((source) => source.credentialRef !== null);
  const granted = new Set(grantedScopes);
  return GOOGLE_CAPABILITY_DEFS.map((definition) => {
    const source = sources.find((candidate) => candidate.kind === definition.sourceKind);
    const enabled = source?.config.capabilityEnabled !== false;
    const missingScopes =
      sharedConnected && enabled ? definition.requiredScopes.filter((scope) => !granted.has(scope)) : [];
    const status: SafeGoogleCapability['status'] = providerLoadFailed
      ? 'error'
      : !configured
        ? 'needs-app-config'
        : !sharedConnected
          ? 'available'
          : !enabled
            ? 'disabled'
            : missingScopes.length
              ? 'needs-consent'
              : source?.status === 'error'
                ? 'error'
                : source?.status === 'degraded'
                  ? 'degraded'
                  : 'connected';
    return {
      id: definition.id,
      sourceKind: definition.sourceKind,
      enabled,
      connected: sharedConnected && enabled && missingScopes.length === 0,
      status,
      missingScopes,
    };
  });
}

async function integrationStatuses(
  workspaceId: string,
  ownerUserId: string,
): Promise<{ google: SafeIntegrationStatus; facebook: SafeIntegrationStatus }> {
  let providerLoadFailed = false;
  try {
    await loadAndRegisterProvidersFromDisk();
  } catch {
    providerLoadFailed = true;
  }
  const owned = await listOwnedExternalTriggerSources(getOrgPg().sql, workspaceId, ownerUserId);
  const googleConfigured = !providerLoadFailed && getProvider('google') !== null;
  const grantedGoogleScopes = await googleGrantedScopes(owned);
  const google = safeIntegrationStatus(
    'google',
    googleConfigured,
    providerLoadFailed,
    owned,
    GOOGLE_WORKSPACE_SOURCE_KINDS,
  );
  return {
    google: {
      ...google,
      capabilities: googleCapabilities(googleConfigured, providerLoadFailed, owned, grantedGoogleScopes),
    },
    facebook: safeIntegrationStatus(
      'facebook',
      !providerLoadFailed && getProvider('facebook') !== null,
      providerLoadFailed,
      owned,
      FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
    ),
  };
}

export function declaredPersonalScopes(raw: Record<string, string | string[]>): string[] {
  const value = raw.personalScopes ?? raw.personal_scopes ?? raw['personal-scopes'];
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.map((scope) => personalScope(scope)).filter(Boolean))].sort();
}

interface PlanGrantPreview {
  planSlug: string;
  harnessSlug: string;
  principalType: 'plan-template';
  principalId: string;
  declaredScopes: string[];
}

async function resolvePlanGrantPreview(
  workspaceId: string,
  planSlugInput: string,
  harnessSlugInput?: string | null,
): Promise<PlanGrantPreview> {
  const planSlug = planSlugInput.trim();
  const harnessSlug = harnessSlugInput?.trim() || null;
  if (!planSlug) throw new Error('plan_slug_required');
  const { sql } = getOrgPg();
  const harnessFilter = harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``;
  const rows = await sql<
    Array<{
      plan_slug: string;
      harness_slug: string;
      template_slug: string | null;
      content: string;
    }>
  >`
    SELECT plan_slug, harness_slug, template_slug, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${planSlug}
       ${harnessFilter}
     ORDER BY updated_at DESC
     LIMIT 2`;
  if (!rows.length) throw new Error('plan_not_found');
  if (!harnessSlug && rows.length > 1) throw new Error('plan_harness_ambiguous');
  const row = rows[0]!;
  const parsed = parsePlan(row.content, { filePath: `${row.plan_slug}.md` });
  return {
    planSlug: row.plan_slug,
    harnessSlug: row.harness_slug,
    principalType: 'plan-template',
    principalId: row.template_slug?.trim() || row.plan_slug,
    declaredScopes: declaredPersonalScopes(parsed.frontmatter.raw),
  };
}

const status = defineTool({
  method: 'GET',
  path: '/user/personal-vault',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    const [enabled, stats, grants, integrations] = await Promise.all([
      isPersonalVaultEnabled(sql, workspaceId, user.id),
      personalVaultStats(sql, workspaceId, user.id),
      listPersonalGrants(sql, workspaceId, user.id),
      integrationStatuses(workspaceId, user.id),
    ]);
    return Response.json({
      ok: true,
      workspaceId,
      user: { id: user.id, displayName: user.display_name },
      enabled,
      stats,
      grants,
      supportedSources: SUPPORTED_SOURCES,
      embedding: { mode: 'gemma', localOnly: true },
      integrations,
    });
  },
});

const disconnectGoogle = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/integrations/google',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const disconnected = await disconnectOwnedExternalTriggerSources(getOrgPg().sql, workspaceId, user.id, [
      ...GOOGLE_WORKSPACE_SOURCE_KINDS,
    ]);
    for (const credentialRef of disconnected.credentialRefs) {
      const field = googleWorkspaceOAuthField(credentialRef);
      await fsTokenStorage.update(GOOGLE_WORKSPACE_OAUTH_PLUGIN, 'papercusp', {
        [field]: null,
        [field + '_refresh']: null,
        [field + '_expires_at']: null,
        [field + '_scopes']: null,
        [field + '_expired']: true,
      });
    }
    return Response.json({
      ok: true,
      provider: 'google',
      disconnectedSources: disconnected.sources,
    });
  },
});

const setGoogleCapability = defineTool({
  method: 'PATCH',
  path: '/user/personal-vault/integrations/google/capabilities',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ capability?: unknown; enabled?: unknown }>(req);
    const definition = GOOGLE_CAPABILITY_DEFS.find((candidate) => candidate.id === body?.capability);
    if (!definition) {
      return Response.json({ ok: false, error: 'google_capability_invalid' }, { status: 400 });
    }
    if (typeof body?.enabled !== 'boolean') {
      return Response.json({ ok: false, error: 'enabled_must_be_boolean' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const sql = getOrgPg().sql;
    const owned = await listOwnedExternalTriggerSources(sql, workspaceId, user.id);
    const credentialRef = owned.find(
      (source) =>
        GOOGLE_WORKSPACE_SOURCE_KINDS.includes(source.kind as (typeof GOOGLE_WORKSPACE_SOURCE_KINDS)[number]) &&
        source.credentialRef !== null,
    )?.credentialRef;
    if (!credentialRef) {
      return Response.json({ ok: false, error: 'google_workspace_not_connected' }, { status: 409 });
    }
    const source = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId,
      ownerUserId: user.id,
      kind: definition.sourceKind,
      credentialRef,
      enabled: body.enabled,
      createdBy: `owner:${user.id}`,
    });
    return Response.json({
      ok: true,
      capability: definition.id,
      enabled: body.enabled,
      source: { kind: source.kind, status: source.status },
    });
  },
});

const disconnectFacebook = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/integrations/facebook',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const disconnected = await disconnectOwnedExternalTriggerSources(getOrgPg().sql, workspaceId, user.id, [
      ...FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS,
    ]);
    for (const credentialRef of disconnected.credentialRefs) {
      const field = facebookPersonalVaultOAuthField(credentialRef);
      await fsTokenStorage.update(FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN, 'papercusp', {
        [field]: null,
        [field + '_refresh']: null,
        [field + '_expires_at']: null,
        [field + '_expired']: true,
      });
    }
    return Response.json({
      ok: true,
      provider: 'facebook',
      disconnectedSources: disconnected.sources,
    });
  },
});

const setEnabled = defineTool({
  method: 'PATCH',
  path: '/user/personal-vault',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ enabled?: unknown }>(req);
    if (typeof body?.enabled !== 'boolean') {
      return Response.json({ ok: false, error: 'enabled_must_be_boolean' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    await setPersonalVaultEnabled(getOrgPg().sql, workspaceId, user.id, body.enabled, `owner:${user.id}`);
    return Response.json({ ok: true, enabled: body.enabled });
  },
});

const purge = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ source?: unknown; confirm?: unknown }>(req);
    if (body?.confirm !== true) {
      return Response.json({ ok: false, error: 'confirm_required' }, { status: 400 });
    }
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : null;
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    try {
      const removed = await purgePersonalSource(getOrgPg().sql, workspaceId, user.id, source);
      return Response.json({ ok: true, source, removed });
    } catch (err) {
      return Response.json({ ok: false, error: messageOf(err) }, { status: 400 });
    }
  },
});

const archiveImport = defineTool({
  method: 'POST',
  path: '/user/personal-vault/import',
  auth: 'loopback',
  // Large offline exports legitimately take longer than the route stack's 30s
  // default. Parsing is still bounded by archive-import's byte/entry guards.
  timeoutSec: 300,
  async handler(req) {
    const form = await req.formData().catch(() => null);
    const entry = form?.get('file');
    if (!entry || typeof entry === 'string') {
      return Response.json({ ok: false, error: 'file_required' }, { status: 400 });
    }
    const file = entry as File;
    if (!file.name?.trim()) {
      return Response.json({ ok: false, error: 'filename_required' }, { status: 400 });
    }
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    try {
      const parsed = parsePersonalArchive(file.name, Buffer.from(await file.arrayBuffer()));
      const stored = parsed.documents.length
        ? await upsertPersonalDocuments(getOrgPg().sql, workspaceId, user.id, parsed.documents)
        : { insertedOrUpdated: 0, ids: [] as string[] };
      return Response.json({
        ok: true,
        filename: file.name,
        documents: stored.insertedOrUpdated,
        sources: parsed.sources,
        warnings: parsed.warnings,
      });
    } catch (err) {
      return importError(err);
    }
  },
});

const grants = defineTool({
  method: 'GET',
  path: '/user/personal-vault/grants',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    return Response.json({
      ok: true,
      grants: await listPersonalGrants(getOrgPg().sql, workspaceId, user.id),
    });
  },
});

const previewGrant = defineTool({
  method: 'POST',
  path: '/user/personal-vault/grants/preview',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{ planSlug?: unknown; harnessSlug?: unknown }>(req);
    if (typeof body?.planSlug !== 'string') {
      return Response.json({ ok: false, error: 'plan_slug_required' }, { status: 400 });
    }
    try {
      const preview = await resolvePlanGrantPreview(
        activeWorkspaceId(),
        body.planSlug,
        typeof body.harnessSlug === 'string' ? body.harnessSlug : null,
      );
      return Response.json({ ok: true, ...preview });
    } catch (err) {
      const error = messageOf(err);
      const statusCode = error === 'plan_not_found' ? 404 : 400;
      return Response.json({ ok: false, error }, { status: statusCode });
    }
  },
});

const approveGrant = defineTool({
  method: 'POST',
  path: '/user/personal-vault/grants',
  auth: 'loopback',
  async handler(req) {
    const body = await jsonBody<{
      planSlug?: unknown;
      harnessSlug?: unknown;
      principalType?: unknown;
      principalId?: unknown;
      scopes?: unknown;
      expiresAt?: unknown;
    }>(req);
    if (!body) return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });

    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    let principalType: PersonalPrincipalType;
    let principalId: string;
    let scopes: string[];
    let metadata: Record<string, unknown> = { source: 'owner-settings' };
    try {
      if (typeof body.planSlug === 'string') {
        const preview = await resolvePlanGrantPreview(
          workspaceId,
          body.planSlug,
          typeof body.harnessSlug === 'string' ? body.harnessSlug : null,
        );
        principalType = preview.principalType;
        principalId = preview.principalId;
        scopes = preview.declaredScopes;
        metadata = {
          ...metadata,
          planSlug: preview.planSlug,
          harnessSlug: preview.harnessSlug,
          declaration: 'personalScopes',
        };
      } else {
        if (!PRINCIPAL_TYPES.includes(body.principalType as PersonalPrincipalType)) {
          throw new Error('invalid_principal_type');
        }
        if (typeof body.principalId !== 'string' || !body.principalId.trim()) {
          throw new Error('principal_id_required');
        }
        if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== 'string')) {
          throw new Error('scopes_required');
        }
        principalType = body.principalType as PersonalPrincipalType;
        principalId = body.principalId.trim();
        scopes = body.scopes as string[];
      }
      if (!scopes.length) throw new Error('personal_scopes_not_declared');
      const grant = await replacePersonalGrant(getOrgPg().sql, {
        workspaceId,
        userId: user.id,
        principalType,
        principalId,
        scopes,
        grantedBy: `owner:${user.id}`,
        expiresAt: typeof body.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt : null,
        metadata,
      });
      return Response.json({ ok: true, principalType, principalId, grant });
    } catch (err) {
      const error = messageOf(err);
      return Response.json({ ok: false, error }, { status: error === 'plan_not_found' ? 404 : 400 });
    }
  },
});

const revokeGrant = defineTool({
  method: 'DELETE',
  path: '/user/personal-vault/grants',
  auth: 'loopback',
  async handler(req) {
    const id = new URL(req.url).searchParams.get('id')?.trim();
    if (!id) return Response.json({ ok: false, error: 'grant_id_required' }, { status: 400 });
    const user = await getSessionUserOrDefault(req.headers);
    const workspaceId = activeWorkspaceId();
    const revoked = await revokePersonalGrant(getOrgPg().sql, workspaceId, user.id, id);
    return Response.json({ ok: true, id, revoked }, { status: revoked ? 200 : 404 });
  },
});

export default [
  status,
  setEnabled,
  purge,
  disconnectGoogle,
  setGoogleCapability,
  disconnectFacebook,
  archiveImport,
  grants,
  previewGrant,
  approveGrant,
  revokeGrant,
];
