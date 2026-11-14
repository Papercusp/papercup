/**
 * Normalized, secret-free evidence for one code orchestration execution.
 *
 * This is deliberately an extension of the code-recipes run rail, not another
 * recipe/runtime abstraction. Static calls supply the reusable structure;
 * runtime call records supply truthful dispositions and validated output
 * references. The structural fingerprint excludes backend, outcomes, binding
 * values, ephemeral values, and output-reference identities.
 */
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  checkScript,
  ensureParseCheckReady,
  type OrchestrationCallRecord,
  type OrchestrationOutputReference,
  type ProjectedTool,
} from '@papercusp/tooldef';
import { deriveRecipeAuthority, type RecipeAuthorityRefs } from './recipe-authority';
import { type ReplayClass, type RecipeBindingSchemaV1, recipeBindingSchemaV1Schema } from './recipe-contract';
import type { SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';
import { isSensitiveValueKey, redactSensitiveText } from './sensitive-text';

// The shell-quote package has no bundled types. Keep the boundary typed in
// every importing project, including script/test legs without our ambient .d.ts.
type ShellToken = string | { op: string } | { comment: string };
const parseShellArguments: (source: string, env?: (name: string) => string) => ShellToken[] =
  createRequire(import.meta.url)('shell-quote').parse;

export const ORCHESTRATION_TRACE_SCHEMA_VERSION = 1 as const;
export const OPERATION_TRACE_SCHEMA_VERSION = 2 as const;

export type OperationAdapterFamily = 'composition' | 'shell' | 'sql' | 'native-operation'
  | 'search-reformulation' | 'result-recovery' | 'workaround-funnel';

/** Only opaque identity and scoped references cross into the global recipe rail.
 * Raw SQL, commands, environment values and credentials stay at their source.
 * These references describe evidence; none convey the author's authority. */
export interface OperationAdapterEvidence {
  operationId: string;
  family: OperationAdapterFamily;
  adapterVersion: string;
  semanticIdentity: {
    version: string;
    fingerprint: string;
    workspaceId: string;
    sourceBoundary: string;
    epoch: string;
  };
  source: {
    ref: string;
    authorityRef: string;
    observedAt: string;
    expiresAt: string | null;
    providerCallId?: string;
    parentOperationId?: string;
    choice?: 'agent' | 'hook' | 'system' | 'unknown';
  };
  outcome: {
    status: 'success' | 'error' | 'refused' | 'preview' | 'running' | 'unknown';
    final: boolean;
    receiptRef?: string;
  };
  lifecycle?: {
    attemptId: string;
    yielded: boolean;
    polls: Array<{ providerCallId: string; sourceRef: string; receiptRef?: string }>;
  };
  replayClass: ReplayClass;
  bindingSchema?: RecipeBindingSchemaV1;
  decisionRefs: string[];
}

export interface OperationDependency {
  fromOperationId: string;
  toOperationId: string;
  kind: 'data' | 'control';
  /** An observed binding/control receipt, never an edge inferred from source order. */
  evidenceRef: string;
}

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9_:/.@-]{0,399}$/;
const opaqueRef = (value: unknown): value is string => typeof value === 'string' && OPAQUE_REF.test(value);

/** Safe settlement fields on the existing invocation ledger. Raw results and
 * executable source stay at their authorized source, never in this receipt. */
export interface ManagedOperationReceipt {
  version: 1;
  callId: string;
  parentCallId?: string;
  handlerEntered: boolean;
  role: 'operation' | 'wrapper' | 'poll';
  disposition: string;
  outcome: OperationAdapterEvidence['outcome'];
  job?: { bashId?: string; taskId?: string };
  exitCode?: number;
  yielded?: boolean;
}

