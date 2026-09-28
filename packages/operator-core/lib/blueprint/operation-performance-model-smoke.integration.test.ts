/**
 * P-013 bounded ACTUAL-MODEL smoke. D-016: "Keep actual-provider smoke separate from fixture
 * latency grades" — so this file is ungraded by design and never compares against a D-016
 * ceiling. The fixture matrices (operation-performance{,-b,-c,-d}.integration.test.ts) carry the
 * grades; this carries the one question they cannot answer: what share of a run that really
 * calls a model is platform overhead?
 *
 * Workload D's recipe (operation-performance-d-driver.ts, imported unchanged) gains exactly one
 * real provider call, `tools.p013d.modelCall`, inserted before the declared wait, and runs
 * through both D arms: foreground orchestrate:run (control) and durable DBOS orchestrate:run
 * (candidate). Per sample it records end-to-end latency and the model call's own duration.
 *
 * Opt-in only, because real calls cost money and need network plus a credential:
 *   P013_ACTUAL_MODEL=1          enable (otherwise the case is skipped and nothing boots)
 *   P013_ACTUAL_MODEL_SAMPLES    measured samples per arm after one warmup each (default 5, max 20)
 *   P013_ACTUAL_MODEL_ID         model id (default claude-haiku-4-5)
 * The `P-013 actual-model smoke {json}` stdout line is the evidence payload.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import type { ProjectedTool, ToolResult, UnifiedToolContext } from '@papercusp/tooldef';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  P013D_ROLE, P013D_SCRIPTS, P013D_WORKSPACE, assertWriteExactlyOnce, epochNow, findInspectionPin,
  p013DCaller, parseToolJson, type P013DArm,
} from './operation-performance-d-driver';
import { bootP013DRuntime, type BootedP013DRuntime } from './operation-performance-d-runtime';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => P013D_WORKSPACE,
}));

const ENABLED = process.env.P013_ACTUAL_MODEL === '1';
const MODEL = process.env.P013_ACTUAL_MODEL_ID?.trim() || 'claude-haiku-4-5';
const SAMPLES = Math.min(20, Math.max(1, Math.trunc(Number(process.env.P013_ACTUAL_MODEL_SAMPLES)) || 5));
const PROMPT = 'Reply with exactly one word: pong';
const MODEL_LINE = `const reply = await tools.p013d.modelCall({ prompt: ${JSON.stringify(PROMPT)} });`;

interface ModelCall {
  modelMs: number; text: string; inputTokens: number; outputTokens: number; costUsd: number; servedAccount: string | null;
}
interface SmokeSample extends ModelCall {
  arm: P013DArm; runId: string; workflowId: string | null; totalMs: number; overheadMs: number;
}

/** Keyed by the id nested tools see as ctx.runId: the durable workflow id, else the caller's run id. */
const modelCalls = new Map<string, ModelCall>();

/** Insert the model call before the declared-wait line, the one line on which the arms differ. */
function withModelCall(script: string): string {
  const lines = script.split('\n');
  const at = lines.findIndex((line) => /tools\.(p013d\.wait|runtime\.sleep)\(/.test(line));
  if (at < 0) throw new Error('P-013 model smoke: workload D script has no declared-wait line');
  return [...lines.slice(0, at), MODEL_LINE, ...lines.slice(at)].join('\n');
}

function modelCallTool(): ProjectedTool {
  return {
    pluginName: 'p013-actual-model-smoke',
    description: 'P-013 actual-model smoke: one real provider call',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['prompt'],
      additionalProperties: false,
    },
    capabilities: [],
    agentRoles: [P013D_ROLE as NonNullable<ProjectedTool['agentRoles']>[number]],
    effect: 'read',
    idempotent: true,
    expose: { mcp: { name: 'p013d:model_call' } },
    fn: async (args: unknown, ctx: UnifiedToolContext): Promise<ToolResult> => {
      const { llmCall } = await import('../llm-testing/llm-client');
      const started = performance.now();
      const res = await llmCall({
        model: MODEL,
        messages: [{ role: 'user', content: String((args as { prompt?: unknown } | null)?.prompt ?? '') }],
        maxTokens: 16,
        temperature: 0,
      });
      const call: ModelCall = {
        modelMs: performance.now() - started,
        text: res.text,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        servedAccount: res.servedAccount ?? null,
      };
      const runId = String(ctx.runId ?? '');
      if (!modelCalls.has(runId)) modelCalls.set(runId, call);
      return { content: [{ type: 'text', text: JSON.stringify({ text: res.text }) }] } as ToolResult;
    },
  } as ProjectedTool;
}

