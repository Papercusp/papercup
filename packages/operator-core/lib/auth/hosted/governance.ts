/**
 * Hosted customer-governance core (BYOC P-088).
 *
 * This is a direct-import leaf while the hosted control plane is assembled in
 * parallel. It intentionally does not join the local auth/profile barrels.
 * Postgres owns durability and immutability; these helpers own input validation,
 * secret exclusion, and the small amount of derived support-access state.
 */
import { getOrgPg, withHostedServiceContext } from '@papercusp/db-org';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { isHostedPrincipal, type HostedPrincipal } from '../hosted-principal';
import { hostedPermissionsForMembership } from '../hosted-role-permissions';
import { workosDirectoryIdentitySubject } from './workos-lifecycle-worker';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';

export type GovernanceJson =
  | null
  | boolean
  | number
  | string
  | GovernanceJson[]
  | { readonly [key: string]: GovernanceJson };

export type LegalDocumentKind = 'terms' | 'privacy';
export type SupportAccessState = 'pending' | 'active' | 'expired' | 'revoked';

const FORBIDDEN_GOVERNANCE_KEY =
  /(?:password|passcode|secret|token|credential|authorization|cookie|mfa|private[_-]?key|refresh[_-]?token)/i;
const FORBIDDEN_GOVERNANCE_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusr])[_-][A-Za-z0-9_-]{16,})/i;

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`hosted-governance: ${label} must be non-empty`);
  return normalized;
}

/** Reject secret-bearing metadata instead of silently storing a partial record. */
export function assertGovernancePayloadSafe(
  value: GovernanceJson,
  path = 'payload',
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`hosted-governance: ${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_GOVERNANCE_VALUE.test(value)) {
      throw new Error(`hosted-governance: ${path} contains credential-like material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertGovernancePayloadSafe(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_GOVERNANCE_KEY.test(key)) {
      throw new Error(`hosted-governance: ${path}.${key} is a forbidden governance field`);
    }
    assertGovernancePayloadSafe(entry, `${path}.${key}`);
  }
}

export function normalizeHostedLocale(locale: string): string {
  const normalized = nonEmpty(locale, 'locale').replaceAll('_', '-');
  try {
    return new Intl.Locale(normalized).toString();
  } catch {
    throw new Error(`hosted-governance: invalid locale ${JSON.stringify(locale)}`);
  }
}

export function normalizeHostedTimeZone(timeZone: string): string {
  const normalized = nonEmpty(timeZone, 'timeZone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`hosted-governance: invalid timeZone ${JSON.stringify(timeZone)}`);
  }
}

export interface SupportAccessWindow {
  startsAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  bannerMessage: string;
}

export function supportAccessState(
  grant: SupportAccessWindow,
  now = new Date(),
): SupportAccessState {
  if (grant.revokedAt) return 'revoked';
  if (now < grant.startsAt) return 'pending';
  if (now >= grant.expiresAt) return 'expired';
  return 'active';
}

export function activeSupportAccessBanner(
  grant: SupportAccessWindow,
  now = new Date(),
): string | null {
  return supportAccessState(grant, now) === 'active'
    ? nonEmpty(grant.bannerMessage, 'bannerMessage')
    : null;
}

export interface CreateSupportAccessGrantInput {
  organizationId: string;
  workspaceId?: string | null;
  staffPrincipalId: string;
  grantedByUserId: string;
  purpose: string;
  scopes: readonly string[];
  bannerMessage: string;
  startsAt?: Date;
  expiresAt: Date;
}

export function validateSupportAccessGrant(
  input: CreateSupportAccessGrantInput,
): Omit<CreateSupportAccessGrantInput, 'workspaceId' | 'startsAt' | 'scopes'> & {
  workspaceId: string | null;
  startsAt: Date;
  scopes: string[];
} {
  const startsAt = input.startsAt ?? new Date();
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.valueOf())) {
    throw new Error('hosted-governance: startsAt must be a valid date');
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.valueOf())) {
    throw new Error('hosted-governance: expiresAt must be a valid date');
  }
  if (input.expiresAt <= startsAt) {
    throw new Error('hosted-governance: support access must expire after it starts');
  }

  const scopes = [...new Set(input.scopes.map((scope) => nonEmpty(scope, 'scope')))];
  if (!scopes.length) throw new Error('hosted-governance: at least one scope is required');
  if (scopes.some((scope) => scope === '*' || scope.includes('*'))) {
    throw new Error('hosted-governance: wildcard support access is forbidden');
  }

  return {
    ...input,
    organizationId: nonEmpty(input.organizationId, 'organizationId'),
    workspaceId: input.workspaceId ? nonEmpty(input.workspaceId, 'workspaceId') : null,
    staffPrincipalId: nonEmpty(input.staffPrincipalId, 'staffPrincipalId'),
    grantedByUserId: nonEmpty(input.grantedByUserId, 'grantedByUserId'),
    purpose: nonEmpty(input.purpose, 'purpose'),
    bannerMessage: nonEmpty(input.bannerMessage, 'bannerMessage'),
    startsAt,
    scopes,
  };
}