export function captureManagedOperation(input: {
  toolName: string; status: string; resultSnapshot?: unknown;
  receipt: { callId: string; parentCallId?: string; handlerEntered: boolean };
}): ManagedOperationReceipt | null {
  const { receipt, toolName, status } = input;
  if (!opaqueRef(receipt.callId) || receipt.parentCallId !== undefined
    && (!opaqueRef(receipt.parentCallId) || receipt.parentCallId === receipt.callId)) return null;
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const result = object(input.resultSnapshot);
  let payload = object(result.structuredContent);
  if (result.structuredContent === undefined && Array.isArray(result.content)) {
    const first = result.content.find(block => object(block).type === 'text');
    const text = object(first).text;
    if (typeof text === 'string' && text.length <= 65536) {
      try { payload = object(JSON.parse(text)); } catch { /* Rendered prose is not a receipt. */ }
    }
  }
  const role = ['tools:invoke', 'functions.exec'].includes(toolName) ? 'wrapper'
    : toolName === 'capability:bash_output' ? 'poll' : 'operation';
  const shell = toolName === 'capability:bash' || role === 'poll';
  const shellReceipt = object(object(result._meta).shellExecution);
  if (shell && shellReceipt.version === 1) payload = shellReceipt;
  const exit = payload.exit_code ?? payload.exitCode;
  const exitCode = typeof exit === 'number' && Number.isSafeInteger(exit) ? exit : undefined;
  const job = shell ? {
    ...(opaqueRef(payload.bash_id) ? { bashId: payload.bash_id } : {}),
    ...(opaqueRef(payload.task_id) ? { taskId: payload.task_id } : {}),
  } : {};
  const refused = ['refused', 'invalid-input', 'role-not-allowed', 'quota-exceeded'].includes(status);
  const failed = ['error', 'timeout'].includes(status) || result.isError === true || payload.ok === false
    || payload.success === false || ['failed', 'killed', 'timed_out'].includes(String(payload.status))
    || exitCode !== undefined && exitCode !== 0;
  const incomplete = payload._partial === true || object(payload._projection).truncated === true;
  const running = shell && exitCode === undefined && (payload.running === true || payload.status === 'running');
  const preview = payload.dryRun === true || payload.dry_run === true;
  const outcome: OperationAdapterEvidence['outcome'] = refused ? { status: 'refused', final: true }
    : failed ? { status: 'error', final: true }
    : preview ? { status: 'preview', final: true }
    : running ? { status: 'running', final: false }
    : status !== 'ok' || !receipt.handlerEntered || incomplete || role === 'wrapper'
      ? { status: 'unknown', final: false }
      : shell ? exitCode === 0 ? { status: 'success', final: true } : { status: 'unknown', final: false }
        : { status: 'success', final: true };
  if (shell && payload.cleanup_pending === true) outcome.final = false;
  return { version: 1, callId: receipt.callId,
    ...(receipt.parentCallId ? { parentCallId: receipt.parentCallId } : {}),
    handlerEntered: receipt.handlerEntered, role, disposition: status, outcome,
    ...(Object.keys(job).length ? { job } : {}), ...(shell && exitCode !== undefined ? { exitCode } : {}),
    ...(shell ? { yielded: payload.yielded === true || running } : {}) };
}
const FAMILIES = new Set<OperationAdapterFamily>(['composition', 'shell', 'sql', 'native-operation',
  'search-reformulation', 'result-recovery', 'workaround-funnel']);

/** Current source authorization is repeated by every consumer; an observed or
 * previously authorized reference is insufficient after revocation or expiry. */
export function readableOperationEvidence(
  trace: Pick<NormalizedExecutionTrace, 'operations'>,
  context: { workspaceId: string; now: number; canRead: (source: OperationAdapterEvidence['source']) => boolean },
): OperationAdapterEvidence[] {
  if (!Number.isFinite(context.now)) return [];
  return (trace.operations ?? []).filter(operation =>
    operation.semanticIdentity.workspaceId === context.workspaceId
    && (operation.source.expiresAt === null || Date.parse(operation.source.expiresAt) > context.now)
    && context.canRead(operation.source));
}

/** A conservative shell-quote adapter. Unsupported expansion stays unknown rather
 * than being mistaken for an equivalent command. The existing SQL adapter supplies
 * its parser/HMAC identity directly through the same semanticIdentity contract. */
