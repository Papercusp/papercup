/**
 * P-014 / P-015 (plan blueprint-backed-work-item-execution-2026-09-23, BAR R-12)
 * — DEPLOYED-PLANE smoke for blueprint operations.
 *
 * R-12 requires deployed evidence: the documented examples must work against a
 * running platform build, not only against an in-process fixture. The docs suite
 * (operation-docs-examples.integration.test.ts) proves the page against the
 * current source on a fresh PostgreSQL, and settles its direct work item with a
 * simulated durable write. This suite proves the same page against a real
 * operator, over the real authenticated transports, with nothing simulated:
 *
 *   • /api/health names the build under test (optionally pinned by sha);
 *   • every documented HTTP route is served (a validation refusal, never a 404);
 *   • a neutral harness is created through the public `harness:create` door
 *     with the DOCUMENTED declaration (plus the documented plan-target
 *     operation), then:
 *       – agent op: submit → replay → conflict → status → pending result →
 *         signal (+ replay) → events → cancel → terminal `cancelled`;
 *       – program op: submit → terminal `ready` whose output validates against
 *         the declared resultSchema (the real program settlement shape);
 *       – plan-target op: submit → a plan run instance → cancel.
 *
 * Opt-in: it runs only when P015_DEPLOYED_OPERATOR_URL is set (for example
 * http://127.0.0.1:3070), so the gate never reaches a live host. Evidence from
 * it is bound with details.evidencePlane:'deployed' only for a run against the
 * shipped build (P015_EXPECTED_SHA pins that).
 *
 * The run writes real state to the target workspace: one harness (reused on
 * later runs), one work item per agent/program submission, and one plan run.
 * The agent op is cancelled within seconds of admission.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSuperuserToken } from '../superuser-token';
import {
  BLUEPRINT_OPERATION_TOOLS,
  BlueprintOperationCancelReceiptSchema,
  BlueprintOperationEventsPageSchema,
  BlueprintOperationInputReceiptSchema,
  BlueprintOperationResultSchema,
  BlueprintOperationStatusSchema,
  SubmitResultSchema,
} from './operation-contract';
import { P013B_OPERATION, P013B_TEMPLATE, P013B_TEMPLATE_CONTENT } from './operation-performance-b-driver';

const BASE = process.env.P015_DEPLOYED_OPERATOR_URL?.replace(/\/+$/, '');
const EXPECTED_SHA = process.env.P015_EXPECTED_SHA?.trim() || null;
const WORKSPACE = process.env.P015_SMOKE_WORKSPACE?.trim() || 'papercusp-workspace';
const CLIENT = process.env.P015_SMOKE_CLIENT?.trim() || process.env.PAPERCUSP_SID?.trim() || 'p015-deployed-smoke';
const SMOKE_HARNESS = process.env.P015_SMOKE_HARNESS?.trim() || 'p015-deployed-smoke';
const SMOKE_PARENT = process.env.P015_SMOKE_PARENT_DIR?.trim() || join(homedir(), '.papercusp', 'smoke-harnesses');
const PROGRAM_SETTLE_MS = Number(process.env.P015_PROGRAM_SETTLE_MS ?? 180_000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const DOC_PATH = process.env.P015_DOC_PATH
  ?? join(REPO_ROOT, 'apps/operator-docs/src/content/docs/harness/blueprint-operations.mdx');

/** The page's `runnable=<id>` JSON fences — the same extraction the docs suite uses. */
function runnable<T = Record<string, unknown>>(id: string): T {
  const page = readFileSync(DOC_PATH, 'utf8');
  const re = /^```(\w*)([^\n]*)\n([\s\S]*?)^```\s*$/gm;
  for (let m = re.exec(page); m; m = re.exec(page)) {
    if (/(?:^|\s)runnable=([\w-]+)/.exec(m[2])?.[1] === id) return JSON.parse(m[3]) as T;
  }
  throw new Error(`runnable fence ${id} missing from ${DOC_PATH}`);
}

