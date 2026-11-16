/**
 * Isolated DBOS worker for durable-orchestration-workflow.crash.integration.test.ts
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, D-019).
 *
 * The child runs the REAL `durableOrchestration` workflow against a throwaway database with a
 * synthetic tool registry whose tools log every live dispatch to `test_durable.calls`. In `crash`
 * mode the tool named by DURABLE_CRASH_TARGET is SIGKILLed right after its side effect — the exact
 * window where the effect happened but the step outcome was never recorded. In `recover` mode the
 * child relaunches DBOS on a fresh executor, lets recovery resume the same workflow ID, and prints
 * the settled outcome. DURABLE_CRASH_REVOKE removes one tool from the caller's CURRENT role
 * allowlist at recovery time.
 */
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createDurableCaptureRecorder } from './_durable-orchestration-capture';
import postgres from 'postgres';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { DispatchNext, ProjectedTool, ToolResult, UnifiedToolContext, WrapDispatch } from '@papercusp/tooldef';

const dsn = process.env.DURABLE_CRASH_DSN;
const configuredRunKey = process.env.DURABLE_CRASH_RUN_KEY;
const configuredMode = process.env.DURABLE_CRASH_MODE;
const script = process.env.DURABLE_CRASH_SCRIPT;
const crashTarget = process.env.DURABLE_CRASH_TARGET ?? '';
const recipeInputs = JSON.parse(process.env.DURABLE_CRASH_INPUTS ?? '{}');
const gecScope = process.env.DURABLE_CRASH_GEC_SCOPE ? JSON.parse(process.env.DURABLE_CRASH_GEC_SCOPE) : undefined;
const revoked = new Set((process.env.DURABLE_CRASH_REVOKE ?? '').split(',').filter(Boolean));
if (!dsn || !configuredRunKey || !script || !configuredMode || !['crash', 'recover', 'code'].includes(configuredMode)) {
  throw new Error('durable orchestration crash fixture configuration is incomplete: ' + JSON.stringify({
    dsnPresent: Boolean(dsn), runKeyPresent: Boolean(configuredRunKey), mode: configuredMode ?? null, scriptChars: script?.length ?? 0,
  }));
}
// Capture validated strings after the guard so hoisted tool callbacks retain
// their non-optional types as well as the original runtime values.
const runKey = configuredRunKey, mode = configuredMode;

const sql = postgres(dsn, { max: 2, onnotice: () => {} });
let retainGecTermination: (() => void) | undefined;
function terminateCrashFixture() {
  // Synchronous final publication followed immediately by the actual signal.
  // This records intent only; the parent must independently observe the death.
  retainGecTermination?.();
  process.kill(process.pid, 'SIGKILL');
}

// Keep startup failures separate from workflow/recovery failures. In particular,
// pg's connection deadline includes hostname lookup, before any TCP handshake.
// Report phases without emitting the private database URL or credentials.
const originalLookup = dns.lookup;
let lookupSequence = 0;
dns.lookup = ((hostname: string, ...args: unknown[]) => {
  const callback = args.pop() as (...values: unknown[]) => void;
  const sequence = ++lookupSequence;
  const startedAt = performance.now();
  const report = (phase: string, error?: unknown) => process.stderr.write('DURABLE_DBOS_STARTUP ' + JSON.stringify({
    phase, sequence, elapsedMs: Math.round(performance.now() - startedAt),
    loopback: hostname === 'localhost', error: error instanceof Error ? error.message : null,
  }) + '\n');
  report('lookup-start');
  return Reflect.apply(originalLookup, dns, [hostname, ...args, (...values: unknown[]) => {
    report('lookup-end', values[0]);
    callback(...values);
  }]);
}) as typeof dns.lookup;