function extractWorkflowId(body: Record<string, unknown>): string {
  const summary = body.summary;
  const parsed = (typeof summary === 'string' ? JSON.parse(summary) : summary) as Record<string, unknown> | undefined;
  const workflowId = (parsed?.durableRun as { workflowId?: string } | undefined)?.workflowId;
  if (!workflowId) throw new Error(`P-013 model smoke: durable admission returned no workflowId: ${JSON.stringify(body).slice(0, 600)}`);
  return workflowId;
}

function assertOk(arm: P013DArm, body: unknown): void {
  const text = JSON.stringify(body);
  if (!text.includes('"ok":true') && !text.includes('\\"ok\\":true')) {
    throw new Error(`P-013 model smoke ${arm}: run did not succeed: ${text.slice(0, 800)}`);
  }
}

function takeModelCall(runId: string): ModelCall {
  const call = modelCalls.get(runId);
  modelCalls.delete(runId);
  if (!call) throw new Error(`P-013 model smoke: no model call recorded for ${runId}`);
  return call;
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
};
const round1 = (value: number): number => Math.round(value * 10) / 10;

let db: OrgTestDb | undefined;
let rt: BootedP013DRuntime | undefined;

beforeAll(async () => {
  if (!ENABLED) return;
  const { isLlmAvailable } = await import('../llm-testing/llm-client');
  if (!(await isLlmAvailable())) throw new Error('P-013 model smoke: P013_ACTUAL_MODEL=1 but no LLM transport is available');
  db = await createOrgTestDb({ adminPoolMax: 16 });
  fixture.sql = db.adminSql;
  rt = await bootP013DRuntime({
    sql: db.adminSql, systemDsn: db.adminDsn, executorId: `p013m-parent-${process.pid}`, durable: true,
  });
  const { registerProjectedTool } = await import('@papercusp/tooldef');
  registerProjectedTool(modelCallTool());
}, 180_000);

afterAll(async () => {
  await rt?.shutdown().catch(() => {});
  await db?.cleanup();
}, 60_000);