export interface LegalAcceptanceInput {
  organizationId: string;
  userId: string;
  documentKind: LegalDocumentKind;
  documentVersion: string;
  acceptanceSource: 'hosted_ui' | 'api' | 'administrative';
  evidence?: Record<string, GovernanceJson>;
  acceptedAt?: Date;
}

export async function recordLegalAcceptance(input: LegalAcceptanceInput): Promise<{
  id: string;
  acceptedAt: Date;
  inserted: boolean;
}> {
  const organizationId = nonEmpty(input.organizationId, 'organizationId');
  const userId = nonEmpty(input.userId, 'userId');
  const documentVersion = nonEmpty(input.documentVersion, 'documentVersion');
  const evidence = input.evidence ?? {};
  assertGovernancePayloadSafe(evidence);
  const acceptedAt = input.acceptedAt ?? new Date();
  const { sql } = getOrgPg();

  const inserted = await sql<{ id: string; accepted_at: Date }[]>`
    INSERT INTO papercusp_auth.legal_acceptances (
      organization_id, user_id, document_kind, document_version,
      acceptance_source, evidence, accepted_at
    ) VALUES (
      ${organizationId}::uuid, ${userId}::uuid, ${input.documentKind},
      ${documentVersion}, ${input.acceptanceSource},
      ${JSON.stringify(evidence)}::text::jsonb, ${acceptedAt}
    )
    ON CONFLICT (organization_id, user_id, document_kind, document_version)
      DO NOTHING
    RETURNING id, accepted_at`;
  if (inserted[0]) return { id: inserted[0].id, acceptedAt: inserted[0].accepted_at, inserted: true };

  const existing = await sql<{ id: string; accepted_at: Date }[]>`
    SELECT id, accepted_at
      FROM papercusp_auth.legal_acceptances
     WHERE organization_id = ${organizationId}::uuid
       AND user_id = ${userId}::uuid
       AND document_kind = ${input.documentKind}
       AND document_version = ${documentVersion}`;
  if (!existing[0]) throw new Error('hosted-governance: legal acceptance dedupe row disappeared');
  return { id: existing[0].id, acceptedAt: existing[0].accepted_at, inserted: false };
}

export interface OrganizationAuditEventInput {
  organizationId: string;
  workspaceId?: string | null;
  actorKind: 'customer_user' | 'staff_admin' | 'system';
  actorId?: string | null;
  action: string;
  purpose: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, GovernanceJson>;
  occurredAt?: Date;
}

export async function appendOrganizationAuditEvent(
  input: OrganizationAuditEventInput,
  transaction?: Sql,
): Promise<string> {
  const metadata = input.metadata ?? {};
  assertGovernancePayloadSafe(metadata);
  const sql = transaction ?? getOrgPg().sql;
  const id = randomUUID();
  // Generate the key before INSERT so an append-only writer needs no SELECT
  // privilege (PostgreSQL RETURNING would require it even for just the id).
  await sql`
    INSERT INTO papercusp_auth.organization_audit_events (
      id, organization_id, workspace_id, actor_kind, actor_id, action, purpose,
      target_type, target_id, metadata, occurred_at
    ) VALUES (
      ${id}::uuid,
      ${nonEmpty(input.organizationId, 'organizationId')}::uuid,
      ${input.workspaceId ?? null}::uuid,
      ${input.actorKind}, ${input.actorId ?? null},
      ${nonEmpty(input.action, 'action')}, ${nonEmpty(input.purpose, 'purpose')},
      ${input.targetType ?? null}, ${input.targetId ?? null},
      ${JSON.stringify(metadata)}::text::jsonb, COALESCE(${input.occurredAt ?? null}::timestamptz, now())
    )`;
  return id;
}