function probeTool(name: string, effect: 'read' | 'write', idempotent: boolean): ProjectedTool {
  return {
    pluginName: 'durable-crash-probe',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    idempotent,
    expose: { mcp: { name } },
    fn: async (args: unknown, ctx: UnifiedToolContext): Promise<ToolResult> => {
      if (mode === 'crash' && crashTarget === 'before:' + name) {
        // The invocation intent exists, but the independent effect oracle has
        // no effect. Recovery must still reconcile rather than assume absence.
        terminateCrashFixture();
        await new Promise<never>(() => {});
      }
      await sql.unsafe(
        'INSERT INTO test_durable.calls (run_key, tool, mode, args, idempotency_key) VALUES ($1, $2, $3, $4, $5)',
        [runKey, name, mode, JSON.stringify(args ?? null), ctx.idempotencyKey ?? null],
      );
      if (mode === 'crash' && name === crashTarget) {
        // The side effect is committed; the process dies before DBOS records the step outcome.
        terminateCrashFixture();
        await new Promise<never>(() => {});
      }
      const count = await sql.unsafe('SELECT count(*)::int AS n FROM test_durable.calls WHERE run_key = $1', [runKey]);
      // Publication fixtures use the actual maintained recipe and DBOS runner.
      // These synthetic tool contracts make the effect ledger an independent
      // crash oracle; they do not stand in for the canonical emitter's tests.
      let publication: unknown;
      if (name === 'plans:evaluate-spec-quality') publication = { ok: true, verdict: 'pass', specSetHash: 'a'.repeat(64),
        scorecardDraft: { rubricRef: 'plan-specification-quality', terminal: true,
          subject: { kind: 'plan', ref: 'fixture-spec:' + (args as { slug: string }).slug },
          ratings: { exact: { rating: 'healthy', evidence: 'original evaluator evidence' } } } };
      if (name === 'scorecards:emit') publication = { ok: true, issueId: 'EI-quality-' + runKey,
        completionReceipt: { status: 'recorded', effectRef: 'EI-quality-' + runKey }, gradingAuditPending: true };
      if (name === 'scorecards:get') {
        const [row] = await sql.unsafe('SELECT args FROM test_durable.calls WHERE run_key=$1 AND tool=$2 ORDER BY seq LIMIT 1',
          [runKey, 'scorecards:emit']);
        const emitted = row ? JSON.parse(String(row.args)) : null;
        publication = emitted ? { ok: true, scorecard: { issueId: 'EI-quality-' + runKey,
          rubricRef: emitted.rubricRef, subject: emitted.subject, gradingAudit: { state: 'pending' },
          evidenceFingerprint: 'fixture-exact-evidence' } } : { ok: false, error: 'card_not_recorded' };
      }
      if (publication) return { content: [{ type: 'text', text: JSON.stringify(publication) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ tool: name, seen: count[0]?.n ?? 0 }) }] };
    },
  } as ProjectedTool;
}

const TOOLS: ProjectedTool[] = [
  probeTool('probe:read', 'read', false),
  probeTool('probe:put', 'write', true),
  probeTool('probe:send', 'write', false),
  probeTool('probe:after', 'read', false),
  probeTool('plans:evaluate-spec-quality', 'read', false),
  probeTool('scorecards:emit', 'write', false),
  probeTool('scorecards:get', 'read', false),
  // Frozen GEC C5/C6 use these in-process doubles only. No provider or mail
  // transport is installed: their sole effect is the independent private SQL log.
  ...(process.env.DURABLE_CRASH_GEC_SCOPE ? [
    probeTool('items:get', 'read', false), probeTool('items:put', 'write', true),
    probeTool('mail:send', 'write', false),
  ] : []),
];

