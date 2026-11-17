/** Local scripted Responses protocol; no provider credentials or forwarding. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { decode } from '@papercusp/result-encoding';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../lib/inference-gateway/codex-cli-bridge';
import type { CurrentBenchmarkProtocol } from '../lib/external-bench/reproducibility/schema';
import { allCapabilities } from '../lib/external-bench/reproducibility/_protocol-test-fixture';

type Body = Record<string, unknown>;
type Tool = { type: string; name: string; tools?: Tool[] };

/** Match the installed CLI's discovery contract without credentials or inference.
 * An empty catalog preserves its installed model metadata; this fixture does not
 * claim provider model availability. Keep the cheap native startup probe and the
 * full private-host scenario on the same discovery response. */
export function serveCurrentSuNativeModelDiscovery(req: IncomingMessage, res: ServerResponse): boolean {
  const path = req.url?.split('?', 1)[0];
  if (req.method !== 'GET' || (path !== '/models' && path !== '/v1/models')) return false;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"models":[]}');
  return true;
}

function queuedCompactionAcknowledgement(value: unknown): Body | null {
  if (typeof value === 'string') {
    try { return queuedCompactionAcknowledgement(JSON.parse(value)); } catch { /* Try the lossless compact format. */ }
    const marker = /^format:\s*toon\n/.exec(value);
    if (!marker) return null;
    try { return queuedCompactionAcknowledgement(decode(value.slice(marker[0].length), 'toon')); }
    catch { return null; }
  }
  if (Array.isArray(value)) return value.map(queuedCompactionAcknowledgement).find(Boolean) ?? null;
  if (!value || typeof value !== 'object') return null;
  const body = value as Body;
  if (body.isError === true || body.ok === false) return null;
  if (body.requested === true && (body.respawn === 'queued' || body.status === 'queued')) return body;
  if (body.structuredContent !== undefined) return queuedCompactionAcknowledgement(body.structuredContent);
  if (Array.isArray(body.content)) return queuedCompactionAcknowledgement(body.content);
  // Native code-mode results use input_text; direct MCP results use text.
  // Decode only these transport bodies, never incidental prose in other fields.
  return ['text', 'input_text'].includes(String(body.type)) && typeof body.text === 'string'
    ? queuedCompactionAcknowledgement(body.text) : null;
}

export const FROZEN_NATIVE_CARRY_NOTE = 'The assignment already changed answer.txt to after; verify that retained edit.';
export const FROZEN_NATIVE_CARRY_LIMIT = 20_000;

/** Pin the private lifecycle experiment before preregistration and launch.
 * This fixture does not register a runnable paid-study ablation. */
export function freezeCurrentSuNativeCarryProtocol(config: CurrentBenchmarkProtocol, mode: 'on' | 'off') {
  for (const arm of config.arms) arm.control = { topology: 'solo', solverGroup: 'private-frozen-carry',
    solverToolsHash: 'f'.repeat(64), compactionLimit: FROZEN_NATIVE_CARRY_LIMIT,
    capabilities: { ...allCapabilities('off'), 'carry-respawn': arm.id === 'papercusp' ? mode : 'off' } };
}

/** Retain the complete managed user packet observed at the native transport.
 * This observes delivery only; fixture/action/oracle bindings remain separate. */
