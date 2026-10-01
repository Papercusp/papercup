/**
 * P-014 (plan blueprint-backed-work-item-execution-2026-09-23) — the published
 * blueprint-operation examples are executed VERBATIM against the current build.
 *
 * The page `harness/blueprint-operations.mdx` (authored with docs:author;
 * Postgres is canonical, the .mdx is its projection) marks every executable
 * fence `runnable=<id>`. This suite extracts those fences and:
 *   • compiles + projects the documented blueprint declaration;
 *   • checks the documented tool names/routes against the projection registry;
 *   • drives the documented direct agent and program operations through REAL
 *     projected dispatch on HTTP and MCP (same harness as operation-tools
 *     P-017), validating every handle/status/events/result against the shared
 *     contract schemas and the settled output against the DECLARED resultSchema;
 *   • transpiles and runs the documented typed-client TypeScript snippet.
 * A fence the suite does not know fails the build, as does a runnable id the
 * suite expects but the page lost — so page and test cannot drift apart.
 *
 * Settlement of the direct work item (the executor writing its validated
 * blueprintResult) is simulated with the same durable write the P-017 suite
 * uses; executor behaviour itself is covered by the P-008/P-009 suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { handleHttpToolRequest, lookupByMcpName, type HttpToolHostExtras, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { unwrapToolResult, type ToolResult } from '@papercusp/tooldef';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { projectBlueprintToPg } from './project-to-pg';
import { openBlueprintOperationWait, type BlueprintOperationHandle } from './operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS,
  BlueprintOperationCancelReceiptSchema,
  BlueprintOperationEventsPageSchema,
  BlueprintOperationInputReceiptSchema,
  BlueprintOperationResultSchema,
  BlueprintOperationStatusSchema,
  SubmitResultSchema,
} from './operation-contract';
import { BlueprintOperationClient, createProjectedBlueprintOperationPort } from './operation-client';
import { P013B_OPERATION, P013B_TEMPLATE, P013B_TEMPLATE_CONTENT } from './operation-performance-b-driver';
import { redactTriggerArgsForPlanInputs } from '../external-triggers/plan-run-payload';
import { runProgramCore } from '../coord-ops/program-runner';
import { programOperationOutput } from './program-operation-output';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point this suite at a mutated copy (copy-out mode).
const DOC_PATH = process.env.PAPERCUSP_BLUEPRINT_OPERATIONS_DOC_PROBE_PATH
  ?? resolve(REPO_ROOT, 'apps/operator-docs/src/content/docs/harness/blueprint-operations.mdx');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

/** Every fenced block of the page: language, meta, body. */
function fences(markdown: string): Array<{ lang: string; meta: string; body: string }> {
  const out: Array<{ lang: string; meta: string; body: string }> = [];
  const re = /^```(\w*)([^\n]*)\n([\s\S]*?)^```\s*$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) out.push({ lang: m[1], meta: m[2].trim(), body: m[3] });
  return out;
}
const PAGE = readFileSync(DOC_PATH, 'utf8');
const ALL_FENCES = fences(PAGE);
const RUNNABLE = new Map(ALL_FENCES.flatMap((f) => {
  const id = /(?:^|\s)runnable=([\w-]+)/.exec(f.meta)?.[1];
  return id ? [[id, f] as const] : [];
}));
const EXPECTED_RUNNABLE = [
  'declaration', 'tool-routes', 'submit', 'signal', 'resume', 'cancel', 'submit-program', 'typed-client',
  'plan-target', 'trigger-operation', 'trigger-bind', 'trigger-migrate', 'schedule-operation',
];
const json = <T = Record<string, unknown>>(id: string): T => {
  const fence = RUNNABLE.get(id);
  if (!fence) throw new Error(`runnable fence ${id} missing from ${DOC_PATH}`);
  return JSON.parse(fence.body) as T;
};

/** Minimal JSON-schema check for the documented object/string/boolean subset —
 * enough to prove a result matches the DECLARED schema, not the contract's. */