let sealGecCapture: (() => void) | undefined;
const gecPhases: Array<{ phase: string; monotonicMs: number }> = [];
let retainGecPhase: (() => void) | undefined;
const markGecPhase = (phase: string) => {
  if (!gecScope) return;
  gecPhases.push({ phase, monotonicMs: performance.now() });
  retainGecPhase?.();
};
let runGecStoreWindow = <R>(fn: () => R): R => fn();
let restoreGecStore: (() => void) | undefined;
let dispatchGec: WrapDispatch = (_tool, _name, _args, ctx, next) => next(ctx);
if (process.env.DURABLE_CRASH_GEC_SCOPE) {
  const { observeGroundedDurableHost, observeGroundedStoreOperations, observeGroundedToolDispatch } = await import('../lib/grounded-evidence-measurement');
  const scope = gecScope;
  const path = process.env.DURABLE_CRASH_GEC_TAPE;
  if (!path) throw new Error('GEC durable capture requires an original tape path before launch');
  const recorder = createDurableCaptureRecorder(path);
  const original = DBOS.runStep.bind(DBOS);
  const optionsByName = new Map<string, Parameters<typeof DBOS.runStep>[1]>();
  const tap = observeGroundedDurableHost({ scope, sourceRef: path, attemptId: `${runKey}:${mode}`,
    host: { runStep<R>(name: string, fn: () => Promise<R>) { return original(fn, optionsByName.get(name)); } } });
  const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
  const sqlObservations: import('../lib/grounded-evidence-measurement').GroundedSqlObservation[] = [];
  const digest = (source: Buffer) => createHash('sha256').update(source).digest('hex');
  const initialKeysPath = process.env.DURABLE_CRASH_GEC_INITIAL_KEYS;
  if (!initialKeysPath) throw new Error('GEC durable capture requires a pre-child operation-output key census');
  const initialKeysBytes = readFileSync(initialKeysPath);
  const initialKeys = JSON.parse(initialKeysBytes.toString('utf8'));
  if (initialKeys.kind !== 'operation-output-initial-census' || !isDeepStrictEqual(initialKeys.scope, scope)
    || initialKeys.mode !== mode || initialKeys.runKey !== runKey
    || !Number.isSafeInteger(initialKeys.producerPid) || initialKeys.producerPid <= 0 || initialKeys.producerPid === process.pid
    || initialKeys.complete !== true || initialKeys.exclusive !== true
    || !isDeepStrictEqual(initialKeys.keyParameters, [0, 1]))
    throw new Error('GEC foreign or incomplete pre-child operation-output key census');
  const initialKeyCensus = { scope, sourceRef: initialKeysPath + '@sha256:' + digest(initialKeysBytes),
    complete: initialKeys.complete, exclusive: initialKeys.exclusive,
    keyParameters: initialKeys.keyParameters, initialKeys: initialKeys.initialKeys };
  const serializerSourceRef = 'source:pg/lib/query.js@'
    + digest(readFileSync(new URL('../../../node_modules/pg/lib/query.js', import.meta.url)))
    + '+utils.js@' + digest(readFileSync(new URL('../../../node_modules/pg/lib/utils.js', import.meta.url))) + '#Bind.prepareValue';
  // Reviewed SDK setup subscribes three channels and sends one fixed self-test;
  // it does not persist application values. Pin the writer as well as every SQL
  // byte/command/status. A changed SDK must be reviewed before qualifying it.
  const notificationSourceHash = 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b';
  const notificationSourceMatches = digest(readFileSync(new URL(
    '../../../node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js', import.meta.url))) === notificationSourceHash;
  const notificationControls = notificationSourceMatches ? [
    { queryHash: '2dfb06715dd1ca9db551ee03eed8cf4d1560b086c0adf99d3b543437df32f7d7', command: 'LISTEN' as const },
    { queryHash: '832fb87fb98cee7914c921ec44ede3fb437008fd3e8bf4985f5af80e2dfcf6ab', command: 'LISTEN' as const },
    { queryHash: '6cb0b99e8615da9b0be254f3b925ad08d748b0dd54ce15532ecc16262111a272', command: 'LISTEN' as const },
    { queryHash: '51d3f928cd16813b7a8f257cd05b53f2fe093baa8066900c62203e876c24e538', command: 'NOTIFY' as const },
  ].map(row => ({ ...row, kind: 'control' as const, status: 'ok' as const,
    sourceRef: `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${notificationSourceHash}#notification-setup` })) : [];
  // This exact installed writer can report INSERT 1 for an invocation-owned
  // unchanged upsert (checkpoint_invocation_id is the eleventh Bind input).
  // The parent retains all keys before this exclusive child starts, so the
  // recorder can distinguish a new output from an unchanged conflict. Lost or
  // overlapping outcomes remain unknown. The executor marker UPDATE has its
  // separate zero/all contract. Changed SDK/SQL bytes leave writes unregistered.
  const operationOutputStatement = `INSERT INTO dbos.operation_outputs
         (workflow_uuid, function_id, output, error, function_name, child_workflow_id, started_at_epoch_ms, completed_at_epoch_ms, serialization, application_name, checkpoint_invocation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workflow_uuid, function_id) DO UPDATE
         SET checkpoint_invocation_id = operation_outputs.checkpoint_invocation_id
         WHERE EXCLUDED.checkpoint_invocation_id IS NOT NULL
           AND operation_outputs.checkpoint_invocation_id = EXCLUDED.checkpoint_invocation_id
         RETURNING completed_at_epoch_ms;`;
  const executorStatement = `UPDATE "dbos".workflow_status
             SET executor_id = $1
           WHERE workflow_uuid = $2 AND executor_id IS DISTINCT FROM $1`;
  const operationOutputSourceRef = `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${notificationSourceHash}#recordOperationResultInternal`;
  let storeTap: ReturnType<typeof observeGroundedStoreOperations>;
  const invocationTap = observeGroundedToolDispatch({ scope, sourceRef: path, attemptId: `${runKey}:${mode}`,
    boundary: 'internal', originRef: 'current-source:DurableOrchestrationRuntime.inner',
    registrations: Object.fromEntries(TOOLS.map(tool => [tool.expose!.mcp!.name,
      { purpose: tool.effect === 'read' ? 'retrieval' as const : 'other' as const,
        purposeRef: `registered-fixture-contract:${tool.expose!.mcp!.name}` }])),
    onObservation: () => retain(false),
    dispatch: async (_name, _args, ctx: UnifiedToolContext, next: DispatchNext) => next(ctx),
  });
  const retention = { scope: 'completed-prior-publications', completed: 0, failed: 0,
    snapshotMs: 0, serializationMs: 0, publicationMs: 0, publishedBytes: 0, maxTotalMs: 0 };
  let processTermination: { pid: number; signal: 'SIGKILL' } | null = null;
  const retain = (settled: boolean) => {
    const started = performance.now();
    try {
      const capture = {
        kind: 'current-source-durable-capture', acceptance: 'unmeasured', mode, workflowRunKey: runKey,
        processId: process.pid,
        initialKeyCensus,
        phases: gecPhases,
        processTermination,
        sqlObservations,
        // This publication cannot include its own final write duration. Keep the
        // accounting scope explicit; the next snapshot retains this one's cost.
        retention: { ...retention },
        // Preserve the actual in-process double contracts for the resumed consumer;
        // the parent must not reconstruct them from an expected next action.
        catalog: TOOLS.filter(tool => ['items:get', 'items:put'].includes(tool.expose?.mcp?.name ?? ''))
          .map(tool => ({ name: tool.expose!.mcp!.name, description: tool.description, input: tool.inputSchema })),
        census: settled ? tap.seal() : tap.snapshot(),
        // The live dispatcher excludes recorded DBOS replay and pre-dispatch
        // authorization/reconciliation halts. Pending admissions survive SIGKILL.
        invocations: settled ? invocationTap.seal() : invocationTap.snapshot(),
        // Both physical drivers live in THIS process. The source-pinned SQL tape
        // includes DBOS bootstrap Clients, its own Pool, and the effect-log client.
        // No unreviewed SQL is inferred nonpersisting or assigned byte totals.
        storage: settled ? storeTap.seal() : storeTap.snapshot(),
        boundary: settled ? { scope, sourceRef: path, admittedAt, settledAt: new Date().toISOString(),
          monotonicStartMs, monotonicEndMs: performance.now(), drained: true } : null,
      };
      const snapshotMs = performance.now() - started;
      const timing = recorder.retain(capture);
      retention.completed++;
      retention.snapshotMs += snapshotMs;
      retention.serializationMs += timing.serializationMs;
      retention.publicationMs += timing.publicationMs;
      retention.publishedBytes += timing.bytes;
      retention.maxTotalMs = Math.max(retention.maxTotalMs, performance.now() - started);
    } catch (error) {
      retention.failed++;
      throw error;
    }
  };
  storeTap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: path,
    attemptId: `${runKey}:${mode}`, postgres: [{ pool: 'child-effect-log', client: sql }],
    nodePostgres: [{ pool: 'child-dbos-all-clients', clientPrototype: pg.Client.prototype,
      queryPrototype: pg.Query.prototype, serializerSourceRef }],
    nonPersistingSql: notificationControls,
    serializedSqlParameters: notificationSourceMatches ? [
      { pool: 'child-dbos-all-clients', sourceRef: operationOutputSourceRef, serializerSourceRef,
        queryHash: digest(Buffer.from(operationOutputStatement)), command: 'INSERT', parameterCount: 11,
        persistedParameters: [2, 3], allOrNoneRows: 'zero-only', insertOrNoop: initialKeyCensus },
      { pool: 'child-dbos-all-clients', sourceRef: operationOutputSourceRef, serializerSourceRef,
        queryHash: digest(Buffer.from(executorStatement)), command: 'UPDATE', parameterCount: 2,
        persistedParameters: [0], allOrNoneRows: 1 },
    ] : [],
    onSqlObservation: row => sqlObservations.push(row), onObservation: () => retain(false) });
  runGecStoreWindow = fn => storeTap.run(fn);
  restoreGecStore = () => storeTap.restore();
  dispatchGec = (_tool, name, args, ctx, next) => invocationTap.dispatch(name, args, ctx, next);
  DBOS.runStep = (async (fn, options) => {
    const name = options?.name ?? '<unnamed>';
    optionsByName.set(name, options);
    const pending = tap.host.runStep(name, fn);
    // Synchronous retention survives the intentional SIGKILL inside the callback.
    retain(false);
    try { return await pending; }
    finally { retain(false); }
  }) as typeof DBOS.runStep;
  retain(false);
  retainGecTermination = () => { processTermination = { pid: process.pid, signal: 'SIGKILL' }; retain(false); };
  retainGecPhase = () => retain(false);
  markGecPhase('capture-admitted');
  sealGecCapture = () => retain(true);
}

