/**
 * record-telemetry — server-side enqueue into the telemetry report ring.
 *
 * The diagnostic-telemetry pipeline is: a report is appended to the
 * operator-state `telemetry_reports` ring buffer (capped), and
 * `flushTelemetry()` (lib/telemetry-flush.ts) later drains it — archiving
 * every report locally AND forwarding it to PostHog when the user has opted
 * in (or on the maintainer-internal channel). The POST
 * /api/desktop/telemetry-report route is the CLIENT ingress for this buffer;
 * this helper is the SERVER-side ingress so operator-internal code (e.g. the
 * substrate admission path) can emit the same kinds without a round-trip
 * through HTTP.
 *
 * Local archival is unconditional (user-visible without consent); only
 * OFF-DEVICE forwarding is gated, in `flushTelemetry`. So enqueuing here
 * without an opt-in check is correct — it matches the flush worker's stance,
 * and an opted-out user simply never forwards. Callers on hot/critical paths
 * should treat this as best-effort (swallow rejections) — telemetry must never
 * gate the work it observes.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { isHostedPrincipal, type HostedPrincipal } from './auth/hosted-principal';
import { cloudTelemetryConsentSchema, cloudTelemetryConsentUpdateSchema, cloudTelemetryEventSchema, CLOUD_ERROR_CODES, DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent, type CloudTelemetryEvent, type TelemetryKind } from './telemetry-kinds';

/** Existing hosted preference storage supplies the consent. Require the
 * verified tenant transaction so no ambient/admin read can choose its scope. */
export async function readCloudTelemetryConsent(tx: Sql, principal: HostedPrincipal): Promise<CloudTelemetryConsent> {
  await assertCloudTelemetryScope(tx, principal);
  const [row] = await tx<{ consent: unknown }[]>`
    SELECT profile->'cloudMonitoring' AS consent FROM papercusp_auth.hosted_user_preferences
     WHERE organization_id = ${principal.activeOrganizationId}::uuid AND user_id = ${principal.userId}::uuid`;
  if (row?.consent == null) return structuredClone(DEFAULT_CLOUD_TELEMETRY_CONSENT);
  return cloudTelemetryConsentSchema.parse(row.consent);
}

async function assertCloudTelemetryScope(tx: Sql, principal: HostedPrincipal): Promise<void> {
  if (!isHostedPrincipal(principal)) throw new Error('cloud_telemetry_principal_required');
  const [scope] = await tx<{ organization: string; user: string }[]>`
    SELECT current_setting('app.organization_id', true) AS organization,
           current_setting('app.user_id', true) AS "user"`;
  if (!scope || scope.organization !== principal.activeOrganizationId || scope.user !== principal.userId) {
    throw new Error('cloud_telemetry_scope_mismatch');
  }
}

/** Same scoped preference row as the reader. Serialize changes so a concurrent
 * category update cannot overwrite revocation, and preserve other preferences. */
export async function writeCloudTelemetryConsent(tx: Sql, principal: HostedPrincipal, input: unknown): Promise<CloudTelemetryConsent> {
  const update = cloudTelemetryConsentUpdateSchema.parse(input);
  await assertCloudTelemetryScope(tx, principal);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cloud-monitoring', principal.activeOrganizationId, principal.userId])}, 0))`;
  const current = await readCloudTelemetryConsent(tx, principal);
  const now = new Date().toISOString();
  const choice = (key: 'analytics' | 'diagnostics') => update[key] === undefined ? current[key] :
    update[key] === false ? { enabled: false, since: null } :
    current[key].enabled && current[key].since ? current[key] : { enabled: true, since: now };
  const consent = cloudTelemetryConsentSchema.parse({ disclosure_version: update.disclosure_version,
    analytics: choice('analytics'), diagnostics: choice('diagnostics') });
  await tx`
    INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
    VALUES (${principal.activeOrganizationId}::uuid, ${principal.userId}::uuid, ${JSON.stringify({ cloudMonitoring: consent })}::jsonb)
    ON CONFLICT (organization_id, user_id) DO UPDATE
    SET profile = hosted_user_preferences.profile || EXCLUDED.profile`;
  return consent;
}

export interface CloudTelemetryContext {
  /** Supplied by the authenticated server route, never request JSON. */
  principal: HostedPrincipal;
  environment: 'development' | 'staging' | 'production';
  release: string;
  origin: 'portal' | 'control-plane' | 'customer-runtime';
  hostingMode: 'managed' | 'byoc';
  observedAt?: string;
  /** Only controlled server probes may set this; excluded from business views. */
  synthetic?: boolean;
}
export interface CloudTelemetryEnvelope {
  event: CloudTelemetryEvent['event'];
  distinct_id: string;
  timestamp: string;
  properties: CloudTelemetryEvent['properties'] & {
    organization_id: string; workspace_id?: string; operation_id: string;
    environment: CloudTelemetryContext['environment']; release: string;
    source: CloudTelemetryContext['origin']; synthetic: boolean;
  };
}
export type CloudTelemetryPreparation = { ok: true; envelope: CloudTelemetryEnvelope } |
  { ok: false; code: 'invalid_cloud_event' | 'unverified_principal' | 'invalid_runtime' | 'customer_data_local' | 'unwitnessed_outcome' | 'consent_unavailable' | 'consent_disabled' | 'outside_consent_epoch' };

function opaqueCloudIdentity(kind: string, environment: string, organization: string, identifier: string): string {
  return createHash('sha256').update(JSON.stringify(['papercusp-cloud-v1', kind, environment, organization, identifier])).digest('hex');
}