function conforms(schema: Record<string, unknown>, value: unknown): boolean {
  switch (schema.type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const record = value as Record<string, unknown>;
      if (((schema.required ?? []) as string[]).some((key) => !(key in record))) return false;
      if (schema.additionalProperties === false && Object.keys(record).some((key) => !(key in props))) return false;
      return Object.entries(record).every(([key, v]) => !props[key] || conforms(props[key], v));
    }
    default: throw new Error(`conforms: unsupported schema type ${String(schema.type)}`);
  }
}

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  const { currentRequestWorkspaceId } = await vi.importActual<typeof import('../workspace-als')>('../workspace-als');
  return { ...actual, activeWorkspaceId: () => currentRequestWorkspaceId() ?? 'default' };
});
vi.mock('../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../harness-core')>('../harness-core');
  return { ...actual, resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }) };
});
vi.mock('../sync/hyperbee/fanout-projection', async () => {
  const actual = await vi.importActual<typeof import('../sync/hyperbee/fanout-projection')>('../sync/hyperbee/fanout-projection');
  return { ...actual, fanoutForObject: async () => 0 };
});

await import('../agent-tools/blueprint/submit-operation');
await import('../agent-tools/blueprint/status-operation');
await import('../agent-tools/blueprint/result-operation');
await import('../agent-tools/blueprint/events-operation');
await import('../agent-tools/blueprint/cancel-operation');
await import('../agent-tools/blueprint/signal-operation');
await import('../agent-tools/blueprint/resume-operation');

const FIXTURE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    surface text NOT NULL, writer_key text, msg_id text NOT NULL,
    body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now());
  CREATE TABLE harness_shared.harness_plans (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, goal_id text,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug));
  CREATE TABLE harness_shared.plan_runs (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    instance_plan_slug text, status text, outcome text, outputs jsonb);
  CREATE TABLE harness_shared.blueprints (
    workspace_id text NOT NULL, harness_slug text NOT NULL, blueprint_id text NOT NULL,
    version text NOT NULL, resolved jsonb NOT NULL, content_hash text NOT NULL,
    source_path text, source_commit text, projected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug));
  CREATE TABLE harness_shared.blueprint_specifications (
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    specification_revision text NOT NULL, artifact jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, specification_revision),
    CHECK (artifact->>'specificationRevision' = specification_revision));
  CREATE TABLE harness_shared.adv_sessions (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, feature text,
    agent text, session_id text, launch_spec jsonb, coord_owner_id text,
    role text, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, ended_by text);
  CREATE TABLE harness_shared.session_briefs (
    workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
    PRIMARY KEY (workspace_id, owner_id));
  CREATE TABLE harness_shared.agent_usage_samples (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, session_id text,
    source text NOT NULL, provider text NOT NULL, model text,
    input_tokens bigint, output_tokens bigint,
    cache_read_tokens bigint, cache_creation_tokens bigint, usage_provenance jsonb);
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL, expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

const WORKSPACE = 'default';
const CALLER = { slug: 'pi:docs-reader', workspaceId: WORKSPACE, capabilities: ['work_items:read', 'work_items:write'] };
type Transport = 'http' | 'mcp';

const HTTP_EXTRAS: HttpToolHostExtras = {
  validateSuperuser: () => false,
  resolvePrincipalAndTx: async (bearer) => bearer === 'token-docs'
    ? { principal: { slug: CALLER.slug, workspaceId: WORKSPACE, capabilities: new Set(CALLER.capabilities) }, tx: h.sql }
    : null,
  deps: {},
};

/** Invoke one projected tool; returns the decoded structured result, throws on refusal. */
async function invoke(transport: Transport, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (transport === 'http') {
    const res = await handleHttpToolRequest({
      method: 'POST', pathname: lookupByMcpName(name)!.expose.http!.path, searchParams: new URLSearchParams(),
      headers: { authorization: 'Bearer token-docs' }, body: args,
    }, HTTP_EXTRAS);
    const body = res.body as { error?: { code: string; message: string } } & ToolResult;
    if (res.status !== 200) throw new Error(`${body.error!.code}: ${body.error!.message}`);
    return unwrapToolResult(body);
  }
  const ctx = {
    workspaceId: WORKSPACE, harnessSlug: '*', role: 'papercup', featureId: null, chunkId: null,
    runId: globalThis.crypto.randomUUID(), spawnId: CALLER.slug, parentSpawnId: null, uiClientId: null,
    principal: { kind: 'pi', slug: CALLER.slug, workspaceId: WORKSPACE, capabilities: new Set(CALLER.capabilities) },
    tx: h.sql, isSuperuser: false, transport: 'mcp',
    log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
  } as unknown as UnifiedToolContext;
  const out = await dispatchProjectedToolToMcp(lookupByMcpName(name)!, name, args, ctx, {});
  if (out.isError) throw new Error((out.content?.[0] as { text?: string } | undefined)?.text ?? 'mcp refusal');
  return unwrapToolResult(out as ToolResult);
}