await runGecStoreWindow(async () => {
try {
DBOS.setConfig({
  name: 'durable-orchestration-crash-p019',
  systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos',
  applicationVersion: 'durable-orchestration-crash-p019-v1',
  runAdminServer: false,
});

markGecPhase('workflow-import-start');
const workflow = await import('../lib/dbos/durable-orchestration-workflow');
markGecPhase('workflow-import-end');
// The seam MUST be configured before DBOS.launch: recovery starts at launch and would otherwise
// resolve the real operator registry.
workflow.configureDurableOrchestrationRuntime({
  tools: () => TOOLS,
  allowedFor: (_role, tools) => new Set(
    tools.map((tool) => tool.expose?.mcp?.name ?? '').filter((name) => name && !revoked.has(name)),
  ),
  excluded: new Set<string>(),
  deps: () => ({}),
  inner: dispatchGec,
});

const launchStartedAt = performance.now();
markGecPhase('launch-start');
try {
  await DBOS.launch();
  markGecPhase('launch-end');
  process.stderr.write('DURABLE_DBOS_STARTUP ' + JSON.stringify({ phase: 'launch-complete',
    elapsedMs: Math.round(performance.now() - launchStartedAt), lookups: lookupSequence }) + '\n');
} catch (error) {
  process.stderr.write('DURABLE_DBOS_STARTUP ' + JSON.stringify({ phase: 'launch-failed',
    elapsedMs: Math.round(performance.now() - launchStartedAt), lookups: lookupSequence }) + '\n');
  throw error;
}
(globalThis as { __papercuspDbosStarted?: boolean }).__papercuspDbosStarted = true;

const input = {
  runKey,
  script,
  inputs: recipeInputs,
  pin: { sourceSha256: 'fixture', bindingsSha256: 'fixture' },
  caller: { ownerId: 'durable-crash-caller', workspaceId: process.env.DURABLE_CRASH_WORKSPACE ?? 'ws-p019-crash', role: 'worker',
    ...(gecScope ? { harnessSlug: gecScope.harness } : {}) },
  timeoutSec: 60,
};
const workflowId = workflow.durableOrchestrationWorkflowId(input.caller.workspaceId, runKey);

if (mode === 'code') {
  const { durableRuntimeTools } = await import('@papercusp/tooldef');
  const { runDurableCode } = await import('../lib/agent-tools/code/durable-run');
  const { inspectOrchestration } = await import('../lib/agent-tools/orchestration/inspect');
  const { runOrchestration } = await import('../lib/agent-tools/orchestration/run');
  const { inspectScriptContract, currentCallerRecipeCatalog } = await import('../lib/agent-tools/orchestration/contract-preflight');
  const tools = [...TOOLS, ...durableRuntimeTools()];
  const allowed = new Set(tools.map(tool => tool.expose.mcp!.name!));
  const inspectScript: typeof inspectScriptContract = args => inspectScriptContract({ ...args,
    surface: { tools, allowed, catalog: currentCallerRecipeCatalog(tools, allowed) } });
  const ctx = { workspaceId: input.caller.workspaceId, role: 'worker', uiClientId: input.caller.ownerId } as UnifiedToolContext;
  const deps = {
    inspect: (args: Parameters<typeof inspectOrchestration>[0], caller: UnifiedToolContext) =>
      inspectOrchestration(args, caller, { inspectScript, projectedTools: TOOLS }),
    run: (args: Parameters<typeof runOrchestration>[0], caller: UnifiedToolContext) => runOrchestration(args, caller, {
      server: { inspectScript, projectedTools: TOOLS, startDurable: workflow.startDurableOrchestration,
        durableRunKey: () => runKey, runCode: async () => { throw new Error('foreground replay forbidden'); } },
    }),
  };
  const startedAt = Date.now();
  const admission = await runDurableCode({ script,
    execution: { lifecycle: 'background', durability: 'durable', timeoutSec: 180 } }, ctx, deps);
  const admissionElapsedMs = Date.now() - startedAt;
  const admissionText = admission.content.find(row => row.type === 'text');
  const admitted = JSON.parse(JSON.parse((admissionText as { text: string }).text).summary);
  if (admitted.durableRun?.workflowId !== workflowId) throw new Error('original workflow not admitted: ' + JSON.stringify(admission));
  await DBOS.getResult(workflowId, 190);
  const inspected = await inspectOrchestration({ durableRun: { workflowId } }, ctx);
  const result = (inspected as ToolResult & { data?: unknown }).data;
  if (!result) throw new Error('original durable workflow inspection returned no data');
  process.stdout.write('DURABLE_CODE_OUTCOME ' + JSON.stringify({ workflowId, admissionElapsedMs,
    elapsedMs: Date.now() - startedAt, result }) + '\n');
  await DBOS.shutdown(); await sql.end({ timeout: 5 });
  process.exit(0);
}

if (mode === 'crash') {
  markGecPhase('workflow-start');
  await workflow.startDurableOrchestration(input);
  markGecPhase('workflow-admitted');
  const settled = await DBOS.getResult(workflowId, 60);
  throw new Error('crash point was not reached; workflow settled with ' + JSON.stringify(settled));
}

markGecPhase('result-start');
const outcome = await DBOS.getResult(workflowId, 90);
markGecPhase('result-end');
markGecPhase('status-start');
const status = await workflow.getDurableOrchestrationStatus(workflowId);
markGecPhase('status-end');
markGecPhase('shutdown-start');
await DBOS.shutdown();
markGecPhase('shutdown-end');
markGecPhase('effect-client-end-start');
await sql.end({ timeout: 5 });
markGecPhase('effect-client-end-end');
sealGecCapture?.();
process.stdout.write('DURABLE_OUTCOME ' + JSON.stringify({ outcome, status }) + '\n');
} finally { restoreGecStore?.(); }
});