export function inspectCurrentSuNativeCarryInput(body: Body, expected: { predecessorId: string }) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const input = Array.isArray(body.input) ? body.input as Body[] : [];
  const userTurns = input.filter(item => item.role === 'user').map(item => {
    if (typeof item.content === 'string') return { text: item.content, complete: true };
    const parts = Array.isArray(item.content) ? item.content as Body[] : [];
    return { text: parts.map(part => typeof part?.text === 'string' ? part.text : '').join(''),
      complete: parts.length > 0 && parts.every(part => part &&
        ['input_text', 'text'].includes(String(part.type)) && typeof part.text === 'string') };
  });
  const turns = userTurns.filter(turn => /^⟦turn-origin:self-compaction nonce:[a-f0-9]+⟧\n/.test(turn.text));
  assert.equal(turns.length, 1, 'Managed carry needs exactly one native user turn with its leading provenance');
  assert.ok(turns[0].complete, 'Native carry packet contains unobserved non-text content');
  assert.ok(!input.some(item => ['function_call_output', 'custom_tool_call_output'].includes(String(item.type))),
    'Fresh carry must not replay predecessor tool results');
  const actual = turns[0].text;
  const match = /^⟦turn-origin:self-compaction nonce:[a-f0-9]+⟧\n([\s\S]*?)\n\n⟦codex-carry-lineage predecessor:([^⟧]+)⟧\n/.exec(actual);
  assert.ok(match, 'Managed carry native turn lacks its first prompt and lineage boundary');
  assert.ok(expected.predecessorId.trim(), 'Native carry needs an independently bound predecessor');
  assert.equal(match[2], expected.predecessorId, 'Managed carry names a foreign predecessor');
  assert.equal([...actual.matchAll(/^⟦codex-carry-lineage predecessor:[^⟧\n]+⟧$/gm)].length, 1,
    'Native carry packet has ambiguous lineage');
  const inputPacket = JSON.stringify(input);
  return { schemaVersion: 1 as const, client: 'codex' as const, predecessorId: expected.predecessorId,
    packet: actual, packetSha256: hash(actual), packetChars: actual.length,
    packetBytes: Buffer.byteLength(actual, 'utf8'), inputSha256: hash(inputPacket),
    // Other native input items can contain injected developer/orientation text.
    // Retain them rather than measuring only the marked carry user turn.
    inputPacket, inputChars: inputPacket.length, inputBytes: Buffer.byteLength(inputPacket, 'utf8') };
}

/** Check the frozen assignment against independently observed native bytes. */
export function inspectFrozenNativeCarryInput(body: Body, expected: {
  mode: 'on' | 'off'; initialPrompt: string; predecessorId: string;
}) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const delivered = inspectCurrentSuNativeCarryInput(body, expected);
  const actual = delivered.packet;
  const match = /^⟦turn-origin:self-compaction nonce:[a-f0-9]+⟧\n([\s\S]*?)\n\n⟦codex-carry-lineage predecessor:([^⟧]+)⟧\n/.exec(actual)!;
  const note = expected.mode === 'on' ? FROZEN_NATIVE_CARRY_NOTE : null;
  const firstPrompt = expected.initialPrompt + (note
    ? `\n\nContinuation note from this assignment's prior session:\n${note}` : '');
  assert.equal(match[1], firstPrompt, 'Native delivered carry differs from its frozen task/note bytes');
  if (!note) assert.ok(!JSON.stringify(body.input).includes(FROZEN_NATIVE_CARRY_NOTE), 'Carry-off received the prior note');
  return { mode: expected.mode, inputSha256: hash(actual), firstPromptSha256: hash(match[1]),
    initialPromptSha256: hash(expected.initialPrompt), noteSha256: note ? hash(note) : null };
}

function offeredTools(body: Body) {
  const flattened: Array<Tool & { namespace?: string }> = [];
  const visit = (tools: Tool[], namespace?: string) => {
    for (const tool of tools) {
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) visit(tool.tools, tool.name);
      else flattened.push({ ...tool, namespace });
    }
  };
  visit(Array.isArray(body.tools) ? body.tools as Tool[] : []);
  return flattened;
}

