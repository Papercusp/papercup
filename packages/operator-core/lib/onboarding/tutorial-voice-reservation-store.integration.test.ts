import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { TutorialVoiceAdmission } from '../endpoint-route/routes/hosted-tutorial-progress';
import { PostgresTutorialVoiceReservationStore, validateTutorialVoiceIdentityForUpdate, validateTutorialVoiceLessonForUpdate, withTutorialVoiceTenantContext, type TutorialVoiceQuotaAuthority } from './tutorial-voice-reservation-store';
import { enrollAccountTutorial } from './cloud-tutorial-progress';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { PostgresHostedIdentityDirectory } from '../auth/hosted-identity-binding';
import { readGlobalFlagOverridesForUpdate, readTutorialVoiceGlobalFlagsForUpdate } from '../flag-override-store';

let db: OrgTestDb;
const run: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) => db.appSql.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
  await tx.unsafe('SET LOCAL ROLE hosted_service');
  return fn(tx as unknown as Sql);
}) as Promise<T>;
const admission = (change: Partial<TutorialVoiceAdmission> = {}): TutorialVoiceAdmission => ({
  controlWorkspaceId: randomUUID(), organizationId: randomUUID(), userId: randomUUID(), customerWorkspaceId: null,
  sessionId: 'verified-session', sessionVersion: 1,
  lesson: { version: 3, step: 'welcome', status: 'ready' }, ...change,
});
const authority = (): TutorialVoiceQuotaAuthority => ({ maximumSeconds: 60,
  dailySeconds: { global: 600, user: 120, organization: 180, workspace: 120 }, providerLimitRef: 'fixture:duration-verified' });
const store = (policy = authority()) => new PostgresTutorialVoiceReservationStore({ run,
  readAuthority: async () => policy });