export function fingerprintShellOperation(
  input: { command: string; cwd: string; environment: Record<string, string | number | boolean>; effect: 'read' | 'write' | 'unknown' },
  scope: SqlIntentScope,
): { status: 'supported'; version: string; fingerprint: string } | { status: 'unknown'; version: string; reason: string } {
  const version = 'shell-quote:operation-v1';
  const unknown = (reason: string) => ({ status: 'unknown' as const, version, reason });
  if (!scope?.workspaceId || !scope.sourceBoundary || !scope.epoch
    || !(scope.key instanceof Uint8Array) || scope.key.byteLength < 32) return unknown('invalid-scope');
  if (!input.command.trim() || input.command.length > 64_000 || !input.cwd) return unknown('incomplete-source');
  // shell-quote is not a full bash AST. Do not silently erase substitution,
  // expansion, line boundaries, grouping, here-doc or reserved-word semantics.
  if (/[\r\n`]/.test(input.command) || /\$[({]|[(){}]|<<|\b(?:if|then|fi|for|while|case|do|done|function)\b/.test(input.command)
    || input.command.includes('__RECIPE_ENV_REF__')) return unknown('unsupported-syntax');
  const values = [input.command, input.cwd, ...Object.values(input.environment).map(String)];
  if (Object.keys(input.environment).some(isSensitiveValueKey)
    || values.some(value => redactSensitiveText(value, scope.knownSecrets) !== value)
    || values.some(value => scope.knownSecrets?.some(secret => secret.length > 0 && value.includes(secret)))) {
    return unknown('secret-bearing-source');
  }
  let tokens: ReturnType<typeof parseShellArguments>;
  try { tokens = parseShellArguments(input.command, name => '__RECIPE_ENV_REF__' + name); }
  catch { return unknown('parse-failed'); }
  if (tokens.some(token => typeof token === 'object' && 'op' in token
    && !['|', '||', '&&', ';', '&', '<', '>', '>>', '>&', '<&'].includes(token.op))) return unknown('unsupported-syntax');
  tokens = tokens.filter(token => !(typeof token === 'object' && 'comment' in token));
  if (!tokens.length) return unknown('empty');
  const environment = Object.keys(input.environment).sort().map(name => [name, typeof input.environment[name], input.environment[name]]);
  const fingerprint = createHmac('sha256', scope.key).update(JSON.stringify([
    version, scope.workspaceId, scope.sourceBoundary, scope.epoch, tokens, input.cwd, environment, input.effect,
  ])).digest('hex');
  return { status: 'supported', version, fingerprint };
}

export type SourceShellOperation =
  | { kind: 'git-archive'; repository: string; commit: string; destination: string }
  | { kind: 'hardlink-copy'; source: string; destination: string };

/** A deliberately small shell language for recovering source operations. This
 * does not execute a command, inspect today's filesystem to choose a historical
 * branch, or turn successful execution into proof of the destination bytes.
 * Keep operation-v1's contract unchanged: this is a separate adapter version.
 */
export function sourceShellOperations(command: string):
  | { status: 'supported'; version: string; operations: SourceShellOperation[] }
  | { status: 'unknown'; version: string; reason: string } {
  const version = 'shell-quote:source-operations-v1';
  const unknown = (reason: string) => ({ status: 'unknown' as const, version, reason });
  if (!command.trim() || command.length > 64_000) return unknown('incomplete-source');
  // shell-quote is a tokenizer, not a Bash parser. Reject substitution, globbing,
  // escapes outside quotes, heredocs, grouping and unmodelled control operators.
  if (/[`\r\u0000*?]/.test(command) || /\$[({]|[(){}]|<<|\\|\|\||&&/.test(command))
    return unknown('unsupported-syntax');
  const units: string[] = [];
  let word = ''; let quote = ''; let comment = false;
  for (const char of command) {
    if (comment) { if (char !== '\n') continue; comment = false; }
    if (!quote && char === '#' && (!word || /\s$/.test(word))) { comment = true; continue; }
    if (char === quote) quote = '';
    else if (!quote && (char === '"' || char === "'")) quote = char;
    if (!quote && [';', '\n'].includes(char)) {
      if (char === ';' && ['do', 'then', 'else'].includes(word.trim())) return unknown('invalid-separator');
      if (word.trim()) units.push(word.trim()); word = '';
    }
    else word += char;
  }
  if (quote) return unknown('unclosed-quote');
  if (word.trim()) units.push(word.trim());
  if (units.length > 512) return unknown('statement-bound');
  type Statement = { kind: 'simple'; text: string }
    | { kind: 'for'; name: string; values: string[]; body: Statement[] }
    | { kind: 'if'; condition: string; yes: Statement[]; no: Statement[] };
  const tokenize = (text: string, env: Map<string, string>) => {
    const tokens = parseShellArguments(text, name => {
      const value = env.get(name);
      // Unquoted expansion must have the same single-word result as quoted
      // expansion; unknown, empty or split/glob-bearing bindings are refused.
      if (!value || !/^[A-Za-z0-9_./:@+-]+$/.test(value)) throw new Error('dynamic-binding');
      return value;
    });
    if (tokens.length > 256 || tokens.some(token => typeof token !== 'string')) throw new Error('unsupported-token');
    return tokens as string[];
  };
  let cursor = 0;
  const parse = (stops: string[] = [], depth = 0): Statement[] => {
    if (depth > 8) throw new Error('nesting-bound');
    const body: Statement[] = [];
    while (cursor < units.length && !stops.includes(units[cursor])) {
      const text = units[cursor++];
      const loop = /^for ([A-Za-z_][A-Za-z0-9_]*) in (.+)$/.exec(text);
      if (loop) {
        if (loop[2].includes('$')) throw new Error('nonliteral-loop');
        const values = tokenize(loop[2], new Map());
        if (!values.length || values.length > 32 || units[cursor++] !== 'do') throw new Error('invalid-loop');
        const inner = parse(['done'], depth + 1);
        if (units[cursor++] !== 'done') throw new Error('invalid-loop');
        body.push({ kind: 'for', name: loop[1], values, body: inner });
      } else if (text.startsWith('if ')) {
        if (units[cursor++] !== 'then') throw new Error('invalid-branch');
        const yes = parse(['else', 'fi'], depth + 1);
        const no = units[cursor] === 'else' ? (cursor++, parse(['fi'], depth + 1)) : [];
        if (units[cursor++] !== 'fi') throw new Error('invalid-branch');
        body.push({ kind: 'if', condition: text.slice(3), yes, no });
      } else {
        if (/^(?:for|if|then|else|fi|do|done|while|until|case|function|select)\b/.test(text))
          throw new Error('unsupported-control');
        body.push({ kind: 'simple', text });
      }
    }
    return body;
  };
  type State = { env: Map<string, string>; operations: SourceShellOperation[] };
  const fork = (state: State): State => ({ env: new Map(state.env), operations: [...state.operations] });
  const canonical = (state: State) => JSON.stringify([[...state.env].sort(([a], [b]) => a.localeCompare(b)), state.operations]);
  const path = (value: string) => {
    if (!/^\/(?:[A-Za-z0-9_@+.-]+\/)*[A-Za-z0-9_@+.-]+$/.test(value)
      || value.split('/').some(part => part === '.' || part === '..')) throw new Error('noncanonical-path');
    return value;
  };
  let steps = 0;
  const evaluate = (body: Statement[], state: State): State => {
    for (const statement of body) {
      if (++steps > 1024) throw new Error('evaluation-bound');
      if (statement.kind === 'for') {
        if (state.env.has(statement.name)) throw new Error('shadowed-binding');
        for (const value of statement.values) {
          state.env.set(statement.name, value);
          state = evaluate(statement.body, state);
        }
        // Shell loops leave their final binding in place.
      } else if (statement.kind === 'if') {
        const condition = tokenize(statement.condition, state.env);
        let deciding: boolean | undefined;
        if (condition.length === 5 && condition[0] === '[' && condition[4] === ']'
          && ['=', '!='].includes(condition[2]))
          deciding = (condition[1] === condition[3]) === (condition[2] === '=');
        else if (!(condition.length === 4 && condition[0] === '[' && condition[3] === ']'
          && ['-e', '-d', '-L'].includes(condition[1]))) throw new Error('unsupported-condition');
        if (deciding !== undefined) state = evaluate(deciding ? statement.yes : statement.no, state);
        else {
          const yes = evaluate(statement.yes, fork(state)); const no = evaluate(statement.no, fork(state));
          if (canonical(yes) !== canonical(no)) throw new Error('divergent-branch');
          state = yes;
        }
      } else {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(statement.text);
        if (assignment) {
          if (state.env.has(assignment[1]) || ['PATH', 'IFS', 'ENV', 'BASH_ENV', 'SHELLOPTS', 'GIT_DIR', 'GIT_WORK_TREE'].includes(assignment[1]))
            throw new Error('shadowed-binding');
          const values = tokenize(assignment[2], state.env);
          if (values.length !== 1) throw new Error('invalid-assignment');
          state.env.set(assignment[1], values[0]);
          continue;
        }
        // Only the exact archive pipeline has operator semantics in this dialect.
        const tokens = parseShellArguments(statement.text, name => {
          const value = state.env.get(name);
          if (!value || !/^[A-Za-z0-9_./:@+-]+$/.test(value)) throw new Error('dynamic-binding');
          return value;
        });
        const pipes = tokens.flatMap((token, index) => typeof token === 'object' && 'op' in token && token.op === '|' ? [index] : []);
        if (pipes.length) {
          if (pipes.length !== 1) throw new Error('unsupported-pipeline');
          const left = tokens.slice(0, pipes[0]); const right = tokens.slice(pipes[0] + 1);
          if (left.some(token => typeof token !== 'string') || right.some(token => typeof token !== 'string')) throw new Error('unsupported-token');
          if (left.length !== 6 || left[0] !== 'git' || left[1] !== '-C' || left[3] !== 'archive' || left[4] !== '--format=tar'
            || !/^[0-9a-f]{40}$/.test(left[5] as string) || right.length !== 4 || right[0] !== 'tar' || right[1] !== '-x' || right[2] !== '-C')
            throw new Error('unsupported-archive');
          state.operations.push({ kind: 'git-archive', repository: path(left[2] as string), commit: left[5] as string,
            destination: path(right[3] as string) });
        } else {
          const args = tokenize(statement.text, state.env);
          if (args.length === 4 && args[0] === 'cp' && args[1] === '-al')
            state.operations.push({ kind: 'hardlink-copy', source: path(args[2]), destination: path(args[3]) });
          else if (args.length >= 3 && args[0] === 'mkdir' && args[1] === '-p') args.slice(2).forEach(path);
          else if (JSON.stringify(args) !== JSON.stringify(['set', '-euo', 'pipefail'])) throw new Error('unsupported-command');
        }
        if (state.operations.length > 128) throw new Error('operation-bound');
      }
    }
    return state;
  };
  try {
    const body = parse();
    const operations = evaluate(body, { env: new Map(), operations: [] }).operations;
    return operations.length ? { status: 'supported', version, operations } : unknown('no-source-operation');
  } catch (error) { return unknown(error instanceof Error ? error.message : 'parse-failed'); }
}

/** The adapter's identity is scoped and secret-free like existing shell evidence.
 * A terminal status describes execution only. A receipt must be separately supplied
 * from the archived output; an input hash is never manufactured as receiptRef.
 */
export function sourceShellOperationEvidence(command: string, scope: SqlIntentScope,
  source: OperationAdapterEvidence['source'], outcome: OperationAdapterEvidence['outcome']): OperationAdapterEvidence[] {
  const parsed = sourceShellOperations(command);
  if (parsed.status !== 'supported' || !scope.workspaceId || !scope.sourceBoundary || !scope.epoch
    || !(scope.key instanceof Uint8Array) || scope.key.byteLength < 32
    || redactSensitiveText(command, scope.knownSecrets) !== command
    || scope.knownSecrets?.some(secret => secret.length > 0 && command.includes(secret))) return [];
  return parsed.operations.map((operation, index) => {
    const fingerprint = createHmac('sha256', scope.key).update(JSON.stringify([
      parsed.version, scope.workspaceId, scope.sourceBoundary, scope.epoch, operation,
    ])).digest('hex');
    return { operationId: `${source.ref}:source-operation:${index}`, family: 'shell', adapterVersion: parsed.version,
      semanticIdentity: { version: parsed.version, fingerprint, workspaceId: scope.workspaceId,
        sourceBoundary: scope.sourceBoundary, epoch: scope.epoch }, source: { ...source }, outcome: { ...outcome },
      replayClass: 'non-replayable', decisionRefs: [] };
  });
}

function copyOperationEvidence(operations: readonly OperationAdapterEvidence[]): OperationAdapterEvidence[] {
  const ids = new Set<string>();
  return operations.map(operation => {
    const identity = operation.semanticIdentity;
    const source = operation.source;
    if (!opaqueRef(operation.operationId) || ids.has(operation.operationId) || !FAMILIES.has(operation.family)
      || !opaqueRef(operation.adapterVersion) || !opaqueRef(identity.version) || !/^[a-f0-9]{64}$/.test(identity.fingerprint)
      || ![identity.workspaceId, identity.sourceBoundary, identity.epoch, source.ref, source.authorityRef,
        ...operation.decisionRefs, ...(source.providerCallId ? [source.providerCallId] : []),
        ...(source.parentOperationId ? [source.parentOperationId] : []),
        ...(operation.outcome.receiptRef ? [operation.outcome.receiptRef] : [])].every(opaqueRef)
      || !Number.isFinite(Date.parse(source.observedAt))
      || (source.expiresAt !== null && !Number.isFinite(Date.parse(source.expiresAt)))
      || !['read-only', 'idempotent', 'checkpointed', 'non-replayable'].includes(operation.replayClass)
      || !['success', 'error', 'refused', 'preview', 'running', 'unknown'].includes(operation.outcome.status)
      || typeof operation.outcome.final !== 'boolean'
      || (source.choice !== undefined && !['agent', 'hook', 'system', 'unknown'].includes(source.choice))
      || (operation.outcome.status === 'running' && operation.outcome.final)) throw new Error('invalid_operation_evidence');
    const lifecycle = operation.lifecycle;
    if (lifecycle && (lifecycle.attemptId !== operation.operationId || typeof lifecycle.yielded !== 'boolean'
      || !Array.isArray(lifecycle.polls) || lifecycle.polls.length > 2000
      || lifecycle.polls.some(poll => ![poll.providerCallId, poll.sourceRef,
        ...(poll.receiptRef === undefined ? [] : [poll.receiptRef])].every(opaqueRef)))) throw new Error('invalid_operation_lifecycle');
    ids.add(operation.operationId);
    // Select declared fields only: an adapter's raw input/author privilege cannot
    // hitchhike on an otherwise valid runtime object.
    return {
      operationId: operation.operationId, family: operation.family, adapterVersion: operation.adapterVersion,
      semanticIdentity: { version: identity.version, fingerprint: identity.fingerprint, workspaceId: identity.workspaceId,
        sourceBoundary: identity.sourceBoundary, epoch: identity.epoch },
      source: { ref: source.ref, authorityRef: source.authorityRef, observedAt: source.observedAt, expiresAt: source.expiresAt,
        ...(source.providerCallId ? { providerCallId: source.providerCallId } : {}),
        ...(source.parentOperationId ? { parentOperationId: source.parentOperationId } : {}),
        ...(source.choice ? { choice: source.choice } : {}) },
      outcome: { status: operation.outcome.status, final: operation.outcome.final,
        ...(operation.outcome.receiptRef ? { receiptRef: operation.outcome.receiptRef } : {}) },
      ...(lifecycle ? { lifecycle: { attemptId: lifecycle.attemptId, yielded: lifecycle.yielded,
        polls: lifecycle.polls.map(poll => ({ providerCallId: poll.providerCallId, sourceRef: poll.sourceRef,
          ...(poll.receiptRef ? { receiptRef: poll.receiptRef } : {}) })) } } : {}),
      replayClass: operation.replayClass,
      ...(operation.bindingSchema ? { bindingSchema: recipeBindingSchemaV1Schema.parse(operation.bindingSchema) } : {}),
      decisionRefs: [...operation.decisionRefs],
    };
  });
}

function copyDependencies(dependencies: readonly OperationDependency[], operations: readonly OperationAdapterEvidence[]): OperationDependency[] {
  const seen = new Map<string, string[]>();
  const ids = new Set(operations.map(operation => operation.operationId));
  const reaches = (from: string, to: string): boolean => from === to || (seen.get(from) ?? []).some(next => reaches(next, to));
  return dependencies.map(edge => {
    if (!ids.has(edge.fromOperationId) || !ids.has(edge.toOperationId) || !opaqueRef(edge.evidenceRef)
      || !['data', 'control'].includes(edge.kind) || reaches(edge.toOperationId, edge.fromOperationId)) throw new Error('invalid_operation_dependency');
    seen.set(edge.fromOperationId, [...(seen.get(edge.fromOperationId) ?? []), edge.toOperationId]);
    return { fromOperationId: edge.fromOperationId, toOperationId: edge.toOperationId, kind: edge.kind, evidenceRef: edge.evidenceRef };
  });
}

export type OrchestrationTraceBackend = 'server' | 'client-compat';
export type StableBindingKind = 'workspace' | 'fleet' | 'plan' | 'harness' | 'item' | 'resource';
export type EphemeralValueKind =
  | 'owner-id'
  | 'session-id'
  | 'pty-session-id'
  | 'process-id'
  | 'cursor'
  | 'temp-path'
  | 'local-path';
export type TraceReplayability = 'deterministic' | 'environment-bound' | 'client-bound' | 'session-bound' | 'mixed';

export interface OrchestrationStableBinding {
  parameter: string;
  kind: StableBindingKind;
  /** Stable entity value needed by a later binding/replay phase. Never included in the fingerprint. */
  value: string;
}

export interface OrchestrationEphemeralValue {
  path: string;
  kind: EphemeralValueKind;
}

export interface OrchestrationStaticCall {
  id: string;
  tool: string;
  dynamicArgs: boolean;
  /** Canonical JSON-safe shape. It contains parameter/ephemeral/redaction markers, never raw free-form strings. */
  args: unknown;
  capabilities: string[];
}

export interface OrchestrationRuntimeCall {
  ordinal: number;
  tool: string;
  effect: 'read' | 'write' | 'unknown';
  disposition: OrchestrationCallRecord['disposition'];
  /** Actual host dispatch identity; absent when the bounded receipt window omitted it. */
  dispatchCallId?: string;
  capabilities: string[];
  outputReferences: OrchestrationOutputReference[];
}

export interface NormalizedExecutionTrace {
  schemaVersion: typeof ORCHESTRATION_TRACE_SCHEMA_VERSION | typeof OPERATION_TRACE_SCHEMA_VERSION;
  backend: OrchestrationTraceBackend;
  requirements: {
    tools: string[];
    capabilities: string[];
    premises: ['host:same'];
  };
  toolGraph: {
    /** Source order. This is intentionally not mislabeled as a dependency edge. */
    staticCalls: OrchestrationStaticCall[];
    /** Actual dispatch order. Parallel settlement order is not inferred as a dependency edge. */
    runtimeCalls: OrchestrationRuntimeCall[];
  };
  stableBindings: OrchestrationStableBinding[];
  ephemeralValues: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
  portability: {
    host: 'same';
    replayability: TraceReplayability;
    ephemeralKinds: EphemeralValueKind[];
  };
  structuralFingerprint: string;
  /** Absent on schema 1 traces; legacy families/history stay readable. */
  operations?: OperationAdapterEvidence[];
  dependencies?: OperationDependency[];
}

export interface NormalizeExecutionTraceInput {
  script: string;
  backend?: OrchestrationTraceBackend;
  tools: readonly ProjectedTool[];
  allowed?: ReadonlySet<string>;
  callRecords?: readonly OrchestrationCallRecord[];
  /** Host-produced receipts only; these cannot create execution records on their own. */
  dispatchTimings?: {
    calls: readonly (Pick<OrchestrationCallRecord, 'ordinal' | 'tool' | 'effect' | 'disposition'> & { callId?: string })[];
  };
  operations?: readonly OperationAdapterEvidence[];
  dependencies?: readonly OperationDependency[];
}

type BindingRefsKey = keyof RecipeAuthorityRefs;
type JsonMarker = Record<string, string | boolean>;

const BINDING_DIMENSIONS: ReadonlyArray<{
  kind: StableBindingKind;
  refsKey: BindingRefsKey;
}> = [
  { kind: 'workspace', refsKey: 'workspaces' },
  { kind: 'fleet', refsKey: 'fleets' },
  { kind: 'plan', refsKey: 'plans' },
  { kind: 'harness', refsKey: 'harnesses' },
  { kind: 'item', refsKey: 'items' },
  { kind: 'resource', refsKey: 'resources' },
];

const SECRET_KEYS = new Set([
  'apikey',
  'accesskey',
  'secretkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'privatekey',
  'passphrase',
  'clientsecret',
]);
const OWNER_ID = /^su-(?:[0-9a-f]{4,64}|[0-9a-f-]{36})$/i;
const TEMP_PATH_ROOT = /^(?:\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/run\/|\/dev\/shm\/)/i;
const ABSOLUTE_LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function secretKey(key: string | null): boolean {
  if (!key) return false;
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || normalized.endsWith('apikey') || normalized.endsWith('secret');
}

function ephemeralKind(key: string | null, value: unknown): EphemeralValueKind | null {
  const normalized = key ? normalizeKey(key) : '';
  if (typeof value === 'string') {
    if (OWNER_ID.test(value)) return 'owner-id';
    if (TEMP_PATH_ROOT.test(value)) return 'temp-path';
    if (ABSOLUTE_LOCAL_PATH.test(value) && !value.includes('://')) return 'local-path';
  }
  if (normalized.includes('pty') || normalized === 'bashid') return 'pty-session-id';
  if (normalized === 'session' || normalized.endsWith('sessionid') || normalized === 'sid') return 'session-id';
  if (
    normalized === 'pid' ||
    normalized.endsWith('processid') ||
    normalized === 'jobid' ||
    normalized === 'taskid'
  ) {
    return 'process-id';
  }
  if (normalized.includes('cursor')) return 'cursor';
  if (
    typeof value === 'string' &&
    (normalized === 'cwd' || normalized === 'workdir' || normalized.endsWith('filepath') || normalized === 'path') &&
    !value.includes('://')
  ) {
    return TEMP_PATH_ROOT.test(value) ? 'temp-path' : 'local-path';
  }
  return null;
}

function capabilitiesByTool(tools: readonly ProjectedTool[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    out.set(name, [...new Set(tool.capabilities)].sort());
  }
  return out;
}

interface ValueNormalizerState {
  refsByValue: Map<string, StableBindingKind[]>;
  bindingByIdentity: Map<string, OrchestrationStableBinding>;
  bindingCounters: Map<StableBindingKind, number>;
  ephemeral: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
}

function createValueNormalizerState(refs: RecipeAuthorityRefs): ValueNormalizerState {
  const refsByValue = new Map<string, StableBindingKind[]>();
  for (const dimension of BINDING_DIMENSIONS) {
    for (const value of refs[dimension.refsKey]) {
      const kinds = refsByValue.get(value) ?? [];
      kinds.push(dimension.kind);
      refsByValue.set(value, kinds);
    }
  }
  return {
    refsByValue,
    bindingByIdentity: new Map(),
    bindingCounters: new Map(),
    ephemeral: [],
    redactedSecretPaths: [],
  };
}

function stableBindingMarker(value: string, state: ValueNormalizerState): JsonMarker | null {
  const kind = state.refsByValue.get(value)?.[0];
  if (!kind) return null;
  const identity = `${kind}\u0000${value}`;
  let binding = state.bindingByIdentity.get(identity);
  if (!binding) {
    const ordinal = (state.bindingCounters.get(kind) ?? 0) + 1;
    state.bindingCounters.set(kind, ordinal);
    binding = { parameter: `${kind}:${ordinal}`, kind, value };
    state.bindingByIdentity.set(identity, binding);
  }
  return { $binding: binding.parameter };
}

function normalizeValue(
  value: unknown,
  state: ValueNormalizerState,
  path: string,
  key: string | null = null,
): unknown {
  if (secretKey(key)) {
    state.redactedSecretPaths.push(path);
    return { $redacted: 'secret' };
  }

  const ephemeral = ephemeralKind(key, value);
  if (ephemeral) {
    state.ephemeral.push({ path, kind: ephemeral });
    return { $ephemeral: ephemeral };
  }

  if (typeof value === 'string') {
    const binding = stableBindingMarker(value, state);
    return binding ?? { $literal: 'string' };
  }
  if (typeof value === 'number') return { $literal: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeValue(entry, state, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = normalizeValue(value[childKey], state, `${path}.${childKey}`, childKey);
    }
    return out;
  }
  return { $dynamic: true };
}

function replayabilityFor(
  backend: OrchestrationTraceBackend,
  ephemeralKinds: readonly EphemeralValueKind[],
): TraceReplayability {
  const sessionBound = ephemeralKinds.some((kind) =>
    ['owner-id', 'session-id', 'pty-session-id', 'process-id', 'cursor'].includes(kind),
  );
  const environmentBound = ephemeralKinds.some((kind) => kind === 'temp-path' || kind === 'local-path');
  if ((sessionBound && environmentBound) || (backend === 'client-compat' && (sessionBound || environmentBound))) {
    return 'mixed';
  }
  if (sessionBound) return 'session-bound';
  if (environmentBound) return 'environment-bound';
  if (backend === 'client-compat') return 'client-bound';
  return 'deterministic';
}

function copyOutputReference(reference: OrchestrationOutputReference): OrchestrationOutputReference {
  return {
    uri: reference.uri,
    byteCount: reference.byteCount,
    sha256: reference.sha256,
    ...(reference.expiresAt ? { expiresAt: reference.expiresAt } : {}),
    ...(reference.audience ? { audience: reference.audience } : {}),
  };
}

/** Build the canonical trace and its backend/outcome-independent structural fingerprint. */
export async function normalizeExecutionTrace(
  input: NormalizeExecutionTraceInput,
): Promise<NormalizedExecutionTrace> {
  await ensureParseCheckReady();
  const backend = input.backend ?? 'server';
  const [analysis, authority] = await Promise.all([
    Promise.resolve(checkScript(input.script, input.tools, input.allowed)),
    deriveRecipeAuthority(input.script),
  ]);
  const capabilityMap = capabilitiesByTool(input.tools);
  const state = createValueNormalizerState(authority.refs);

  const staticCalls: OrchestrationStaticCall[] = analysis.calls.map((call, ordinal) => ({
    id: `static:${ordinal}`,
    tool: call.tool,
    dynamicArgs: call.dynamicArgs,
    args: normalizeValue(call.args, state, `staticCalls[${ordinal}].args`),
    capabilities: capabilityMap.get(call.tool) ?? [],
  }));
  // Ordinals identify dispatches within THIS execution. Repeated receipt copies
  // are not retries; a retry has a new ordinal. Refuse conflicting copies rather
  // than choosing whichever outcome happened to arrive first.
  const runtimeByOrdinal = new Map<number, OrchestrationRuntimeCall>();
  for (const call of input.callRecords ?? []) {
    if (!Number.isSafeInteger(call.ordinal) || call.ordinal < 0) throw new Error('invalid_orchestration_call_ordinal');
    const normalized: OrchestrationRuntimeCall = {
      ordinal: call.ordinal, tool: call.tool, effect: call.effect, disposition: call.disposition,
      capabilities: capabilityMap.get(call.tool) ?? [],
      outputReferences: call.outputReferences.map(copyOutputReference),
    };
    const previous = runtimeByOrdinal.get(call.ordinal);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new Error('conflicting_orchestration_call_copies');
    runtimeByOrdinal.set(call.ordinal, normalized);
  }
  const ordinalByDispatchId = new Map<string, number>();
  for (const receipt of input.dispatchTimings?.calls ?? []) {
    const call = runtimeByOrdinal.get(receipt.ordinal);
    if (!call) continue;
    if (call.tool !== receipt.tool || call.effect !== receipt.effect || call.disposition !== receipt.disposition) {
      throw new Error('conflicting_orchestration_dispatch_receipt');
    }
    if (receipt.callId === undefined) continue;
    if (!opaqueRef(receipt.callId)) throw new Error('invalid_orchestration_dispatch_call_id');
    const previousOrdinal = ordinalByDispatchId.get(receipt.callId);
    if ((call.dispatchCallId !== undefined && call.dispatchCallId !== receipt.callId)
      || (previousOrdinal !== undefined && previousOrdinal !== call.ordinal)) {
      throw new Error('conflicting_orchestration_dispatch_call_id');
    }
    call.dispatchCallId = receipt.callId;
    ordinalByDispatchId.set(receipt.callId, call.ordinal);
  }
  const runtimeCalls: OrchestrationRuntimeCall[] = [...runtimeByOrdinal.values()]
    .sort((a, b) => a.ordinal - b.ordinal);

  const toolNames = [...new Set([...staticCalls.map((call) => call.tool), ...runtimeCalls.map((call) => call.tool)])].sort();
  const capabilities = [
    ...new Set([...staticCalls, ...runtimeCalls].flatMap((call) => call.capabilities)),
  ].sort();
  const ephemeralValues = state.ephemeral
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path && candidate.kind === entry.kind) === index)
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const ephemeralKinds = [...new Set(ephemeralValues.map((entry) => entry.kind))].sort() as EphemeralValueKind[];
  const stableBindings = [...state.bindingByIdentity.values()].sort((a, b) => a.parameter.localeCompare(b.parameter));
  const redactedSecretPaths = [...new Set(state.redactedSecretPaths)].sort();
  const operations = copyOperationEvidence(input.operations ?? []);
  const dependencies = copyDependencies(input.dependencies ?? [], operations);
  const schemaVersion = operations.length ? OPERATION_TRACE_SCHEMA_VERSION : ORCHESTRATION_TRACE_SCHEMA_VERSION;

  // Deliberately excludes: backend, dispositions, binding VALUES, reference URI/hash/size,
  // and ephemeral values. Runtime-only tools are sorted because parallel dispatch order is
  // evidence, not structure; the full ordered runtimeCalls remain in the trace above.
  const fingerprintShape = {
    schemaVersion,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    staticCalls: staticCalls.map((call) => ({
      tool: call.tool,
      dynamicArgs: call.dynamicArgs,
      args: call.args,
      capabilities: call.capabilities,
    })),
    runtimeOnlyTools: [...new Set(runtimeCalls.map((call) => call.tool).filter((tool) => !staticCalls.some((s) => s.tool === tool)))].sort(),
    ephemeralKinds,
    outputReferenceShape: runtimeCalls
      .filter((call) => call.outputReferences.length > 0)
      .map((call) => ({
        tool: call.tool,
        count: call.outputReferences.length,
        audiences: [...new Set(call.outputReferences.map((reference) => reference.audience ?? 'unspecified'))].sort(),
      }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
    ...(operations.length ? {
      operations: operations.map(operation => ({ family: operation.family, adapterVersion: operation.adapterVersion,
        semanticIdentity: operation.semanticIdentity, replayClass: operation.replayClass, bindingSchema: operation.bindingSchema })),
      // Receipt IDs are provenance; dependency topology is semantic.
      dependencies: dependencies.map(edge => ({ from: operations.findIndex(operation => operation.operationId === edge.fromOperationId),
        to: operations.findIndex(operation => operation.operationId === edge.toOperationId), kind: edge.kind })),
    } : {}),
  };
  const structuralFingerprint = createHash('sha256').update(JSON.stringify(fingerprintShape)).digest('hex');

  return {
    schemaVersion,
    backend,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    toolGraph: { staticCalls, runtimeCalls },
    stableBindings,
    ephemeralValues,
    redactedSecretPaths,
    portability: {
      host: 'same',
      replayability: replayabilityFor(backend, ephemeralKinds),
      ephemeralKinds,
    },
    structuralFingerprint,
    ...(operations.length ? { operations, dependencies } : {}),
  };
}