export async function createSupportAccessGrant(
  rawInput: CreateSupportAccessGrantInput,
): Promise<string> {
  const input = validateSupportAccessGrant(rawInput);
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO papercusp_auth.support_access_grants (
      organization_id, workspace_id, staff_principal_id, granted_by_user_id,
      purpose, scopes, banner_message, starts_at, expires_at
    ) VALUES (
      ${input.organizationId}::uuid, ${input.workspaceId}::uuid,
      ${input.staffPrincipalId}, ${input.grantedByUserId}::uuid,
      ${input.purpose}, ${input.scopes}, ${input.bannerMessage},
      ${input.startsAt}, ${input.expiresAt}
    )
    RETURNING id`;
  return rows[0].id;
}

export async function revokeSupportAccessGrant(input: {
  organizationId: string;
  grantId: string;
  revokedByUserId: string;
  reason: string;
  revokedAt?: Date;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE papercusp_auth.support_access_grants
       SET revoked_at = ${input.revokedAt ?? new Date()},
           revoked_by_user_id = ${nonEmpty(input.revokedByUserId, 'revokedByUserId')}::uuid,
           revocation_reason = ${nonEmpty(input.reason, 'reason')},
           updated_at = now()
     WHERE id = ${nonEmpty(input.grantId, 'grantId')}::uuid
       AND organization_id = ${nonEmpty(input.organizationId, 'organizationId')}::uuid
       AND revoked_at IS NULL
    RETURNING id`;
  return rows.length === 1;
}

export interface HostedUserPreferencesInput {
  organizationId: string;
  userId: string;
  locale: string;
  timeZone: string;
  profile?: Record<string, GovernanceJson>;
  notifications?: Record<string, GovernanceJson>;
}

export async function saveHostedUserPreferences(
  input: HostedUserPreferencesInput,
  transaction?: Sql,
): Promise<void> {
  const profile = input.profile ?? {};
  const notifications = input.notifications ?? {};
  assertGovernancePayloadSafe(profile, 'profile');
  assertGovernancePayloadSafe(notifications, 'notifications');
  const sql = transaction ?? getOrgPg().sql;
  await sql`
    INSERT INTO papercusp_auth.hosted_user_preferences (
      organization_id, user_id, locale, time_zone, profile,
      notification_preferences, updated_at
    ) VALUES (
      ${nonEmpty(input.organizationId, 'organizationId')}::uuid,
      ${nonEmpty(input.userId, 'userId')}::uuid,
      ${normalizeHostedLocale(input.locale)}, ${normalizeHostedTimeZone(input.timeZone)},
      ${JSON.stringify(profile)}::text::jsonb, ${JSON.stringify(notifications)}::text::jsonb, now()
    )
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET locale = EXCLUDED.locale,
          time_zone = EXCLUDED.time_zone,
          profile = papercusp_auth.hosted_user_preferences.profile || EXCLUDED.profile,
          notification_preferences = EXCLUDED.notification_preferences,
          updated_at = now()`;
}

export interface DirectoryBindingInput {
  organizationId: string;
  userId: string;
  externalOrganizationId: string;
  directoryId: string;
  directoryUserId: string;
  authorizedGroupIds: readonly string[];
  purpose: string;
}

export interface DirectoryBindingResult {
  identityId: string;
  subject: string;
  authorizedGroupIds: string[];
  status: 'active' | 'deactivated';
  auditId: string;
}

export function validateDirectoryBinding(input: DirectoryBindingInput): DirectoryBindingInput & { authorizedGroupIds: string[] } {
  const identifier = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError(`directory_binding_invalid:${field}`);
    return value.trim();
  };
  if (!Array.isArray(input.authorizedGroupIds) || input.authorizedGroupIds.length > 100) throw new TypeError('directory_binding_invalid:authorizedGroupIds');
  const normalized = {
    organizationId: identifier(input.organizationId, 'organizationId'), userId: identifier(input.userId, 'userId'),
    externalOrganizationId: identifier(input.externalOrganizationId, 'externalOrganizationId'),
    directoryId: identifier(input.directoryId, 'directoryId'), directoryUserId: identifier(input.directoryUserId, 'directoryUserId'),
    authorizedGroupIds: [...new Set(input.authorizedGroupIds.map((id) => identifier(id, 'groupId')))].sort(),
    purpose: identifier(input.purpose, 'purpose'),
  };
  assertGovernancePayloadSafe(normalized);
  return normalized;
}

/** References describe revocation authority only. They never grant a role,
 * link an email, or reactivate a removed identity or membership. */
export class HostedDirectoryBindingManager {
  constructor(private readonly run: HostedServiceContextRunner = withHostedServiceContext) {}