function scriptedTool(body: Body, kind: 'edit' | 'compact', options: { frozen?: boolean; carryMode?: 'on' | 'off' } = {}) {
  const flattened = offeredTools(body);
  const command = "printf 'after\\n' > /app/answer.txt";
  const direct = flattened.find(tool => tool.type === 'function' && (kind === 'edit'
    ? /(?:^|__)exec_command$/.test(tool.name)
    : /(?:^|__)session_request_compaction$/.test(tool.name)));
  const invoke = flattened.find(tool => tool.type === 'function' && /(?:^|__)tools_invoke$/.test(tool.name));
  const exec = flattened.find(tool => tool.type === 'custom' && tool.name === 'exec' && tool.namespace === 'functions');
  const tool = direct ?? (kind === 'compact' ? invoke : undefined) ?? exec;
  assert.ok(tool, `Native ${kind} tool missing: ${JSON.stringify(flattened.map(({ type, name, namespace }) => ({ type, name, namespace })))}`);
  const compactArgs = options.frozen && options.carryMode !== 'off' ? { continueNote: FROZEN_NATIVE_CARRY_NOTE } : {};
  const input = direct ? kind === 'edit' ? { cmd: command } : compactArgs
    : kind === 'compact' ? { name: 'session:request-compaction', args: compactArgs } : { cmd: command };
  const text = tool === exec ? kind === 'edit'
    ? `text(await tools.exec_command(${JSON.stringify(input)}));`
    : `text(await tools.mcp__papercusp_su__tools_invoke(${JSON.stringify(input)}));` : JSON.stringify(input);
  const call = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
    id: 'fc_private_' + kind, call_id: 'call_private_' + kind, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    ...(tool.type === 'custom' ? { input: text } : { arguments: text }), status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: String(body.model), text: '',
    inputTokens: options.frozen ? FROZEN_NATIVE_CARRY_LIMIT + 2_000 : 100, outputTokens: 8 }), output: [call] };
  return ['response.output_item.added', 'response.output_item.done', 'response.completed'].map(type =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(type === 'response.completed'
      ? { response } : { output_index: 0, item: call }) })}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** One real MCP call at a time, using the native client's offered surface. */
function scriptedRecoveryTool(body: Body, name: string, args: Body, callId: string) {
  const tools = offeredTools(body), suffix = name.replace(/[:-]/g, '_');
  const direct = tools.find(tool => tool.type === 'function' &&
    (tool.name === suffix || tool.name.endsWith('__' + suffix)));
  const invoke = tools.find(tool => tool.type === 'function' && /(?:^|__)tools_invoke$/.test(tool.name));
  const exec = tools.find(tool => tool.type === 'custom' && tool.name === 'exec' && tool.namespace === 'functions');
  const tool = direct ?? invoke ?? exec;
  assert.ok(tool, 'Native recovery tool unavailable: ' + name);
  const input = direct ? args : { name, args: { ...args, payloadTier: 'full' } };
  const encoded = tool === exec
    ? `text(await tools.mcp__papercusp_su__tools_invoke(${JSON.stringify(input)}));` : JSON.stringify(input);
  const call = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
    id: 'fc_' + callId, call_id: callId, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    ...(tool.type === 'custom' ? { input: encoded } : { arguments: encoded }), status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: String(body.model), text: '', inputTokens: 100, outputTokens: 8 }),
    output: [call] };
  return ['response.output_item.added', 'response.output_item.done', 'response.completed'].map(type =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(type === 'response.completed'
      ? { response } : { output_index: 0, item: call }) })}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** Decode only actual result envelopes. Incidental prose is not a receipt. */
function recoveryResultBodies(value: unknown, depth = 0): Body[] {
  if (depth > 16) return [];
  if (typeof value === 'string') {
    try { return recoveryResultBodies(JSON.parse(value), depth + 1); } catch { /* Try lossless TOON. */ }
    const marker = /^format:\s*toon\n/.exec(value);
    if (!marker) return [];
    try { return recoveryResultBodies(decode(value.slice(marker[0].length), 'toon'), depth + 1); }
    catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => recoveryResultBodies(item, depth + 1));
  if (!value || typeof value !== 'object') return [];
  const result = value as Body;
  if (result.isError === true || result.ok === false) return [result];
  if (result.structuredContent !== undefined) return recoveryResultBodies(result.structuredContent, depth + 1);
  if (Array.isArray(result.content)) return recoveryResultBodies(result.content, depth + 1);
  if (['text', 'input_text'].includes(String(result.type)) && typeof result.text === 'string')
    return recoveryResultBodies(result.text, depth + 1);
  return [result];
}