describe('tutorial voice reservations (real hosted service Postgres)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    const armedPath = new URL('../../../../libs/papercusp/libs/db/sql/1451-tutorial-voice-reservations.sql', import.meta.url);
    const path = existsSync(armedPath) ? armedPath : new URL(`${armedPath.href}.DRAFT`);
    const migration = readFileSync(path, 'utf8');
    await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.adminSql`TRUNCATE papercusp_auth.tutorial_voice_reservations`; });

  it('locks persisted global policy through admission and refuses absent or malformed authority', async () => {
    await expect(readGlobalFlagOverridesForUpdate(db.adminSql))
      .rejects.toThrow('flag_override_lock_requires_transaction');
    await db.adminSql`DELETE FROM harness_shared.operator_flag_overrides WHERE workspace_id = '@global'`;
    await db.adminSql.begin(async tx => {
      expect(await readGlobalFlagOverridesForUpdate(tx)).toBeNull();
    });
    await db.adminSql`INSERT INTO harness_shared.operator_flag_overrides (workspace_id, payload)
      VALUES ('@global', '{"fixture-policy":true}'::jsonb)`;
    await db.adminSql.begin(async tx => {
      expect(await readGlobalFlagOverridesForUpdate(tx)).toEqual({ 'fixture-policy': true });
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await writer`UPDATE harness_shared.operator_flag_overrides
          SET payload = '{"fixture-policy":false}'::jsonb WHERE workspace_id = '@global'`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await db.adminSql`UPDATE harness_shared.operator_flag_overrides
      SET payload = '{"fixture-policy":false}'::jsonb WHERE workspace_id = '@global'`;
    await db.adminSql.begin(async tx => {
      expect(await readGlobalFlagOverridesForUpdate(tx)).toEqual({ 'fixture-policy': false });
    });
    await db.adminSql`UPDATE harness_shared.operator_flag_overrides
      SET payload = '{"fixture-policy":"true"}'::jsonb WHERE workspace_id = '@global'`;
    await db.adminSql.begin(async tx => {
      expect(await readGlobalFlagOverridesForUpdate(tx)).toBeNull();
    });
  });

  it('does not grant hosted service direct access to global operator policy', async () => {
    await db.adminSql`INSERT INTO harness_shared.operator_flag_overrides (workspace_id, payload)
      VALUES ('@global', '{"fixture-policy":true}'::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
    await expect(run(tx => readGlobalFlagOverridesForUpdate(tx)))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('does not let service admission bypass the persisted lesson tenant boundary', async () => {
    await expect(run(async tx => {
      await tx`SELECT set_config('app.organization_id', ${randomUUID()}, true),
        set_config('app.user_id', ${randomUUID()}, true)`;
      return tx`SELECT profile FROM papercusp_auth.hosted_user_preferences FOR UPDATE`;
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('retains tenant preference locks across scoped service role restoration', async () => {
    const organizationId = randomUUID(); const userId = randomUUID();
    await db.adminSql`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id)
      VALUES (${organizationId}::uuid, ${userId}::uuid)`;
    await run(async tx => {
      const [before] = await tx`SELECT current_user AS role,
        current_setting('app.workspace_id', true) AS workspace`;
      expect(before.role).toBe('hosted_service');
      const context = { principal: { kind: 'user' as const, profile: 'hosted' as const,
        authMethod: 'cookie-session' as const, trust: 'verified' as const, slug: userId,
        workspaceId: randomUUID(), userId, activeOrganizationId: organizationId,
        sessionId: 'verified-session', sessionVersion: 1 } };
      const rows = await withTutorialVoiceTenantContext(tx, context, scoped => scoped`
        SELECT user_id FROM papercusp_auth.hosted_user_preferences
        WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`);
      expect(rows).toHaveLength(1);
      const [after] = await tx`SELECT current_user AS role,
        current_setting('app.workspace_id', true) AS workspace,
        current_setting('app.organization_id', true) AS organization,
        current_setting('app.user_id', true) AS "user"`;
      expect(after).toEqual({ ...before, organization: '', user: '' });
      await expect(withTutorialVoiceTenantContext(tx, context, async scoped => {
        await scoped`SELECT 1 / 0`;
      })).rejects.toMatchObject({ code: '22012' });
      const [restored] = await tx`SELECT current_user AS role,
        current_setting('app.workspace_id', true) AS workspace,
        current_setting('app.organization_id', true) AS organization,
        current_setting('app.user_id', true) AS "user"`;
      expect(restored).toEqual(after);
      expect(await withTutorialVoiceTenantContext(tx, { principal: { ...context.principal,
        activeOrganizationId: randomUUID() } }, scoped => scoped`
          SELECT user_id FROM papercusp_auth.hosted_user_preferences
          WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`)).toHaveLength(0);
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await writer`UPDATE papercusp_auth.hosted_user_preferences SET profile = '{}'::jsonb
          WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences SET profile = '{}'::jsonb
      WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
  });

  it('reads global policy through the service-only bridge and retains its lock until admission commits', async () => {
    await expect(readTutorialVoiceGlobalFlagsForUpdate(db.appSql))
      .rejects.toThrow('flag_override_lock_requires_transaction');
    await db.adminSql`INSERT INTO harness_shared.operator_flag_overrides (workspace_id, payload)
      VALUES ('@global', '{"fixture-policy":true}'::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
    await run(async tx => {
      expect(await readTutorialVoiceGlobalFlagsForUpdate(tx)).toEqual({ 'fixture-policy': true });
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await writer`UPDATE harness_shared.operator_flag_overrides SET payload = '{}'::jsonb
          WHERE workspace_id = '@global'`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    for (const payload of ['[]', '{"fixture-policy":"true"}']) {
      await db.adminSql`UPDATE harness_shared.operator_flag_overrides SET payload = ${payload}::jsonb
        WHERE workspace_id = '@global'`;
      expect(await run(tx => readTutorialVoiceGlobalFlagsForUpdate(tx))).toBeNull();
    }
    await db.adminSql`DELETE FROM harness_shared.operator_flag_overrides WHERE workspace_id = '@global'`;
    expect(await run(tx => readTutorialVoiceGlobalFlagsForUpdate(tx))).toBeNull();
    await expect(db.appSql.begin(tx => tx`SELECT papercusp_auth.lock_tutorial_voice_global_flags()`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('holds workspace tenant ownership against deletion and reassignment until commit', async () => {
    const control = randomUUID(); const workspace = randomUUID(); const host = randomUUID(); const connection = randomUUID();
    const input = { userId: randomUUID(), sessionId: `hs_${'A'.repeat(43)}`, sessionVersion: 1,
      organizationId: randomUUID(), customerWorkspaceId: workspace, controlPlaneWorkspaceId: control };
    await db.adminSql`INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
      VALUES (${control}, ${connection}, 'gcp', 'Voice fixture', 'fixture://no-provider', 'connected')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
      VALUES (${control}, ${host}, 'Voice fixture', ${connection}, 'gcp', 'fixture',
        'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
    await db.adminSql`INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
      VALUES (${control}, ${workspace}, ${input.organizationId}, ${host}, 'Voice fixture', 'active', 'user', ${input.userId})`;
    await db.adminSql.begin(async tx => {
      const reader = new PostgresHostedMembershipAuthority(tx);
      expect(await reader.workspaceBelongsToOrganizationForUpdate(input)).toBe(true);
      expect(await reader.workspaceBelongsToOrganizationForUpdate({ ...input, controlPlaneWorkspaceId: randomUUID() })).toBe(false);
      for (const change of ['delete', 'reassign']) {
        await expect(db.adminSql.begin(async writer => {
          await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
          if (change === 'delete') {
            await writer`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
              WHERE workspace_id = ${control} AND id = ${workspace}`;
          } else {
            await writer`UPDATE harness_shared.customer_workspaces SET organization_id = ${randomUUID()}
              WHERE workspace_id = ${control} AND id = ${workspace}`;
          }
        })).rejects.toMatchObject({ code: '55P03' });
      }
    });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${control} AND id = ${workspace}`;
    await db.adminSql.begin(async tx => {
      expect(await new PostgresHostedMembershipAuthority(tx).workspaceBelongsToOrganizationForUpdate(input)).toBe(false);
    });
  });

  it('holds both identity link and user lifecycle through the admission transaction', async () => {
    const [user] = await db.adminSql`INSERT INTO papercusp_auth.hosted_users DEFAULT VALUES RETURNING id`;
    const subject = randomUUID();
    await db.adminSql`INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject)
      VALUES (${user.id}, 'workos', ${subject})`;
    const input = { providerId: 'workos', subject };
    await expect(new PostgresHostedIdentityDirectory(db.adminSql).resolveLinkedUserForUpdate(input))
      .rejects.toThrow('hosted_identity_lock_requires_transaction');
    await db.adminSql.begin(async tx => {
      expect(await new PostgresHostedIdentityDirectory(tx).resolveLinkedUserForUpdate(input))
        .toEqual({ userId: user.id });
      for (const table of ['external_identities', 'hosted_users']) {
        await expect(db.adminSql.begin(async writer => {
          await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
          if (table === 'external_identities') {
            await writer`UPDATE papercusp_auth.external_identities SET status = 'deactivated', deactivated_at = now()
              WHERE provider = 'workos' AND subject = ${subject}`;
          } else {
            await writer`UPDATE papercusp_auth.hosted_users SET status = 'deactivated', deactivated_at = now()
              WHERE id = ${user.id}`;
          }
        })).rejects.toMatchObject({ code: '55P03' });
      }
    });
    await db.adminSql`UPDATE papercusp_auth.hosted_users SET status = 'deactivated', deactivated_at = now()
      WHERE id = ${user.id}`;
    await db.adminSql.begin(async tx => {
      expect(await new PostgresHostedIdentityDirectory(tx).resolveLinkedUserForUpdate(input)).toBeNull();
    });
  });

  it('holds active membership authority against concurrent revocation until commit', async () => {
    const [user] = await db.adminSql`INSERT INTO papercusp_auth.hosted_users (primary_email)
      VALUES (${`${randomUUID()}@example.test`}) RETURNING id`;
    const [organization] = await db.adminSql`INSERT INTO papercusp_auth.organizations
      (identity_provider, external_organization_id, display_name)
      VALUES ('workos', ${randomUUID()}, 'Voice membership fixture') RETURNING id`;
    const input = { userId: user.id, organizationId: organization.id };
    await db.adminSql`INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
      VALUES (${organization.id}, ${user.id}, 'owner', 'active', 'papercusp', 'organization_bootstrap')`;
    await expect(new PostgresHostedMembershipAuthority(db.adminSql).resolveActiveForUpdate(input))
      .rejects.toThrow('hosted_membership_lock_requires_transaction');
    await db.adminSql.begin(async tx => {
      expect(await new PostgresHostedMembershipAuthority(tx).resolveActiveForUpdate(input)).not.toBeNull();
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await writer`UPDATE papercusp_auth.organization_memberships SET status = 'revoked', revoked_at = now()
          WHERE organization_id = ${organization.id} AND user_id = ${user.id}`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await db.adminSql`UPDATE papercusp_auth.organization_memberships SET status = 'revoked', revoked_at = now()
      WHERE organization_id = ${organization.id} AND user_id = ${user.id}`;
    await db.adminSql.begin(async tx => {
      expect(await new PostgresHostedMembershipAuthority(tx).resolveActiveForUpdate(input)).toBeNull();
    });
  });

  it('holds persisted session authority until the admission transaction commits', async () => {
    const sessions = new HostedSessionStore(db.adminSql);
    const session = await sessions.create({ userId: randomUUID(), organizationId: randomUUID(),
      permissionVersion: 1, upstreamProvider: 'fixture', upstreamSessionId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000) });
    await expect(sessions.resolveForUpdate(session.id)).rejects.toThrow('hosted_session_lock_requires_transaction');
    await db.adminSql.begin(async tx => {
      const locked = new HostedSessionStore(tx);
      expect(await locked.resolveForUpdate(session.id, { expectedPermissionVersion: 1 })).not.toBeNull();
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await new HostedSessionStore(writer).revoke(session.id, 'fixture-revocation');
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect(await sessions.revoke(session.id, 'fixture-revocation')).toBe(true);
    await db.adminSql.begin(async tx => {
      expect(await new HostedSessionStore(tx).resolveForUpdate(session.id)).toBeNull();
    });
  });

  it('binds verified upstream subject to locked local session, user and membership', async () => {
    const [user] = await db.adminSql`INSERT INTO papercusp_auth.hosted_users DEFAULT VALUES RETURNING id`;
    const subject = randomUUID();
    await db.adminSql`INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject)
      VALUES (${user.id}, 'workos', ${subject})`;
    const [organization] = await db.adminSql`INSERT INTO papercusp_auth.organizations
      (identity_provider, external_organization_id, display_name)
      VALUES ('workos', ${randomUUID()}, 'Voice identity fixture') RETURNING id`;
    await db.adminSql`INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
      VALUES (${organization.id}, ${user.id}, 'owner', 'active', 'papercusp', 'organization_bootstrap')`;
    const member = await new PostgresHostedMembershipAuthority(db.adminSql).resolveActive({ userId: user.id, organizationId: organization.id });
    const session = await new HostedSessionStore(db.adminSql).create({ userId: user.id, organizationId: organization.id,
      permissionVersion: member!.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000) });
    const input = admission({ userId: user.id, organizationId: organization.id, sessionId: session.id, sessionVersion: member!.permissionVersion });
    let externalUserId = subject; let verified = true; let externalSessionId = session.upstreamSessionId;
    const provider = { providerId: 'workos', validateSession: async () => ({ ok: true as const, value: {
      externalSessionId, identity: { externalUserId, primaryEmail: 'not-authority@example.test', emailVerified: verified as true },
      issuedAtMs: Date.now(), authenticatedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      authenticationMethods: [], mfaVerified: false,
    } }) };
    await expect(validateTutorialVoiceIdentityForUpdate(db.adminSql, input, provider)).rejects.toThrow('hosted_session_lock_requires_transaction');
    // Migration 1418 enrolls new active memberships; explicitly remove that
    // automatic fixture enrollment to exercise the absent-record refusal.
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences SET profile = profile - 'productTutorial'
      WHERE organization_id = ${organization.id}::uuid AND user_id = ${user.id}::uuid`;
    expect(await run(tx => validateTutorialVoiceLessonForUpdate(tx, input, provider))).toBe(false);
    await db.adminSql.begin(tx => enrollAccountTutorial(tx as unknown as Sql,
      { tenantId: organization.id, userId: user.id }));
    await run(async tx => {
      expect(await validateTutorialVoiceLessonForUpdate(tx, input, provider)).toBe(true);
      expect(await validateTutorialVoiceLessonForUpdate(tx, { ...input,
        lesson: { ...input.lesson, step: 'navigation' } }, provider)).toBe(false);
      await expect(db.adminSql.begin(async writer => {
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await writer`UPDATE papercusp_auth.hosted_user_preferences SET profile = '{}'::jsonb
          WHERE organization_id = ${organization.id}::uuid AND user_id = ${user.id}::uuid`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences
      SET profile = jsonb_set(profile, '{productTutorial,3,disposition}', '"paused"'::jsonb)
      WHERE organization_id = ${organization.id}::uuid AND user_id = ${user.id}::uuid`;
    expect(await run(tx => validateTutorialVoiceLessonForUpdate(tx, input, provider))).toBe(false);
    await run(async tx => {
      expect(await validateTutorialVoiceIdentityForUpdate(tx, input, provider)).toBe(true);
      externalUserId = randomUUID();
      expect(await validateTutorialVoiceIdentityForUpdate(tx, input, provider)).toBe(false);
      externalUserId = subject; verified = false;
      expect(await validateTutorialVoiceIdentityForUpdate(tx, input, provider)).toBe(false);
      verified = true; externalSessionId = randomUUID();
      expect(await validateTutorialVoiceIdentityForUpdate(tx, input, provider)).toBe(false);
      externalSessionId = session.upstreamSessionId;
      expect(await validateTutorialVoiceIdentityForUpdate(tx, { ...input, userId: randomUUID() }, provider)).toBe(false);
      expect(await validateTutorialVoiceIdentityForUpdate(tx, { ...input, sessionVersion: input.sessionVersion + 1 }, provider)).toBe(false);
    });
    await db.adminSql`UPDATE papercusp_auth.hosted_users SET status = 'deactivated', deactivated_at = now() WHERE id = ${user.id}`;
    expect(await run(tx => validateTutorialVoiceIdentityForUpdate(tx, input, provider))).toBe(false);
  });

  it('checks session expiry after the persisted authority read and refuses a stale version', async () => {
    const now = new Date(); const expiry = new Date(now.getTime() + 60_000);
    const session = await new HostedSessionStore(db.adminSql, () => now).create({
      userId: randomUUID(), organizationId: randomUUID(), permissionVersion: 1,
      upstreamProvider: 'fixture', upstreamSessionId: randomUUID(), expiresAt: expiry });
    await db.adminSql.begin(async tx => {
      expect(await new HostedSessionStore(tx).resolveForUpdate(session.id,
        { expectedPermissionVersion: 2 })).toBeNull();
      let sampledAfterRead = false;
      const query = Object.assign(async (...args: any[]) => {
        const rows = await (tx as any)(...args); sampledAfterRead = true; return rows;
      }, { unsafe: tx.unsafe.bind(tx) });
      const store = new HostedSessionStore(query as any, () => {
        expect(sampledAfterRead).toBe(true); return expiry;
      });
      expect(await store.resolveForUpdate(session.id)).toBeNull();
    });
  });

  it('allows account admission without workspace and charges full duration after finality', async () => {
    const input = admission(); const s = store(); const first = await s.reserve(input);
    expect(first.ok).toBe(true); if (!first.ok) throw new Error('admission refused');
    expect(await s.recordProviderFinal(first.reservationId, 'fixture:final')).toBe(true);
    expect(await s.recordProviderFinal(first.reservationId, 'fixture:replay')).toBe(false);
    const second = await s.reserve(input); expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second admission refused');
    await s.recordProviderFinal(second.reservationId, 'fixture:final2');
    expect(await s.reserve(input)).toEqual({ ok: false, reason: 'quota_exhausted' });
  });
  it('serializes same-user admission across replicas, orgs and control planes', async () => {
    const userId = randomUUID();
    const results = await Promise.all([store().reserve(admission({ userId })), store().reserve(admission({ userId }))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: 'session_active' }]);
  });
  it('serializes the global daily cap across unrelated tenants', async () => {
    const policy = authority(); policy.dailySeconds.global = 60;
    const results = await Promise.all([store(policy).reserve(admission()), store(policy).reserve(admission())]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: 'quota_exhausted' }]);
  });
  it('keeps daily user quota global after finality and organization switching', async () => {
    const input = admission(); const policy = authority(); policy.dailySeconds.user = 60;
    const s = store(policy); const first = await s.reserve(input);
    if (!first.ok) throw new Error('admission refused');
    await s.recordProviderFinal(first.reservationId, 'fixture:final');
    expect(await s.reserve(admission({ userId: input.userId }))).toEqual({ ok: false, reason: 'quota_exhausted' });
  });
  it('refuses invalid caps and unverified provider bounds before reserving', async () => {
    for (const policy of [ { ...authority(), maximumSeconds: 7201 },
      { ...authority(), providerLimitRef: '' },
      { ...authority(), dailySeconds: { ...authority().dailySeconds, global: 0 } } ]) {
      expect(await store(policy).reserve(admission())).toEqual({ ok: false, reason: 'unavailable' });
    }
    const [count] = await db.adminSql`SELECT count(*)::int AS n FROM papercusp_auth.tutorial_voice_reservations`;
    expect(count.n).toBe(0);
  });
  it('database uniqueness catches alternate service writers bypassing the store', async () => {
    const input = admission(); expect((await store().reserve(input)).ok).toBe(true);
    await expect(run(sql => sql`INSERT INTO papercusp_auth.tutorial_voice_reservations
      (id, control_workspace_id, organization_id, user_id, day, maximum_seconds, provider_limit_ref)
      VALUES (${randomUUID()}::uuid, 'other-control', 'other-org', ${input.userId},
        (clock_timestamp() AT TIME ZONE 'UTC')::date, 60, 'fixture:limit')`.then(() => undefined)))
      .rejects.toMatchObject({ code: '23505' });
  });
  it('enforces organization and selected workspace buckets', async () => {
    for (const bucket of ['organization', 'workspace'] as const) {
      await db.adminSql`TRUNCATE papercusp_auth.tutorial_voice_reservations`;
      const policy = authority(); policy.dailySeconds[bucket] = 60;
      const input = admission({ customerWorkspaceId: randomUUID() });
      expect((await store(policy).reserve(input)).ok).toBe(true);
      expect(await store(policy).reserve({ ...input, userId: randomUUID() })).toEqual({ ok: false, reason: 'quota_exhausted' });
    }
  });
  it('requires fresh server authority and rolls back failed authority reads', async () => {
    const input = admission();
    expect(await new PostgresTutorialVoiceReservationStore({ run, readAuthority: async () => null }).reserve(input))
      .toEqual({ ok: false, reason: 'unavailable' });
    await expect(new PostgresTutorialVoiceReservationStore({ run, readAuthority: async () => { throw new Error('stale lesson'); } })
      .reserve(input)).rejects.toThrow('stale lesson');
    expect((await store().reserve(input)).ok).toBe(true);
  });
  it('refuses incomplete session snapshots before consulting authority or reserving', async () => {
    let consulted = false;
    const s = new PostgresTutorialVoiceReservationStore({ run, readAuthority: async () => {
      consulted = true; return authority();
    } });
    for (const patch of [{ sessionId: '' }, { sessionVersion: -1 }, { sessionVersion: 0.5 },
      { sessionVersion: Number.NaN }]) {
      await expect(s.reserve(admission(patch))).rejects.toThrow('invalid tutorial voice identity');
    }
    expect(consulted).toBe(false);
    const [count] = await db.adminSql`SELECT count(*)::int AS n FROM papercusp_auth.tutorial_voice_reservations`;
    expect(count.n).toBe(0);
  });
  it('retains uncertain/crashed reservations beyond day rollover', async () => {
    const input = admission(); const id = randomUUID();
    await run(sql => sql`INSERT INTO papercusp_auth.tutorial_voice_reservations
      (id, control_workspace_id, organization_id, user_id, day, maximum_seconds, provider_limit_ref)
      VALUES (${id}::uuid, ${input.controlWorkspaceId}, ${input.organizationId}, ${input.userId},
        ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1), 60, 'fixture:limit')`.then(() => undefined));
    expect(await store().reserve(input)).toEqual({ ok: false, reason: 'session_active' });
  });
  it('rolls back authority transaction writes when revalidation throws', async () => {
    const input = admission();
    const s = new PostgresTutorialVoiceReservationStore({ run, readAuthority: async sql => {
      await sql`INSERT INTO papercusp_auth.tutorial_voice_reservations
        (id, control_workspace_id, organization_id, user_id, day, maximum_seconds, provider_limit_ref)
        VALUES (${randomUUID()}::uuid, ${input.controlWorkspaceId}, ${input.organizationId}, ${input.userId},
          (clock_timestamp() AT TIME ZONE 'UTC')::date, 60, 'fixture:limit')`;
      throw new Error('authority revoked');
    } });
    await expect(s.reserve(input)).rejects.toThrow('authority revoked');
    expect((await store().reserve(input)).ok).toBe(true);
  });
  it('denies browser roles and immutable exposure rewrites', async () => {
    const result = await store().reserve(admission()); if (!result.ok) throw new Error('admission refused');
    await expect(db.appSql`SELECT * FROM papercusp_auth.tutorial_voice_reservations`).rejects.toMatchObject({ code: '42501' });
    await expect(run(sql => sql`UPDATE papercusp_auth.tutorial_voice_reservations SET maximum_seconds = 1
      WHERE id = ${result.reservationId}::uuid`.then(() => undefined))).rejects.toMatchObject({ code: '42501' });
    await expect(db.adminSql`DELETE FROM papercusp_auth.tutorial_voice_reservations`).rejects.toMatchObject({ code: '23514' });
  });
});