  async set(principal: HostedPrincipal, raw: DirectoryBindingInput): Promise<DirectoryBindingResult> {
    return this.change(principal, validateDirectoryBinding(raw), false);
  }

  async remove(principal: HostedPrincipal, raw: Omit<DirectoryBindingInput, 'authorizedGroupIds'>): Promise<DirectoryBindingResult> {
    return this.change(principal, validateDirectoryBinding({ ...raw, authorizedGroupIds: [] }), true);
  }

  private async change(principal: HostedPrincipal, input: DirectoryBindingInput, remove: boolean): Promise<DirectoryBindingResult> {
    if (!isHostedPrincipal(principal) || principal.activeOrganizationId !== input.organizationId || !principal.permissions.has('members:manage')) {
      throw new Error('directory_binding_forbidden');
    }
    const subject = workosDirectoryIdentitySubject(input.externalOrganizationId, input.directoryId, input.directoryUserId);
    return this.run<DirectoryBindingResult>(async (sql) => {
      // Lock current authority in the write transaction; a previously resolved
      // cookie is not durable administrator authority.
      const organizations = await sql<{ id: string }[]>`
        SELECT id FROM papercusp_auth.organizations
         WHERE id = ${input.organizationId}::uuid AND identity_provider = 'workos'
           AND external_organization_id = ${input.externalOrganizationId} AND status = 'active' FOR SHARE`;
      if (!organizations[0]) throw new Error('directory_binding_organization_mismatch');
      const actors = await sql<{ role: string; status: string }[]>`
        SELECT membership.role, membership.status FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS actor ON actor.id = membership.user_id
         WHERE membership.organization_id = ${input.organizationId}::uuid AND membership.user_id = ${principal.userId}::uuid
           AND actor.status = 'active' FOR SHARE OF membership, actor`;
      if (!actors[0] || !hostedPermissionsForMembership(actors[0]).has('members:manage')) throw new Error('directory_binding_forbidden');
      const targets = await sql<{ id: string }[]>`
        SELECT membership.id FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS target ON target.id = membership.user_id
         WHERE membership.organization_id = ${input.organizationId}::uuid AND membership.user_id = ${input.userId}::uuid
           AND target.status <> 'deleted' FOR SHARE OF membership, target`;
      if (!targets[0]) throw new Error('directory_binding_member_not_found');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`directory-binding:${subject}`}, 0))`;
      const links = await sql<{ id: string; hosted_user_id: string; status: string; profile: Record<string, GovernanceJson> }[]>`
        SELECT id, hosted_user_id, status, profile FROM papercusp_auth.external_identities
         WHERE provider = 'workos-dsync' AND subject = ${subject} FOR UPDATE`;
      const existing = links[0];
      if (existing && existing.hosted_user_id !== input.userId) throw new Error('directory_binding_subject_conflict');
      if (existing && existing.status !== 'active') throw new Error('directory_binding_inactive');
      if (remove && !existing) throw new Error('directory_binding_not_found');
      const profile = { ...(existing?.profile ?? {}), authorized_directory_groups: [...input.authorizedGroupIds] };
      assertGovernancePayloadSafe(profile);
      const rows = existing
        ? await sql<{ id: string }[]>`
            UPDATE papercusp_auth.external_identities SET profile = ${JSON.stringify(profile)}::text::jsonb,
              status = ${remove ? 'deactivated' : 'active'},
              deactivated_at = CASE WHEN ${remove} THEN now() ELSE NULL END, updated_at = now()
             WHERE id = ${existing.id}::uuid RETURNING id`
        : await sql<{ id: string }[]>`
            INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject, profile)
            VALUES (${input.userId}::uuid, 'workos-dsync', ${subject}, ${JSON.stringify(profile)}::text::jsonb) RETURNING id`;
      const identityId = rows[0].id;
      const auditId = await appendOrganizationAuditEvent({
        organizationId: input.organizationId, actorKind: 'customer_user', actorId: principal.userId,
        action: remove ? 'directory_binding.removed' : 'directory_binding.set', purpose: input.purpose,
        targetType: 'external_identity', targetId: identityId,
        metadata: { userId: input.userId, subject, previousGroups: existing?.profile.authorized_directory_groups ?? [],
          authorizedGroups: [...input.authorizedGroupIds] },
      }, sql);
      return { identityId, subject, authorizedGroupIds: [...input.authorizedGroupIds], status: remove ? 'deactivated' : 'active', auditId };
    });
  }
}