describe('P-013 bounded actual-model smoke (ungraded, D-016)', () => {
  it('keeps the smoke scripts identical to workload D apart from the one model-call line', () => {
    for (const arm of ['control', 'candidate'] as const) {
      const script = withModelCall(P013D_SCRIPTS[arm]);
      expect(script.split('\n').filter((line) => line === MODEL_LINE)).toHaveLength(1);
      expect(script.replace(`${MODEL_LINE}\n`, '')).toBe(P013D_SCRIPTS[arm]);
    }
  });

  it.skipIf(!ENABLED)('runs workload D with one real model call through both arms', async () => {
    const runtime = rt!;
    const scripts: Record<P013DArm, string> = {
      control: withModelCall(P013D_SCRIPTS.control),
      candidate: withModelCall(P013D_SCRIPTS.candidate),
    };
    const inspected = parseToolJson(await runtime.tools.inspectTool.handler({
      script: { source: scripts.candidate },
      execution: { lifecycle: 'background', durability: 'durable' },
    } as never, p013DCaller('p013m-inspect', 'p013m-inspect') as never));
    const pin = findInspectionPin(inspected);
    if (!pin) throw new Error(`P-013 model smoke: orchestrate:inspect returned no pin: ${JSON.stringify(inspected).slice(0, 600)}`);

    let sequence = 0;
    const run = async (arm: P013DArm): Promise<SmokeSample> => {
      const runId = `p013m-${arm}-${process.pid}-${sequence++}`;
      const caller = p013DCaller(runId, `p013m:${runId}`);
      const ingress = epochNow();
      let workflowId: string | null = null;
      if (arm === 'control') {
        assertOk(arm, parseToolJson(await runtime.tools.runTool.handler({ script: { source: scripts.control } } as never, caller as never)));
      } else {
        const admitted = await runtime.tools.runTool.handler({
          script: { source: scripts.candidate },
          execution: { lifecycle: 'background', durability: 'durable' },
          inspectionPin: pin,
          timeoutSec: 120,
        } as never, caller as never);
        workflowId = extractWorkflowId(parseToolJson(admitted));
        const outcome = await runtime.awaitDurable(workflowId, 120) as { status?: string } | null;
        if (outcome?.status !== 'succeeded') {
          throw new Error(`P-013 model smoke: durable run ${workflowId} settled ${JSON.stringify(outcome).slice(0, 800)}`);
        }
      }
      const totalMs = epochNow() - ingress;
      const call = takeModelCall(workflowId ?? runId);
      return { arm, runId, workflowId, totalMs, overheadMs: totalMs - call.modelMs, ...call };
    };

    await run('control');
    await run('candidate');
    const samples: SmokeSample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const order: P013DArm[] = i % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control'];
      for (const arm of order) samples.push(await run(arm));
    }

    const writes = await assertWriteExactlyOnce(runtime.sql, samples.map((s) => s.workflowId ?? s.runId));
    const arms = Object.fromEntries((['control', 'candidate'] as const).map((arm) => {
      const own = samples.filter((s) => s.arm === arm);
      const col = (pick: (s: SmokeSample) => number) => own.map(pick);
      return [arm, {
        n: own.length,
        totalMs: { p50: round1(quantile(col((s) => s.totalMs), 0.5)), max: round1(Math.max(...col((s) => s.totalMs))) },
        modelMs: { p50: round1(quantile(col((s) => s.modelMs), 0.5)), max: round1(Math.max(...col((s) => s.modelMs))) },
        overheadMs: { p50: round1(quantile(col((s) => s.overheadMs), 0.5)), max: round1(Math.max(...col((s) => s.overheadMs))) },
        overheadShareP50: round1(100 * quantile(col((s) => s.overheadMs / s.totalMs), 0.5)),
        tokens: { input: own.reduce((a, s) => a + s.inputTokens, 0), output: own.reduce((a, s) => a + s.outputTokens, 0) },
        costUsd: Math.round(own.reduce((a, s) => a + s.costUsd, 0) * 1e6) / 1e6,
        servedAccounts: [...new Set(own.map((s) => s.servedAccount ?? 'unexposed'))],
      }];
    }));
    console.log(`P-013 actual-model smoke ${JSON.stringify({
      model: MODEL, samplesPerArm: SAMPLES, warmupsPerArm: 1, graded: false, decision: 'D-016', writes, arms,
      samples: samples.map((s) => ({
        arm: s.arm, totalMs: round1(s.totalMs), modelMs: round1(s.modelMs), overheadMs: round1(s.overheadMs), reply: s.text.slice(0, 40),
      })),
    })}`);

    expect(samples).toHaveLength(SAMPLES * 2);
    for (const sample of samples) {
      expect(sample.text.trim().length).toBeGreaterThan(0);
      expect(sample.outputTokens).toBeGreaterThan(0);
      expect(sample.modelMs).toBeGreaterThan(0);
      expect(sample.modelMs).toBeLessThanOrEqual(sample.totalMs);
    }
  }, 600_000);
});