type Declaration = { id: string; operations: Array<{ id: string; acceptance: { resultSchema: Record<string, unknown> } }> };
const DECLARATION = json<Declaration>('declaration');
const HARNESS = json<{ harness: string }>('submit').harness;
const T = BLUEPRINT_OPERATION_TOOLS;

async function settle(handle: BlueprintOperationHandle, output: Record<string, unknown>): Promise<void> {
  if (handle.target.kind !== 'work-item') throw new Error('documented direct operations must target a work item');
  await h.sql`
    UPDATE harness_shared.work_items
       SET status = 'passed', authority = 'committed',
           payload = payload || ${JSON.stringify({ blueprintResult: {
             operationId: handle.operationId, specificationRevision: handle.specificationRevision,
             output, evidenceRef: 'verification:docs-examples',
           } })}::text::jsonb
     WHERE feature_id = ${handle.target.id} AND workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}`;
}
/** WI-10004002: the output the REAL program runner produces for the documented
 * declaration, never a hand-written literal (a literal `{ answer }` once hid a
 * documented resultSchema no program root could satisfy). Step ops are stubbed —
 * their results do not reach a gateless outcome — while the gate/no-gate outcome
 * mapping is runProgramCore's own and the settled shape is the writer's. */
async function documentedProgramOutput(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await runProgramCore({
    blueprint: BlueprintSchema.parse(DECLARATION), payload,
    ctx: { identity: { ownerId: CALLER.slug }, callerId: CALLER.slug, workItemId: null, depth: 0, log: () => {} } as never,
    runOp: async () => ({}),
  });
  return programOperationOutput(outcome);
}
const resultSchemaOf = (operationId: string) =>
  DECLARATION.operations.find((op) => op.id === operationId)!.acceptance.resultSchema;