export interface CurrentSuRecoveryContinuationInput {
  predecessorId: string;
  ownerId: string;
  workItemId: string;
  harnessSlug: string;
  facts: Array<{ scope: 'workspace' | 'owner' | 'harness' | 'work_item'; scopeRef?: string; key: string; body: string }>;
  /** Exact independently frozen permitted action, not inferred from a packet. */
  action: { slug: string; rel_path: string; content: string };
}

/** Native baseline protocol extension, not a paired measurement or an oracle.
 * It reacquires the specified premises through exact canonical reads, checks
 * current custody, and observes the permitted save followed by exact readback.
 * Actual leaf IDs, validity adjudication and outcome grading remain with P015. */
export function createCurrentSuRecoveryContinuation(value: CurrentSuRecoveryContinuationInput) {
  const input: CurrentSuRecoveryContinuationInput = JSON.parse(JSON.stringify(value));
  assert.ok(input.predecessorId && input.ownerId && input.harnessSlug);
  assert.match(input.workItemId, /^(?:WI|EI|F)-\d+$/);
  assert.equal(input.action.slug, input.harnessSlug);
  assert.ok(input.action.rel_path && input.facts.length);
  let state: 'initial' | 'custody' | 'fact' | 'save' | 'load' | 'done' | 'stopped' = 'initial';
  let pending: { callId: string; name: string; args: Body; issuedAt: string; rawOutput?: unknown; receivedAt?: string } | undefined;
  const calls: NonNullable<typeof pending>[] = [];
  let factIndex = 0, stopReason: string | undefined;
  let delivery: ReturnType<typeof inspectCurrentSuNativeCarryInput> | undefined;
  const stop = (reason: string) => { state = 'stopped'; stopReason = reason; return undefined; };
  const issue = (body: Body, name: string, args: Body, next: typeof state) => {
    const callId = 'call_private_recovery_' + calls.length;
    const wire = scriptedRecoveryTool(body, name, args, callId);
    pending = { callId, name, args, issuedAt: new Date().toISOString() };
    calls.push(pending); state = next;
    return wire;
  };
  const nextFact = (body: Body) => {
    const fact = input.facts[factIndex];
    return fact ? issue(body, 'facts:list', { scope: fact.scope,
      ...(fact.scopeRef !== undefined ? { scopeRef: fact.scopeRef } : {}), key: fact.key, full: true }, 'fact')
      : issue(body, 'artifacts:save', input.action, 'save');
  };
  return {
    get finished() { return state === 'done' || state === 'stopped'; },
    get receipt() { return structuredClone({ schemaVersion: 1, state, stopReason, delivery, calls,
      correctReadbackObserved: state === 'done',
      notExercised: ['canonical-leaf-read-ids', 'source-validity-adjudication', 'paired-outcome-ledger'] }); },
    respond(body: Body): string | undefined {
      if (state === 'done' || state === 'stopped') return undefined;
      if (state === 'initial') {
        delivery = inspectCurrentSuNativeCarryInput(body, { predecessorId: input.predecessorId });
        return issue(body, 'work_items:get', { id: input.workItemId, harness: input.harnessSlug }, 'custody');
      }
      const items = Array.isArray(body.input) ? body.input as Body[] : [];
      const result = items.find(item => ['function_call_output', 'custom_tool_call_output'].includes(String(item.type))
        && item.call_id === pending?.callId);
      // An uncorrelated request cannot repeat an outstanding write or prove it.
      if (!result || !pending) return undefined;
      pending.rawOutput = result.output; pending.receivedAt = new Date().toISOString();
      const bodies = recoveryResultBodies(result.output);
      if (!bodies.length || bodies.some(item => item.isError === true || item.ok === false))
        return stop('unqualified-' + state + '-receipt');
      if (state === 'custody') {
        const rows = bodies.flatMap(item => Array.isArray(item.results) ? item.results as Body[] : []);
        const row = rows.find(item => item.id === input.workItemId && item.ok === true && item.availability === 'available');
        const held = row?.workItem as Body | undefined;
        if (!held || held.id !== input.workItemId || held.assignee !== input.ownerId
          || held.harness !== input.harnessSlug || !['open', 'wip'].includes(String(held.state)))
          return stop('current-custody-not-proven');
        return nextFact(body);
      }
      if (state === 'fact') {
        const fact = input.facts[factIndex];
        const rows = bodies.flatMap(item => Array.isArray(item.facts) ? item.facts as Body[] : []);
        const exact = rows.filter(row => row.scope === fact.scope && (row.ref ?? row.scopeRef ?? null) === (fact.scopeRef ?? null)
          && row.key === fact.key && row.body === fact.body && row.retractedAt === null && row.body_truncated !== true);
        if (exact.length !== 1) return stop('exact-scoped-premise-not-proven');
        factIndex++;
        return nextFact(body);
      }
      const rows = bodies.flatMap(item => Array.isArray(item.results) ? item.results as Body[] : []);
      const exact = rows.filter(row => row.ok === true && row.slug === input.action.slug && row.rel_path === input.action.rel_path);
      if (exact.length !== 1) return stop('exact-artifact-receipt-not-proven');
      if (state === 'save') {
        if (exact[0].bytes !== Buffer.byteLength(input.action.content, 'utf8')) return stop('artifact-save-size-mismatch');
        return issue(body, 'artifacts:load', { slug: input.action.slug, rel_path: input.action.rel_path,
          offset: 0, max_chars: 4000 }, 'load');
      }
      if (exact[0].found !== true || exact[0].content !== input.action.content
        || exact[0].content_total_chars !== input.action.content.length || exact[0].content_offset !== 0)
        return stop('exact-artifact-readback-not-proven');
      state = 'done'; pending = undefined;
      return undefined;
    },
  };
}

