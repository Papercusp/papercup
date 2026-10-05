/**
 * R-8 (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-012, D-013): installing and configuring a trigger-pack package materializes
 * its targets and binding graph as DISARMED trigger bindings bound to
 * installer-local sources and inputs, and returns the installed resource ids.
 *
 * Drives the real install core (`installPluginFromCupboardCore`) with a fake
 * clone, against a migrated throwaway Postgres.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createExternalTriggerSource } from '../external-triggers/admin';
import type { RegisteredProvider } from '../integrations/provider-registry';
import { installPluginFromCupboardCore, type InstallPluginCoreDeps, InstallPluginError } from './install-plugin-core';
import { materializeTriggerPack, TRIGGER_PACK_EDGE_EVENT_KEY } from './trigger-pack-materialize';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const BASE_WS = 'trigger-pack-materialize-e2e';
// Plan slugs are a workspace-level identity, so each test installs into a fresh workspace.
let WS = BASE_WS;
let workspaceSeq = 0;
const HARNESS = 'pack-home';
const PLUGIN = '@pack-publisher/portable-mail-workflow';
const REPLY_SLUG = 'pack-reply-2026-10-05';
const FOLLOW_SLUG = 'pack-follow-up-2026-10-05';

/** A startable template: it carries its own BAR source, like the flagship templates. */
export function packTemplate(slug: string, title: string, withBars = true): string {
  const requirement = JSON.stringify({
    intent: {
      request: `${title} handles one triggering event.`,
      constraints: ['Read the triggering event through triggers:read-payload.'],
      sourceRefs: ['P-001'],
    },
    acceptance: {
      condition: 'A run of this template handles exactly one triggering event.',
      falsifier: 'A run completes without handling its event, or handles it twice.',
      requiredScope: ['tree'],
      evidencePlane: 'tree',
    },
    verification: {
      method: 'Fire the pack binding through the binding engine and read the resulting run.',
      check: { kind: 'instrument', instrumentKey: 'none' },
      replication: 'Run the trigger-pack integration suites.',
    },
  });
  const bars = withBars
    ? `## Requirements\n\n**R-1 — Handle the event.**\n\`\`\`requirement\n${requirement}\n\`\`\`\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n\n`
    : '';
  return `---\ntitle: ${title}\nslug: ${slug}\nstatus: ready\ncreated: 2026-10-05\nupdated: 2026-10-05\n---\n\n# ${title}\n\n## Now\n\n**State:** Ready pack template.\n\n**Next:** Handle the triggering event.\n\n${bars}## Phase 1 — Handle\n\n- **P-001** \`todo\` Read the triggering event and handle it.\n`;
}

export const PLAN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'tone'],
  properties: { trigger: { type: 'object', additionalProperties: true }, tone: { type: 'string' } },
};

/** A portable pack: no provider, account, source id or plan-run id anywhere. */
export function portablePackManifest(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'plugin',
    name: PLUGIN,
    version: '1.0.0',
    papercusp: '^0.1.0',
    description: 'Portable mail workflow: reply to inbound mail, then follow up.',
    author: 'Pack Publisher',
    publisher: '@pack-publisher',
    license: 'MIT',
    versionPin: { mode: 'exact' },
    capabilities: [],
    triggerPack: {
      inputs: {
        type: 'object',
        additionalProperties: false,
        required: ['tone'],
        properties: { tone: { type: 'string' } },
      },
      defaultStormPolicy: { maxRuns: 2, windowSeconds: 3600 },
      targets: [
        { id: 'reply', kind: 'plan', path: 'plan-reply.md', inputSchema: PLAN_INPUT_SCHEMA },
        { id: 'follow-up', kind: 'plan', path: 'plan-follow-up.md', inputSchema: PLAN_INPUT_SCHEMA },
      ],
      bindings: [
        {
          id: 'inbound-mail',
          source: { kind: 'external', datatype: 'email-message', capabilities: ['mail.read'] },
          target: 'reply',
          eventPattern: 'ext:*:message.received',
          filter: { direction: 'inbound' },
        },
        { id: 'after-reply', source: { kind: 'internal', event: 'binding-run-completed' }, target: 'follow-up' },
        { id: 'manual-follow-up', source: { kind: 'manual' }, target: 'follow-up' },
      ],
      edges: [{ from: 'inbound-mail', to: 'after-reply', event: 'binding-run-completed', correlation: 'inherit' }],
    },
    ...overrides,
  };
}