async function countPlansAndItems() {
  const [row] = await h.sql<Array<{ items: number; plans: number; runs: number }>>`
    SELECT (SELECT count(*)::int FROM harness_shared.work_items) AS items,
           (SELECT count(*)::int FROM harness_shared.harness_plans) AS plans,
           (SELECT count(*)::int FROM harness_shared.plan_runs) AS runs`;
  return row;
}

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('blueprint-operation-docs');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(FIXTURE_DDL).simple();
  // Shared, audited event-substrate list (WI-10004700); it includes 1216.
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'blueprint/operation-docs-examples.integration.test.ts',
  });
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('1219-blueprint-operation-invocations.sql')).simple();
  await db.sql.unsafe(readMigration('1223-blueprint-operation-event-replay.sql')).simple();
  await db.sql.unsafe(readMigration('698-work-items-closed-ts.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(WATCHDOG_TICKS_DDL).simple();
  await db.sql.unsafe(readMigration('1214-work-item-completion-event-intent.sql')).simple();
  await db.sql.unsafe(readMigration('1215-event-await-delivery-intent-recovery-index.sql')).simple();
  // WI-10004562 / D-045: receipts record the work item's storage slug.
  await db.sql.unsafe(readMigration('1282-blueprint-receipt-target-harness-slug.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 120_000);
afterAll(async () => { await db?.cleanup(); }, 30_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.coord_event_log,
                        harness_shared.blueprints, harness_shared.blueprint_specifications,
                        harness_shared.blueprint_operation_invocations, harness_shared.plan_runs RESTART IDENTITY`;
  // The documented declaration, compiled and projected exactly as written.
  await projectBlueprintToPg(db.sql, {
    workspaceId: WORKSPACE, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(DECLARATION), specification: compileAgentSpecification({ source: DECLARATION }),
  });
});

describe('P-014 published blueprint-operation page', () => {
  it('marks exactly the runnable fences this suite executes; every other fence is labeled conceptual or illustrative', () => {
    expect([...RUNNABLE.keys()].sort()).toEqual([...EXPECTED_RUNNABLE].sort());
    for (const fence of ALL_FENCES) {
      if (/runnable=/.test(fence.meta)) continue;
      expect(fence.meta, `unlabeled fence: ${fence.body.slice(0, 80)}`).toMatch(/\bconceptual\b/);
    }
    // The page must not imply a plan is required.
    expect(PAGE).toMatch(/do \*\*not\*\* need a\s+Papercusp plan/);
  });

  it('claims only measured P-013 numbers: each workload section names its evidence file, and every FAIL is disclosed', () => {
    const perf = PAGE.slice(PAGE.indexOf('## Performance'));
    expect(perf.startsWith('## Performance')).toBe(true);
    expect(perf).not.toMatch(/Placeholder|none are claimed until then/);
    const sections = perf.split(/^### /m).slice(1).filter((s) => /^[A-D]\. /.test(s));
    expect(sections.map((s) => s[0])).toEqual(['A', 'B', 'C', 'D']);
    for (const section of sections) {
      const heading = /^([A-D])\. .* — (PASS|FAIL) (\d+)\/(\d+)$/m.exec(section);
      expect(heading, section.slice(0, 80)).not.toBeNull();
      const [, key, verdict, passed, total] = heading!;
      const evidence = /^Evidence: `(docs\/evidence\/p013-workload-[a-d][\w.-]*\.json)`\.$/m.exec(section)?.[1];
      expect(evidence, `workload ${key} names no evidence file`).toBeTruthy();
      const artifact = JSON.parse(readFileSync(resolve(REPO_ROOT, evidence!), 'utf8'));
      const rows = section.split('\n').filter((line) => /^\| (warm|cold|throughput)/.test(line));
      expect(rows.length, `workload ${key} table rows`).toBe(Number(total));
      expect(rows.filter((line) => line.endsWith('| pass |')).length, `workload ${key} passing rows`).toBe(Number(passed));
      expect(verdict === 'PASS', `workload ${key} verdict`).toBe(passed === total);
      if (artifact.grade?.checks) {
        expect(artifact.grade.checks.length, `workload ${key} graded checks`).toBe(Number(total));
        expect(artifact.grade.checks.filter((c: { passed: boolean }) => c.passed).length).toBe(Number(passed));
        expect(artifact.grade.verdict).toBe(verdict.toLowerCase());
      }
      // A failing workload stays on the page with its governing decision and tracked residual.
      if (verdict === 'FAIL') expect(section).toMatch(/does not meet its budget[\s\S]*plan decision D-\d{3}[\s\S]*tracked as (WI|EI)-\d+/);
    }
  });

  it('documents the live tool names and HTTP routes', () => {
    const routes = json<Record<string, string>>('tool-routes');
    expect(Object.keys(routes).sort()).toEqual(Object.values(T).sort());
    for (const [name, path] of Object.entries(routes)) {
      expect(lookupByMcpName(name)?.expose.http?.path, name).toBe(path);
    }
  });

  it('pins the documented plan target to the template the P-013 fork/join suite runs, and compiles the added operations', () => {
    const planTarget = json<{ id: string; target: { template: Record<string, unknown> } }>('plan-target');
    expect(planTarget.id).toBe(P013B_OPERATION);
    expect(planTarget.target.template).toEqual({
      kind: 'plan-template', ref: P013B_TEMPLATE, revision: '0', contentHash: hashPlanContent(P013B_TEMPLATE_CONTENT),
    });
    // The page tells readers to add these operations to the documented declaration.
    const source = {
      ...DECLARATION,
      operations: [...DECLARATION.operations, json('trigger-operation'), planTarget],
    } as unknown as typeof DECLARATION;
    expect(() => BlueprintSchema.parse(source)).not.toThrow();
    const compiled = JSON.stringify(compileAgentSpecification({ source }));
    expect(compiled).toContain('"triage"');
    expect(compiled).toContain(P013B_TEMPLATE);
  });

  it('documents trigger and schedule arguments the live tools accept, with inputs their target operations admit', async () => {
    const { default: bindTool } = await import('../agent-tools/triggers/bind');
    const { default: setScheduleTool } = await import('../agent-tools/plans/set-schedule');
    const inputSchema = (op: unknown) => (op as { inputSchema: Record<string, unknown> }).inputSchema;
    const triggerOperation = json<{ id: string }>('trigger-operation');

    const bind = json<{ sourceId: string; eventPattern: string; operationId: string; input: Record<string, unknown> }>('trigger-bind');
    expect(bindTool.args.safeParse(bind).success).toBe(true);
    expect(bind.operationId).toBe(triggerOperation.id);
    // Exactly what the binding engine submits: the redacted routing envelope plus the literal input.
    const routing = redactTriggerArgsForPlanInputs({
      trigger: {
        key: bind.eventPattern, source: 'github', event: 'issues.opened', sourceId: bind.sourceId,
        externalId: '42', occurredAt: null, datatypeId: 'github.issue', dedupeKey: 'github:42',
        payload: { title: 'private provider payload' },
      },
    });
    expect(JSON.stringify(routing)).not.toContain('private provider payload');
    expect(conforms(inputSchema(triggerOperation), { ...routing, ...bind.input })).toBe(true);
    expect(conforms(inputSchema(triggerOperation), bind.input)).toBe(false);

    const migrate = json<Record<string, unknown>>('trigger-migrate');
    expect(bindTool.args.safeParse(migrate).success).toBe(true);
    // Source, pattern, filter and storm policy are copied from the legacy binding, never re-supplied.
    expect(bindTool.args.safeParse({ ...migrate, eventPattern: bind.eventPattern }).success).toBe(false);

    const schedule = json<{ schedule: { operation: { operationId: string; input: Record<string, unknown> } } }>('schedule-operation');
    expect(setScheduleTool.args.safeParse(schedule).success).toBe(true);
    const scheduled = DECLARATION.operations.find((op) => op.id === schedule.schedule.operation.operationId);
    expect(scheduled).toBeDefined();
    expect(conforms(inputSchema(scheduled), schedule.schedule.operation.input)).toBe(true);
  });
});

describe.each<Transport>(['http', 'mcp'])('P-014 documented direct operations over %s', (transport) => {
  const call = (name: string, args: Record<string, unknown>) => invoke(transport, name, args);

  it('runs the documented agent-operation lifecycle and returns a result valid under the declared schema', async () => {
    const submitArgs = json('submit');
    const { handle } = SubmitResultSchema.parse(await call(T.submit, submitArgs));
    expect(handle).toMatchObject({ workspaceId: WORKSPACE, harnessSlug: HARNESS, operationId: submitArgs.operationId,
      target: { kind: 'work-item' } });
    // Documented replay + conflict semantics.
    expect(SubmitResultSchema.parse(await call(T.submit, submitArgs)).handle).toEqual(handle);
    await expect(call(T.submit, { ...submitArgs, input: { value: 'changed' } })).rejects.toThrow(
      'input_conflict: blueprint operation request key was reused with different input or target');

    expect(BlueprintOperationStatusSchema.parse(await call(T.status, { handle })))
      .toMatchObject({ phase: 'accepted', outcome: null, wait: null, cancellationRequested: false });
    expect(BlueprintOperationResultSchema.parse(await call(T.result, { handle }))).toMatchObject({ state: 'pending' });
    const first = BlueprintOperationEventsPageSchema.parse(await call(T.events, { handle }));

    const signal = BlueprintOperationInputReceiptSchema.parse(await call(T.signal, { handle, ...json('signal') }));
    expect(signal).toMatchObject({ accepted: true, replayed: false });
    expect(BlueprintOperationInputReceiptSchema.parse(await call(T.signal, { handle, ...json('signal') })))
      .toMatchObject({ eventId: signal.eventId, replayed: true });

    // The documented resume token is the one status.wait carries.
    const resumeArgs = json<{ token: string }>('resume');
    await openBlueprintOperationWait(db.sql, handle, CALLER.slug, { waitName: 'approve', token: resumeArgs.token });
    expect(BlueprintOperationStatusSchema.parse(await call(T.status, { handle })))
      .toMatchObject({ phase: 'waiting', wait: { name: 'approve', token: resumeArgs.token } });
    expect(BlueprintOperationInputReceiptSchema.parse(await call(T.resume, { handle, ...resumeArgs })))
      .toMatchObject({ accepted: true });

    expect(BlueprintOperationCancelReceiptSchema.parse(await call(T.cancel, { handle, ...json('cancel') })))
      .toMatchObject({ accepted: true });
    expect(await call(T.status, { handle })).toMatchObject({ cancellationRequested: true });

    await settle(handle, { answer: 'hello back' });
    const result = BlueprintOperationResultSchema.parse(await call(T.result, { handle }));
    expect(result).toMatchObject({ state: 'ready', evidenceRef: 'verification:docs-examples' });
    if (result.state !== 'ready') throw new Error('expected ready');
    expect(conforms(resultSchemaOf(handle.operationId), result.output)).toBe(true);
    // Instrument check: the validator rejects what the declared schema rejects.
    expect(conforms(resultSchemaOf(handle.operationId), { answer: 3 })).toBe(false);
    expect(conforms(resultSchemaOf(handle.operationId), { answer: 'x', extra: 1 })).toBe(false);

    const later = BlueprintOperationEventsPageSchema.parse(await call(T.events, { handle, cursor: first.cursor }));
    expect(later.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'signal', channel: 'note' }),
      expect.objectContaining({ kind: 'resume', token: resumeArgs.token }),
      expect.objectContaining({ kind: 'cancel' }),
    ]));
    expect(await countPlansAndItems()).toEqual({ items: 1, plans: 0, runs: 0 });
  });

  it('runs the documented program operation with the same verbs and no plan', async () => {
    const args = json('submit-program');
    const { handle } = SubmitResultSchema.parse(await call(T.submit, args));
    expect(handle).toMatchObject({ operationId: 'extract-program', target: { kind: 'work-item' } });
    expect(SubmitResultSchema.parse(await call(T.submit, args)).handle).toEqual(handle);
    expect(BlueprintOperationStatusSchema.parse(await call(T.status, { handle }))).toMatchObject({ phase: 'accepted' });
    const programOutput = await documentedProgramOutput(args.input as Record<string, unknown>);
    // The documented resultSchema must admit what a program root really settles with.
    expect(conforms(resultSchemaOf('extract-program'), programOutput)).toBe(true);
    await settle(handle, programOutput);
    const result = BlueprintOperationResultSchema.parse(await call(T.result, { handle }));
    if (result.state !== 'ready') throw new Error(`expected ready, got ${result.state}`);
    expect(result.output).toEqual(programOutput);
    expect(conforms(resultSchemaOf('extract-program'), result.output)).toBe(true);
    // Documented refusal: cancelling a terminal operation.
    await expect(call(T.cancel, { handle, ...json('cancel') }))
      .rejects.toThrow('terminal: cannot cancel a terminal blueprint operation');
    expect(await countPlansAndItems()).toEqual({ items: 1, plans: 0, runs: 0 });
  });

  it('runs the documented typed-client TypeScript verbatim', async () => {
    const snippet = RUNNABLE.get('typed-client')!;
    expect(snippet.lang).toBe('ts');
    const wrapped = `(async (BlueprintOperationClient, createProjectedBlueprintOperationPort, invoke, workspaceId, callerId) => {
${snippet.body}
return { handle, status };
})`;
    const { code } = await transform(wrapped, { loader: 'ts' });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(`return ${code.trim().replace(/;$/, '')}`)() as (...args: unknown[]) =>
      Promise<{ handle: BlueprintOperationHandle; status: unknown }>;
    const { handle, status } = await run(BlueprintOperationClient, createProjectedBlueprintOperationPort,
      (name: string, args: Record<string, unknown>) => call(name, args), WORKSPACE, CALLER.slug);
    expect(handle).toMatchObject({ workspaceId: WORKSPACE, harnessSlug: HARNESS, operationId: 'extract' });
    expect(BlueprintOperationStatusSchema.parse(status)).toMatchObject({ phase: 'accepted' });
    const events = BlueprintOperationEventsPageSchema.parse(await call(T.events, { handle }));
    expect(events.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'signal', channel: 'note' })]));
  });
});