export function createCurrentSuNativeProtocol(options: { frozen?: boolean; carryMode?: 'on' | 'off';
  afterCarry?: (body: Body) => Promise<string | undefined> | string | undefined } = {}) {
  let initialBody: Body | undefined, initialInput: string | undefined;
  let stage: 'initial' | 'edit' | 'compact' | 'queued' = 'initial';
  let carryInputSeen = false;
  let predecessorSessionId: string | undefined;
  let queuedCarry: Body | null = null;
  const census: Array<Record<string, unknown>> = [];
  const acknowledgement = (body: Body) => codexCliResponsesCompletionSse(codexCliResponsesBody({
    model: String(body.model), text: 'Private managed carry protocol acknowledgement.', inputTokens: 100, outputTokens: 8,
  }));
  return {
    get initialBody() { return initialBody; },
    get carryRequested() { return stage === 'queued'; },
    get carryInputSeen() { return carryInputSeen; },
    get predecessorSessionId() { return predecessorSessionId; },
    get queuedCarry() { return queuedCarry; },
    census,
    async respond(body: Body, proof: { predecessorSessionId: string | null; editApplied: () => boolean;
      binding?: { read: () => Promise<string | null>; deadlineMs: number };
      beforeCompaction?: (nativeId: string) => Promise<void> }) {
      const input = JSON.stringify(body.input) ?? '';
      const items = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const outputs = items.filter(item => item && ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)));
      const result = (kind: 'edit' | 'compact') => outputs.find(item => item.call_id === 'call_private_' + kind);
      const expectedPredecessorSessionId = predecessorSessionId ?? proof.predecessorSessionId;
      const lineage = Boolean(expectedPredecessorSessionId) && input.includes('codex-carry-lineage predecessor:' + expectedPredecessorSessionId);
      const tools = offeredTools(body);
      const row: Record<string, unknown> = { index: census.length + 1, at: new Date().toISOString(),
        stage, bodyKeys: Object.keys(body), inputBytes: Buffer.byteLength(input),
        inputHash: createHash('sha256').update(input).digest('hex'), lineage, expectedPredecessorSessionId,
        tools: tools.map(({ type, name, namespace }) => ({ type, name, namespace })),
        outputs: outputs.map(item => ({ type: item.type, callId: item.call_id,
          // Retain only our fixed protocol results, never the full launch prompt.
          ...(['call_private_edit', 'call_private_compact'].includes(String(item.call_id))
            ? { output: String(typeof item.output === 'string' ? item.output : JSON.stringify(item.output)).slice(-5000) } : {}) })),
        action: 'acknowledge' };
      census.push(row);
      try {
        if (stage === 'compact' && result('compact')) {
          const received = JSON.stringify(result('compact')!.output) ?? '';
          queuedCarry = queuedCompactionAcknowledgement(result('compact')!.output);
          assert.ok(queuedCarry,
            'Managed boundary did not queue: ' + received.slice(-5000));
          stage = 'queued';
        }
        carryInputSeen ||= stage === 'queued' && lineage;
        // A tool-free request has no driving step. Its purpose is deliberately
        // not inferred; the census preserves the framing for native diagnosis.
        if (!tools.length) return acknowledgement(body);
        if (stage === 'queued') {
          const wire = carryInputSeen ? await options.afterCarry?.(body) : undefined;
          return wire ?? acknowledgement(body);
        }
        if (stage === 'initial' && input.includes('<cwd>/app</cwd>')) {
          const wire = scriptedTool(body, 'edit', options);
          initialBody = body; initialInput = input; stage = 'edit'; row.action = 'edit';
          return wire;
        }
        if ((stage === 'edit' || stage === 'compact') && result('edit')) {
          assert.ok(proof.editApplied(), 'Native scripted edit was not applied before compaction');
          const wire = scriptedTool(body, 'compact', options);
          // Initial transport can precede native binding; after compaction the
          // same database row can name the successor. Freeze at the boundary
          // we actually drive, never infer identity from the carry text itself.
          let boundId = predecessorSessionId ?? proof.predecessorSessionId;
          if (!boundId && proof.binding) {
            const binding = proof.binding;
            assert.ok(Number.isFinite(binding.deadlineMs), 'Native binding needs the existing task deadline');
            row.bindingWait = true;
            row.action = 'awaiting-binding';
            // The fast scripted edit can finish before the launcher's native
            // persistence proof publishes its mapping. Hold THIS response,
            // without granting another task budget or deriving an id from text.
            while (!boundId) {
              const remaining = binding.deadlineMs - Date.now();
              assert.ok(remaining > 0, 'Native predecessor binding deadline expired before compaction');
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                boundId = await Promise.race([binding.read(), new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('Native predecessor binding deadline expired before compaction')), remaining);
                })]);
              } finally { clearTimeout(timer); }
              if (!boundId) await new Promise(resolve => setTimeout(resolve, Math.min(50,
                Math.max(0, binding.deadlineMs - Date.now()))));
            }
            assert.ok(proof.editApplied(), 'Native scripted edit was not applied before compaction');
          }
          assert.ok(boundId, 'Native predecessor must be bound before compaction');
          predecessorSessionId ??= boundId;
          await proof.beforeCompaction?.(predecessorSessionId);
          row.expectedPredecessorSessionId = predecessorSessionId;
          stage = 'compact'; row.action = 'compact';
          return wire;
        }
        // A transport retry of the kickoff gets the same idempotent edit call.
        if (stage === 'edit' && input === initialInput) { row.action = 'edit-retry'; return scriptedTool(body, 'edit', options); }
        return acknowledgement(body);
      } catch (error) { row.action = 'failed'; row.error = String(error); throw error; }
      finally { row.nextStage = stage; }
    },
  };
}

/** Node does not await an async request listener. Turn its rejection into an
 * awaited scenario failure so the owner's finally can return container files. */
export function guardedCurrentSuNativeHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  report: (error: unknown) => void) {
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Requests can fail before the scenario reaches its race; keep that failure
  // latched without producing a detached unhandled rejection in the meantime.
  void failure.catch(() => {});
  const listener: RequestListener = (req, res) => {
    void Promise.resolve().then(() => handler(req, res)).catch(error => {
      let observed = error;
      try { report(error); } catch (reportError) { observed = new AggregateError([error, reportError], 'Native handler and diagnostic retention failed'); }
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Private native protocol handler failed' } }));
      } catch { res.destroy(); }
      rejectFailure(observed);
    });
  };
  return { listener, failure };
}