/** Two installed providers: a Graph-shaped one and gmail, both producing email-message. */
export const fakeRegistry = {
  get(kind: string) {
    const capabilities: Record<string, string[]> = {
      'outlook-fixture': ['mail.read'],
      gmail: ['mail.read', 'mail.draft'],
    };
    if (!capabilities[kind]) return undefined;
    return { descriptor: { id: kind, datatypes: ['email-message'], capabilities: capabilities[kind] } } as unknown as RegisteredProvider;
  },
};

export async function writePackDir(dir: string, manifest: Record<string, unknown>, withBars = true): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(join(dir, 'plan-reply.md'), packTemplate(REPLY_SLUG, 'Pack reply', withBars));
  await fs.writeFile(join(dir, 'plan-follow-up.md'), packTemplate(FOLLOW_SLUG, 'Pack follow-up', withBars));
}

export async function seedPackWorkspace(sql: Sql, ws: string, harness: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${ws}, ${harness}, ${Buffer.from(`pk:${ws}:${harness}`)}, ${'kc-' + ws}, 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (${ws}, ${JSON.stringify({ projects: [{ slug: harness, path: `/tmp/${harness}`, harness_kind: 'hive' }] })}::text::jsonb)
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
  await sql`
    INSERT INTO harness_shared.datatype_registry
      (workspace_id, id, title, description, tier, payload_schema, authoritative_writer)
    VALUES (${ws}, 'email-message', 'Email message', 'Normalized email event', 'workspace',
            '{"type":"object","additionalProperties":true}'::jsonb, 'papercusp')
    ON CONFLICT (workspace_id, id) DO NOTHING`;
}

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let packDir: string;

function installDeps(dir: string): InstallPluginCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(dir, dest, { recursive: true });
    },
    globalPluginsDir: () => join(scratch, 'global-plugins'),
    tmpDir: () => join(scratch, 'tmp'),
    grant: async () => undefined,
    invalidateHost: async () => undefined,
    materializeTriggerPack: (args) => materializeTriggerPack(sql, WS, args, { registry: fakeRegistry }),
  };
}

const GITHUB = 'https://github.com/pack-publisher/portable-mail-workflow';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  // Seeded plans carry RESTRICT-referenced BAR clauses and a workspace-scoped
  // acceptance identity, so each test gets a fresh workspace instead of deletes.
  WS = `${BASE_WS}-${++workspaceSeq}`;
  await seedPackWorkspace(sql, WS, HARNESS);
  scratch = await fs.mkdtemp(join(tmpdir(), 'trigger-pack-materialize-'));
  await fs.mkdir(join(scratch, 'tmp'), { recursive: true });
  packDir = join(scratch, 'pack');
  await writePackDir(packDir, portablePackManifest());
});