/** Revalidate at the FINAL delivery boundary, including batches queued earlier.
 * A missing/changed consent epoch fails closed instead of backfilling history. */
export function prepareCloudTelemetryDelivery(input: unknown, context: CloudTelemetryContext, consent: unknown): CloudTelemetryPreparation {
  const parsed = cloudTelemetryEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_cloud_event' };
  if (!context.principal || !isHostedPrincipal(context.principal)) return { ok: false, code: 'unverified_principal' };
  const observedAt = context.observedAt ?? new Date().toISOString();
  if (!['development', 'staging', 'production'].includes(context.environment) ||
      !/^[a-f0-9]{7,64}$/.test(context.release) || !Number.isFinite(Date.parse(observedAt)) ||
      !['portal', 'control-plane', 'customer-runtime'].includes(context.origin) ||
      !['managed', 'byoc'].includes(context.hostingMode)) return { ok: false, code: 'invalid_runtime' };
  const event = parsed.data;
  const aggregate = event.event === 'cloud_diagnostic_aggregate';
  if (context.origin === 'customer-runtime' && !aggregate) return { ok: false, code: 'customer_data_local' };
  if (aggregate && !context.principal.selectedWorkspaceId) return { ok: false, code: 'unverified_principal' };
  // Browser assertions cannot establish confirmed provisioning or private task outcomes.
  if (event.event === 'cloud_workspace_provisioning' && context.origin !== 'control-plane') return { ok: false, code: 'unwitnessed_outcome' };
  if (event.event === 'cloud_tutorial' && (event.properties.action === 'complete' ||
      (event.properties.step && ['agent', 'task', 'result', 'revision', 'practice'].includes(event.properties.step)))) {
    if (context.hostingMode === 'byoc' || context.origin !== 'control-plane') return { ok: false, code: 'customer_data_local' };
  }
  const authorization = cloudTelemetryConsentSchema.safeParse(consent);
  if (!authorization.success) return { ok: false, code: 'consent_unavailable' };
  const choice = aggregate ? authorization.data.diagnostics : authorization.data.analytics;
  if (!choice.enabled || !choice.since) return { ok: false, code: 'consent_disabled' };
  if (Date.parse(observedAt) < Date.parse(choice.since) ||
      (aggregate && Date.parse(event.properties.period_start) < Date.parse(choice.since))) return { ok: false, code: 'outside_consent_epoch' };
  const principal = context.principal;
  return { ok: true, envelope: {
    event: event.event,
    distinct_id: opaqueCloudIdentity('person', context.environment, principal.activeOrganizationId, principal.userId),
    timestamp: new Date(observedAt).toISOString(),
    properties: {
      ...event.properties,
      organization_id: opaqueCloudIdentity('organization', context.environment, principal.activeOrganizationId, principal.activeOrganizationId),
      ...(aggregate ? { workspace_id: opaqueCloudIdentity('workspace', context.environment, principal.activeOrganizationId, principal.selectedWorkspaceId!) } : {}),
      operation_id: opaqueCloudIdentity('operation', context.environment, principal.activeOrganizationId, event.operation_id),
      environment: context.environment, release: context.release,
      source: context.origin, synthetic: context.synthetic === true,
    },
  } };
}

/** Optional analytics never changes the primary product outcome. Consent is
 * read afresh per delivery; this function holds no queue or consent cache. */
export async function deliverCloudTelemetry(input: unknown, context: CloudTelemetryContext, dependencies: {
  readConsent: () => Promise<unknown>; send: (envelope: CloudTelemetryEnvelope) => Promise<void>;
}): Promise<{ delivered: boolean; code?: string }> {
  try {
    const prepared = prepareCloudTelemetryDelivery(input, context, await dependencies.readConsent());
    if (!prepared.ok) return { delivered: false, code: prepared.code };
    await dependencies.send(prepared.envelope);
    return { delivered: true };
  } catch { return { delivered: false, code: 'delivery_unavailable' }; }
}

/** No free-form message, stack, URL, component name or customer value crosses
 * the error boundary. The fingerprint groups only reviewed code/type pairs. */
export function safeCloudError(code: typeof CLOUD_ERROR_CODES[number], error: unknown) {
  const allowedNames = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError'];
  const type = error instanceof Error && allowedNames.includes(error.name) ? error.name : 'Error';
  return { code, fingerprint: createHash('sha256').update(JSON.stringify([code, type])).digest('hex') };
}

const REPORTS_KEY = 'telemetry_reports';

/** Shared ring-buffer cap for both HTTP and server-side telemetry ingress. */
export const MAX_TELEMETRY_REPORTS = 100;

export interface StoredTelemetryReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: StoredTelemetryReport[];
}

/**
 * Append one diagnostic report to the telemetry ring buffer (newest-first,
 * capped at {@link MAX_TELEMETRY_REPORTS}). Returns the stored report.
 *
 * `receivedAt` is injectable for deterministic tests; production omits it and
 * stamps `new Date().toISOString()`.
 */
export async function recordTelemetryReport(report: {
  kind: TelemetryKind | string;
  payload: unknown;
  app_version?: string;
  os?: string;
  receivedAt?: string;
}): Promise<StoredTelemetryReport> {
  const stored: StoredTelemetryReport = {
    received_at: report.receivedAt ?? new Date().toISOString(),
    kind: report.kind,
    app_version: report.app_version,
    os: report.os,
    payload: report.payload ?? null,
  };
  const current = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? { reports: [] };
  const next: ReportsState = {
    reports: [stored, ...current.reports].slice(0, MAX_TELEMETRY_REPORTS),
  };
  await writeOperatorState(REPORTS_KEY, next);
  return stored;
}