class ToolRefusal extends Error {
  constructor(readonly tool: string, readonly body: unknown) {
    super(`${tool} refused: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 2000));
  }
}

/** Decode one streamable-HTTP MCP response (JSON body or SSE frames). */
function decodeMcp(raw: string, id: number): unknown {
  const frames = raw.trimStart().startsWith('{')
    ? [raw.trim()]
    : raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const frame of frames) {
    let d: { id?: number; error?: unknown; result?: Record<string, unknown> };
    try { d = JSON.parse(frame); } catch { continue; }
    if (d.id !== id) continue;
    if (d.error) throw new ToolRefusal('jsonrpc', d.error);
    const result = d.result ?? {};
    if (result.isError === true) throw new ToolRefusal('tool', result.content ?? result);
    const texts = Array.isArray(result.content)
      ? (result.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === 'text' && typeof c.text === 'string')
      : [];
    for (const t of texts) {
      try { return JSON.parse(t.text!); } catch { /* advisory text; keep looking */ }
    }
    if ('structuredContent' in result) return result.structuredContent;
    return texts[0]?.text ?? result;
  }
  throw new Error(`no JSON-RPC response for id ${id} in: ${raw.slice(0, 500)}`);
}

let rpcId = 0;
async function mcp(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const token = readSuperuserToken();
  if (!token) throw new Error('no superuser token (~/.papercusp/superuser-token) — cannot authenticate to the deployed host');
  const id = ++rpcId;
  const qs = new URLSearchParams({ superuser: '1', client: CLIENT, workspace: WORKSPACE, format: 'json' });
  const res = await fetch(`${BASE}/api/mcp?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  try {
    return decodeMcp(raw, id);
  } catch (err) {
    if (err instanceof ToolRefusal) throw new ToolRefusal(tool, err.body);
    throw new Error(`${tool}: HTTP ${res.status}: ${(err as Error).message}`);
  }
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  throw new Error('expected a refusal, got a result');
}

const T = BLUEPRINT_OPERATION_TOOLS;
type Handle = Record<string, unknown>;

async function submit(operationId: string, requestKey: string, input: Record<string, unknown>): Promise<Handle> {
  return SubmitResultSchema.parse(await mcp(T.submit, { harness: SMOKE_HARNESS, operationId, requestKey, input })).handle as Handle;
}
const status = async (handle: Handle) => BlueprintOperationStatusSchema.parse(await mcp(T.status, { handle }));
const result = async (handle: Handle) => BlueprintOperationResultSchema.parse(await mcp(T.result, { handle }));

/** The documented declaration plus the documented plan-target operation. */
function smokeDeclaration(): Record<string, unknown> {
  const declaration = runnable<{ operations: unknown[] } & Record<string, unknown>>('declaration');
  return { ...declaration, id: SMOKE_HARNESS, operations: [...declaration.operations, runnable('plan-target')] };
}

describe.skipIf(!BASE)('blueprint operations on a DEPLOYED operator (R-12 deployed plane)', () => {
  const run = randomUUID().slice(0, 8);

  it('serves the build under test and every documented HTTP route', async () => {
    const health = await (await fetch(`${BASE}/api/health`)).json() as { ok: boolean; sha: string };
    expect(health.ok).toBe(true);
    // Printed so a bound evidence row can name the exact deployed build.
    console.log(`P015_DEPLOYED_SMOKE build sha=${health.sha} url=${BASE}`);
    if (EXPECTED_SHA) expect(EXPECTED_SHA.startsWith(health.sha) || health.sha.startsWith(EXPECTED_SHA)).toBe(true);

    const routes = runnable<Record<string, string>>('tool-routes');
    expect(Object.keys(routes).sort()).toEqual(Object.values(T).sort());
    for (const [name, path] of Object.entries(routes)) {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readSuperuserToken()}` },
        body: '{}',
      });
      // An empty body must be refused by the tool's own schema; 404/405 means the route is not served.
      expect([404, 405], `${name} → ${path} answered ${res.status}`).not.toContain(res.status);
    }
  });

  it('creates (or reuses) a neutral harness from the documented declaration', async () => {
    try {
      await mcp('harness:create', {
        slug: SMOKE_HARNESS, parentDir: SMOKE_PARENT, folderName: SMOKE_HARNESS, blueprint: smokeDeclaration(),
      });
    } catch (err) {
      // A prior run left the harness in place; anything else is a real failure.
      if (!/exist|already|taken|registered/i.test((err as Error).message)) throw err;
    }
    // The plan-target operation needs its pinned template in this harness.
    try {
      await mcp('plans:new', {
        harness: SMOKE_HARNESS, slug: P013B_TEMPLATE, title: 'P-013 fork/join', content: P013B_TEMPLATE_CONTENT, status: 'active',
      });
    } catch (err) {
      if (!/exist|already|taken|duplicate/i.test((err as Error).message)) throw err;
    }
  }, 120_000);

  it('runs the documented agent operation lifecycle and cancels it', async () => {
    const key = `p015-agent-${run}`;
    const handle = await submit('extract', key, { value: `deployed-${run}` });
    // Same key + same input replays the same handle; a different input conflicts.
    expect(await submit('extract', key, { value: `deployed-${run}` })).toEqual(handle);
    expect(await refusalOf(submit('extract', key, { value: 'other' }))).toMatch(/conflict|request_key|requestKey/i);

    const first = await status(handle);
    expect(['accepted', 'dispatched', 'waiting']).toContain(first.phase);
    expect((await result(handle)).state).toBe('pending');

    const signalArgs = { handle, channel: 'note', payload: { text: 'hi' }, requestKey: `${key}-note` };
    const receipt = BlueprintOperationInputReceiptSchema.parse(await mcp(T.signal, signalArgs));
    expect(receipt.replayed).toBe(false);
    const replay = BlueprintOperationInputReceiptSchema.parse(await mcp(T.signal, signalArgs));
    expect(replay).toMatchObject({ replayed: true, eventId: receipt.eventId });

    const page = BlueprintOperationEventsPageSchema.parse(await mcp(T.events, { handle }));
    expect(page.events.length).toBeGreaterThan(0);

    const cancel = BlueprintOperationCancelReceiptSchema.parse(
      await mcp(T.cancel, { handle, requestKey: `${key}-cancel`, reason: 'P-015 deployed smoke: lifecycle proven' }));
    expect(cancel.effected).toBe(true);
    const deadline = Date.now() + 60_000;
    let settled = await result(handle);
    while (settled.state === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      settled = await result(handle);
    }
    expect(settled.state).toBe('cancelled');
    expect(settled.status).toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
  }, 180_000);

  it('settles the documented program operation ready with its declared result shape', async () => {
    const handle = await submit('extract-program', `p015-program-${run}`, { value: `deployed-${run}` });
    const deadline = Date.now() + PROGRAM_SETTLE_MS;
    let settled = await result(handle);
    while (settled.state === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      settled = await result(handle);
    }
    expect(settled.state, JSON.stringify(settled).slice(0, 1500)).toBe('ready');
    if (settled.state !== 'ready') return;
    // The declared resultSchema: { outcome: string, resolved: boolean }, nothing else.
    expect(settled.output).toEqual({ outcome: expect.any(String), resolved: expect.any(Boolean) });
    expect(Object.keys(settled.output as object).sort()).toEqual(['outcome', 'resolved']);
    expect(settled.status).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(settled.evidenceRef).toBeTruthy();
  }, PROGRAM_SETTLE_MS + 60_000);

  it('admits the documented plan-target operation as a plan run and cancels it', async () => {
    const key = `p015-plan-${run}`;
    const handle = await submit(P013B_OPERATION, key, { value: `deployed-${run}` });
    expect(handle).toMatchObject({ target: { kind: 'plan' } });
    const target = handle.target as { runId?: unknown; instanceSlug?: unknown };
    expect(target.runId).toBeTruthy();
    expect(target.instanceSlug).toBeTruthy();
    const current = await status(handle);
    expect(current.planRun).not.toBeNull();
    const cancel = BlueprintOperationCancelReceiptSchema.parse(
      await mcp(T.cancel, { handle, requestKey: `${key}-cancel`, reason: 'P-015 deployed smoke: plan admission proven' }));
    expect(cancel.effected).toBe(true);
  }, 120_000);
});
