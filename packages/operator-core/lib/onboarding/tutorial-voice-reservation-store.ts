import { randomUUID } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { TutorialVoiceAdmission } from '../endpoint-route/routes/hosted-tutorial-progress';

export interface TutorialVoiceQuotaAuthority {
  maximumSeconds: number;
  dailySeconds: { global: number; user: number; organization: number; workspace: number };
  /** Verified restricted credential/provider duration evidence, never a key. */
  providerLimitRef: string;
}
/** Server-only. Lock and revalidate persisted active lesson, identity, policy
 * and kill switch in this SAME transaction. Missing evidence refuses. Provider
 * issuance follows commit. No browser authority is accepted. */
export type TutorialVoiceAuthorityReader = (sql: Sql, admission: TutorialVoiceAdmission) =>
  Promise<TutorialVoiceQuotaAuthority | null>;
export type TutorialVoiceReservationResult =
  | { ok: true; reservationId: string; maximumSeconds: number; providerLimitRef: string }
  | { ok: false; reason: 'quota_exhausted' | 'session_active' | 'unavailable' };
const identifier = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
async function fence(sql: Sql) {
  const [row] = await sql<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
  if (row?.transaction_isolation !== 'read committed') throw new Error('tutorial voice requires read committed');
  // Global cap needs one population across replicas and organizations.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('tutorial-voice-global-admission', 0))`;
}

/** Uses hosted service transactions. Money reservations cannot meter free
 * tutorial seconds. No key, token or question is persisted here. */
export class PostgresTutorialVoiceReservationStore {
  constructor(private readonly options: { readAuthority: TutorialVoiceAuthorityReader; run?: HostedServiceContextRunner }) {}

  async reserve(admission: TutorialVoiceAdmission): Promise<TutorialVoiceReservationResult> {
    if (![admission.controlWorkspaceId, admission.organizationId, admission.userId, admission.sessionId].every(identifier)
      || !Number.isSafeInteger(admission.sessionVersion) || admission.sessionVersion < 0
      || (admission.customerWorkspaceId !== null && !identifier(admission.customerWorkspaceId))) {
      throw new Error('invalid tutorial voice identity');
    }
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const authority = await this.options.readAuthority(sql, admission);
      if (!authority || !positive(authority.maximumSeconds) || authority.maximumSeconds > 7200
        || !identifier(authority.providerLimitRef)
        || !['global', 'user', 'organization', 'workspace'].every(k =>
          positive(authority.dailySeconds?.[k as keyof TutorialVoiceQuotaAuthority['dailySeconds']]))) {
        return { ok: false, reason: 'unavailable' };
      }
      const [active] = await sql`SELECT id FROM papercusp_auth.tutorial_voice_reservations
        WHERE user_id = ${admission.userId} AND provider_final_ref IS NULL LIMIT 1`;
      if (active) return { ok: false, reason: 'session_active' };
      // Read database time once AFTER the lock: a waiter crossing midnight
      // charges its admission day, with one stable value throughout the query.
      const [clock] = await sql<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`;
      const [totals] = await sql<{ global: string; user: string; organization: string; workspace: string }[]>`
        SELECT COALESCE(sum(maximum_seconds), 0)::text AS global,
          COALESCE(sum(maximum_seconds) FILTER (WHERE user_id = ${admission.userId}), 0)::text AS user,
          COALESCE(sum(maximum_seconds) FILTER (WHERE organization_id = ${admission.organizationId}), 0)::text AS organization,
          COALESCE(sum(maximum_seconds) FILTER (WHERE organization_id = ${admission.organizationId}
            AND control_workspace_id = ${admission.controlWorkspaceId}
            AND customer_workspace_id = ${admission.customerWorkspaceId}), 0)::text AS workspace
        FROM papercusp_auth.tutorial_voice_reservations WHERE day = ${clock.day}::date`;
      const buckets: (keyof TutorialVoiceQuotaAuthority['dailySeconds'])[] = ['global', 'user', 'organization'];
      if (admission.customerWorkspaceId !== null) buckets.push('workspace');
      for (const key of buckets) {
        if (BigInt(totals[key]) + BigInt(authority.maximumSeconds) > BigInt(authority.dailySeconds[key])) {
          return { ok: false, reason: 'quota_exhausted' };
        }
      }
      const reservationId = randomUUID();
      await sql`INSERT INTO papercusp_auth.tutorial_voice_reservations
        (id, control_workspace_id, organization_id, user_id, customer_workspace_id, day, maximum_seconds, provider_limit_ref)
        VALUES (${reservationId}::uuid, ${admission.controlWorkspaceId}, ${admission.organizationId},
          ${admission.userId}, ${admission.customerWorkspaceId}, ${clock.day}::date,
          ${authority.maximumSeconds}, ${authority.providerLimitRef})`;
      return { ok: true, reservationId, maximumSeconds: authority.maximumSeconds, providerLimitRef: authority.providerLimitRef };
    });
  }

  /** Only a server verifier may establish finality, including token expiry/replay
   * liability. Browser cancellation cannot release this. No seconds are refunded. */
  async recordProviderFinal(reservationId: string, evidenceRef: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(reservationId) || !identifier(evidenceRef)) throw new Error('invalid provider finality');
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const rows = await sql`UPDATE papercusp_auth.tutorial_voice_reservations
        SET provider_final_ref = ${evidenceRef}
        WHERE id = ${reservationId}::uuid AND provider_final_ref IS NULL RETURNING id`;
      return rows.length === 1;
    });
  }
}