describe('trigger-pack materialization (R-8)', () => {
  it('materializes plans and disarmed bindings bound to installer-local sources and inputs', async () => {
    const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });

    const result = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'warm' } } },
      installDeps(packDir),
    );
    const installation = result.triggerPackInstallation!;
    expect(installation).toMatchObject({
      harnessSlug: HARNESS,
      pluginName: PLUGIN,
      status: 'configured',
      unmet: [],
      armed: false,
      inputs: { tone: 'warm' },
    });
    expect(installation.resources.plans).toEqual({
      reply: { planSlug: REPLY_SLUG },
      'follow-up': { planSlug: FOLLOW_SLUG },
    });
    expect(installation.resources.entryPoints).toEqual([
      { bindingId: 'manual-follow-up', targetId: 'follow-up', planSlug: FOLLOW_SLUG },
    ]);

    // The plans exist in the INSTALLER's harness.
    const plans = await sql<Array<{ slug: string }>>`
      SELECT plan_slug AS slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} ORDER BY plan_slug`;
    expect(plans.map((plan) => plan.slug)).toEqual(expect.arrayContaining([FOLLOW_SLUG, REPLY_SLUG]));

    const rows = await sql<
      Array<{
        id: string;
        sourceId: string;
        sourceKind: string;
        armed: boolean;
        eventPattern: string;
        eventFilter: Record<string, unknown>;
        datatypeId: string | null;
        action: Record<string, unknown>;
        planHarnessSlug: string;
        planSlug: string;
        packInstallationId: string;
        stormPolicy: Record<string, unknown>;
      }>
    >`
      SELECT b.id::text AS id, b.source_id::text AS "sourceId", s.kind AS "sourceKind", b.armed,
             b.event_pattern AS "eventPattern", b.event_filter AS "eventFilter", b.datatype_id AS "datatypeId",
             b.action, b.plan_harness_slug AS "planHarnessSlug", b.plan_slug AS "planSlug",
             b.pack_installation_id::text AS "packInstallationId", b.storm_policy AS "stormPolicy"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.data_sources s ON s.id = b.source_id
       WHERE b.workspace_id = ${WS} AND b.detached_at IS NULL`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.armed === false)).toBe(true);
    expect(rows.every((row) => row.packInstallationId === installation.id)).toBe(true);

    const external = rows.find((row) => row.id === installation.resources.bindings['inbound-mail']!.triggerBindingId)!;
    // The portable `ext:*:` pattern binds to the installer's local source and kind.
    expect(external).toMatchObject({
      sourceId: outlook.id,
      eventPattern: 'ext:outlook-fixture:message.received',
      eventFilter: { direction: 'inbound' },
      datatypeId: 'email-message',
      planHarnessSlug: HARNESS,
      planSlug: REPLY_SLUG,
      action: { type: 'launch-plan', input: { tone: 'warm' } },
      stormPolicy: expect.objectContaining({ maxRuns: 2, windowSeconds: 3600 }),
    });

    const edge = rows.find((row) => row.id === installation.resources.bindings['after-reply']!.triggerBindingId)!;
    expect(edge).toMatchObject({
      sourceKind: 'trigger-pack-edge',
      sourceId: installation.resources.edgeSourceId,
      eventPattern: TRIGGER_PACK_EDGE_EVENT_KEY,
      eventFilter: { upstreamBindingId: external.id },
      datatypeId: 'trigger-run-completion',
      planSlug: FOLLOW_SLUG,
      action: { type: 'launch-plan', input: { tone: 'warm' } },
    });

    // Nothing publisher-specific: no installer-foreign source, account or run id.
    const stored = JSON.stringify(rows);
    const manifestText = JSON.stringify(portablePackManifest());
    expect(manifestText).not.toContain(outlook.id);
    expect(stored).not.toContain('pack-publisher');

    // The installation row records what it owns.
    const [row] = await sql<Array<{ status: string; resources: Record<string, unknown> }>>`
      SELECT status, resources FROM harness_shared.trigger_pack_installations
       WHERE workspace_id = ${WS} AND id = ${installation.id}::uuid`;
    expect(row).toMatchObject({ status: 'configured', resources: installation.resources });
  });

  it('leaves an ambiguous portable source unmet, then binds it once the installer maps it', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const gmail = await createExternalTriggerSource(sql, WS, { kind: 'gmail', status: 'connected' });
    // An unrelated provider-less source is never a candidate.
    await createExternalTriggerSource(sql, WS, { kind: 'webhook', status: 'connected' });

    const first = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: { tone: 'warm' } },
      { registry: fakeRegistry },
    );
    expect(first.status).toBe('needs-configuration');
    expect(first.unmet).toEqual([
      expect.objectContaining({
        bindingId: 'inbound-mail',
        reason: 'ambiguous',
        requirement: { kind: 'source', datatype: 'email-message', capabilities: ['mail.read'] },
      }),
      expect.objectContaining({ bindingId: 'after-reply', reason: 'upstream-unmet' }),
    ]);
    expect(first.unmet[0]!.candidates).toHaveLength(2);
    expect(first.resources.bindings).toEqual({});

    const configured = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'warm' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(configured).toMatchObject({ id: first.id, status: 'configured', unmet: [] });
    expect(configured.resources.bindings['inbound-mail']).toMatchObject({ sourceId: gmail.id, kind: 'external' });
    const [external] = await sql<Array<{ eventPattern: string }>>`
      SELECT event_pattern AS "eventPattern" FROM harness_shared.trigger_bindings
       WHERE id = ${configured.resources.bindings['inbound-mail']!.triggerBindingId}::uuid`;
    expect(external!.eventPattern).toBe('ext:gmail:message.received');

    // Re-configuring with the same choices is idempotent and preserves armed state.
    await sql`UPDATE harness_shared.trigger_bindings SET armed = TRUE WHERE workspace_id = ${WS}`;
    const again = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'warm' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(again.resources.bindings).toEqual(configured.resources.bindings);
    const armed = await sql<Array<{ armed: boolean }>>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND detached_at IS NULL`;
    expect(armed.map((row) => row.armed)).toEqual([true, true]);

    // A changed input replaces the bindings: the old ones detach, the new ones start disarmed.
    const changed = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'formal' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(changed.resources.bindings['inbound-mail']!.triggerBindingId).not.toBe(
      configured.resources.bindings['inbound-mail']!.triggerBindingId,
    );
    const live = await sql<Array<{ armed: boolean; input: Record<string, unknown> }>>`
      SELECT armed, action -> 'input' AS input FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND detached_at IS NULL`;
    expect(live).toEqual([
      { armed: false, input: { tone: 'formal' } },
      { armed: false, input: { tone: 'formal' } },
    ]);
  });

  it('records invalid pack inputs as an unmet requirement', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const installation = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: {} },
      { registry: fakeRegistry },
    );
    expect(installation.status).toBe('needs-configuration');
    expect(installation.unmet).toEqual([expect.objectContaining({ bindingId: 'inputs', reason: 'inputs-invalid' })]);
  });

  it('refuses an unstartable template before writing anything', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const bare = join(scratch, 'bare-pack');
    await writePackDir(bare, portablePackManifest(), false);

    const refusal = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'warm' } } },
      installDeps(bare),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(InstallPluginError);
    expect(refusal).toMatchObject({ status: 422, code: 'trigger_pack_plan_template_unstartable:reply' });

    const [counts] = await sql<Array<{ installations: number; plans: number; bindings: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}) AS installations,
             (SELECT count(*)::int FROM harness_shared.harness_plans
               WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
             (SELECT count(*)::int FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}) AS bindings`;
    expect(counts).toEqual({ installations: 0, plans: 0, bindings: 0 });
    await expect(fs.stat(join(scratch, 'global-plugins', PLUGIN))).rejects.toThrow();
  });

  it('refuses unsupported targets, edges and a foreign plan slug', async () => {
    const base = portablePackManifest();
    const pack = base.triggerPack;
    const recipe = {
      ...base,
      triggerPack: {
        ...pack,
        targets: [...pack.targets, { id: 'tool-call', kind: 'recipe', ref: 'recipe:demo', argsSchema: { type: 'object' } }],
        bindings: [
          ...pack.bindings,
          {
            id: 'mail-to-tool',
            source: { kind: 'external', datatype: 'email-message' },
            target: 'tool-call',
            eventPattern: 'ext:*:message.received',
            mapping: { mode: 'type-match' },
            retry: { maxAttempts: 1, onExhausted: 'dead-letter' },
          },
        ],
      },
    };
    await expect(
      materializeTriggerPack(sql, WS, { manifest: recipe as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_unsupported_target:recipe' });

    const planCompleted = {
      ...base,
      triggerPack: {
        ...pack,
        bindings: [
          pack.bindings[0],
          { id: 'after-reply', source: { kind: 'internal', event: 'plan-completed' }, target: 'follow-up' },
        ],
        edges: [{ from: 'inbound-mail', to: 'after-reply', event: 'plan-completed', correlation: 'inherit' }],
      },
    };
    await expect(
      materializeTriggerPack(sql, WS, { manifest: planCompleted as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_unsupported_edge:plan-completed' });

    await sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, content)
      VALUES (${WS}, ${HARNESS}, ${REPLY_SLUG}, 'Owner plan', 'draft', 'owner-authored')`;
    await expect(
      materializeTriggerPack(sql, WS, { manifest: base as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_plan_slug_conflict' });
    const [owner] = await sql<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${REPLY_SLUG}`;
    expect(owner!.content).toBe('owner-authored');
    const [installations] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}`;
    expect(installations!.n).toBe(0);
  });

  it('refuses a second harness in the same workspace, because plan slugs are workspace-scoped', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const first = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: { tone: 'warm' } },
      { registry: fakeRegistry },
    );
    expect(first.status).toBe('configured');

    await expect(
      materializeTriggerPack(
        sql,
        WS,
        { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: `${HARNESS}-other`, inputs: { tone: 'warm' } },
        { registry: fakeRegistry },
      ),
    ).rejects.toMatchObject({ code: 'trigger_pack_plan_slug_conflict' });
    const [counts] = await sql<Array<{ installations: number; plans: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}) AS installations,
             (SELECT count(*)::int FROM harness_shared.harness_plans
               WHERE workspace_id = ${WS} AND harness_slug = ${`${HARNESS}-other`}) AS plans`;
    expect(counts).toEqual({ installations: 1, plans: 0 });
  });
});
