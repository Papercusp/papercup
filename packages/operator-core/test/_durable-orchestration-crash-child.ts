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
import postgres from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ProjectedTool, ToolResult, UnifiedToolContext } from '@papercusp/tooldef';

const dsn = process.env.DURABLE_CRASH_DSN;
const runKey = process.env.DURABLE_CRASH_RUN_KEY;
const mode = process.env.DURABLE_CRASH_MODE;
const script = process.env.DURABLE_CRASH_SCRIPT;
const crashTarget = process.env.DURABLE_CRASH_TARGET ?? '';
const recipeInputs = JSON.parse(process.env.DURABLE_CRASH_INPUTS ?? '{}');
const revoked = new Set((process.env.DURABLE_CRASH_REVOKE ?? '').split(',').filter(Boolean));
if (!dsn || !runKey || !script || !['crash', 'recover', 'code'].includes(mode ?? '')) {
  throw new Error('durable orchestration crash fixture configuration is incomplete: ' + JSON.stringify({
    dsnPresent: Boolean(dsn), runKeyPresent: Boolean(runKey), mode: mode ?? null, scriptChars: script?.length ?? 0,
  }));
}

const sql = postgres(dsn, { max: 2, onnotice: () => {} });

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
        process.kill(process.pid, 'SIGKILL');
        await new Promise<never>(() => {});
      }
      await sql.unsafe(
        'INSERT INTO test_durable.calls (run_key, tool, mode, args, idempotency_key) VALUES ($1, $2, $3, $4, $5)',
        [runKey, name, mode, JSON.stringify(args ?? null), ctx.idempotencyKey ?? null],
      );
      if (mode === 'crash' && name === crashTarget) {
        // The side effect is committed; the process dies before DBOS records the step outcome.
        process.kill(process.pid, 'SIGKILL');
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
];

DBOS.setConfig({
  name: 'durable-orchestration-crash-p019',
  systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos',
  applicationVersion: 'durable-orchestration-crash-p019-v1',
  runAdminServer: false,
});

const workflow = await import('../lib/dbos/durable-orchestration-workflow');
// The seam MUST be configured before DBOS.launch: recovery starts at launch and would otherwise
// resolve the real operator registry.
workflow.configureDurableOrchestrationRuntime({
  tools: () => TOOLS,
  allowedFor: (_role, tools) => new Set(
    tools.map((tool) => tool.expose?.mcp?.name ?? '').filter((name) => name && !revoked.has(name)),
  ),
  excluded: new Set<string>(),
  deps: () => ({}),
  inner: (_tool, _name, _args, ctx, next) => next(ctx),
});

const launchStartedAt = performance.now();
try {
  await DBOS.launch();
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
  caller: { ownerId: 'durable-crash-caller', workspaceId: 'ws-p019-crash', role: 'worker' },
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
  await workflow.startDurableOrchestration(input);
  const settled = await DBOS.getResult(workflowId, 60);
  throw new Error('crash point was not reached; workflow settled with ' + JSON.stringify(settled));
}

const outcome = await DBOS.getResult(workflowId, 90);
const status = await workflow.getDurableOrchestrationStatus(workflowId);
process.stdout.write('DURABLE_OUTCOME ' + JSON.stringify({ outcome, status }) + '\n');
await DBOS.shutdown();
await sql.end({ timeout: 5 });
