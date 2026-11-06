/** Native source fixture identity: native-provider-wire-v1. */
import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { recordActivity } from '@papercusp/activity-bridge';
import { boundedStage } from './pipeline';
import { managedOperationEvidence, observeNativeOperation, groupNativeOperations, readableNativeChains, nativeTranscriptSources, type ManagedOperationSource, type NativeProvider } from './native-operation';
import { normalizeExecutionTrace, readableOperationEvidence } from '../orchestration-trace';
import type { SearchSource } from './search-reformulation';
const scope = { workspaceId: 'native-test', sourceBoundary: 'authorized', epoch: 'v1', key: new Uint8Array(32).fill(91) };
export const source = (id: string, over: Partial<SearchSource> = {}): SearchSource => ({
  workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
  provider: 'codex', namespace: 'session-1', actor: 'su-native', verifiedAgent: true, origin: 'agent',
  at: '2026-10-24T12:00:00Z', copyRef: `transcript:${id}`, tool: 'exec_command', args: { cmd: 'rg -n private ./src | head -5' },
  callId: id, identityAuthority: 'provider', sourceComplete: true,
  result: { provider: 'codex', namespace: 'session-1', callId: id, complete: true, status: 'ok', body: { exit_code: 0 } }, ...over,
});
const observe = (s: SearchSource, scoped = scope) => observeNativeOperation(s, scoped)!;

const managed = (id = '1', over: Partial<ManagedOperationSource> = {}): ManagedOperationSource => ({
  id, workspaceId: scope.workspaceId, harnessSlug: 'native', sourceBoundary: scope.sourceBoundary,
  actor: 'su-managed', verifiedAgent: true, choice: 'agent', at: '2026-10-24T12:00:00Z',
  tool: 'capability:bash', args: { command: 'echo private-value', cwd: '/private/path', env: { TOKEN: 'credential' } }, status: 'ok',
  receipt: { version: 1, callId: `host:${id}`, parentCallId: 'host:parent', handlerEntered: true,
    role: 'operation', disposition: 'ok', outcome: { status: 'success', final: true } }, ...over,
});
const managedReceipt = (over: Record<string, unknown> = {}) => ({ ...managed().receipt as Record<string, unknown>, ...over });

it('P005 managed actual receipts share trace evidence while copies, wrappers, missing receipts and polls add no executions', async () => {
  const row = managed();
  const evidence = managedOperationEvidence([row, { ...row, id: '2' },
    managed('3', { tool: 'functions.exec', args: { script: 'await tools.exec_command({cmd:"hidden"})' } }),
    managed('4', { receipt: null }), managed('5', { tool: 'capability:bash_output', receipt: managedReceipt({ callId: 'host:5', role: 'poll' }) })], scope);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ family: 'shell', source: { choice: 'agent', parentOperationId: expect.any(String) },
    outcome: { status: 'success', final: true }, replayClass: 'non-replayable' });
  expect(JSON.stringify(evidence)).not.toMatch(/private-value|private\/path|credential|host:|su-managed|hidden/);
  const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: [], operations: evidence });
  expect(trace.operations).toEqual(evidence);
  expect(managedOperationEvidence([row, { ...row, id: '2', args: { command: 'another' } }], scope)).toEqual([]);
});

it('P005 managed yielded jobs settle from exact same-actor polls and retain conflicting and absent outcomes', () => {
  const job = { bashId: 'job-exact', taskId: 'task-exact' };
  const start = managed('1', { receipt: managedReceipt({ yielded: true, job, outcome: { status: 'running', final: false } }) });
  const poll = managed('2', { at: '2026-10-24T12:00:01Z', tool: 'capability:bash_output',
    args: { task_id: 'task-exact' }, receipt: managedReceipt({ callId: 'host:poll', role: 'poll', job,
      outcome: { status: 'error', final: true } }) });
  const settled = managedOperationEvidence([start, poll], scope);
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({ outcome: { status: 'error', final: true }, lifecycle: { yielded: true, polls: [expect.any(Object)] } });
  for (const wrong of [{ actor: 'su-foreign' }, { at: '2026-10-24T11:00:00Z' },
    { receipt: { ...poll.receipt as object, job: { bashId: 'other', taskId: 'task-exact' } } }])
    expect(managedOperationEvidence([start, { ...poll, ...wrong }], scope)[0]?.outcome.status).toBe('running');
  const reused = managed('3', { receipt: managedReceipt({ callId: 'host:second', yielded: true, job, outcome: { status: 'running', final: false } }) });
  expect(managedOperationEvidence([start, reused, poll], scope).every(op => op.outcome.status === 'running')).toBe(true);
  const contrary = { ...poll, id: '4', receipt: { ...poll.receipt as object, callId: 'host:contrary', outcome: { status: 'success', final: true } } };
  expect(managedOperationEvidence([start, poll, contrary], scope)[0]?.outcome).toMatchObject({ status: 'unknown', final: false });
});

it('P005 managed adapters retain SQL semantics, shell context, origin and refused dispositions without minting replay', () => {
  expect(managedOperationEvidence([managed('1', { tool: 'code:tools', args: {} })], scope)).toHaveLength(1);
  const sql = managed('1', { tool: 'dev:pg_query', args: { sql: 'SELECT id FROM jobs ORDER BY id LIMIT 2' } });
  const a = managedOperationEvidence([sql], scope)[0]!;
  expect(a.family).toBe('sql');
  expect(managedOperationEvidence([{ ...sql, args: { sql: 'SELECT name FROM jobs ORDER BY id LIMIT 2' } }], scope)[0]?.semanticIdentity.fingerprint)
    .not.toBe(a.semanticIdentity.fingerprint);
  for (const choice of ['agent', 'hook', 'system', 'unknown'] as const)
    expect(managedOperationEvidence([managed('1', { choice })], scope)[0]?.source.choice).toBe(choice);
  expect(managedOperationEvidence([managed('1', { verifiedAgent: false })], scope)).toEqual([]);
  const refused = managed('1', { status: 'role-not-allowed', receipt: managedReceipt({ handlerEntered: false,
    disposition: 'role-not-allowed', outcome: { status: 'refused', final: true } }) });
  expect(managedOperationEvidence([refused], scope)[0]?.outcome.status).toBe('refused');
  expect(managedOperationEvidence([managed('1', { sourceBoundary: 'foreign' })], scope)).toEqual([]);
  expect(managedOperationEvidence([managed('1', { args: { _truncated: true, command: 'echo truncated' } })], scope)).toEqual([]);
});

it.each(['claude', 'codex', 'omp'] as const)('P005 actual %s receipts feed shared operation evidence without executable source or authority', async provider => {
  const call = source('actual-receipt', { provider, args: { cmd: 'echo private-value', cwd: '/private/path',
    env: { TOKEN: 'private-credential', MODE: 'inspect' } } });
  call.result = { ...call.result!, provider };
  const observed = observe(call), operation = observed.operationEvidence!;
  expect(operation).toMatchObject({ operationId: observed.operationToken, family: 'shell',
    semanticIdentity: { fingerprint: observed.fingerprint, workspaceId: scope.workspaceId },
    source: { providerCallId: observed.operationToken }, outcome: { status: 'success', final: true },
    replayClass: 'non-replayable' });
  const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: [], operations: [operation] });
  expect(trace.operations).toEqual([operation]);
  expect(readableOperationEvidence(trace, { workspaceId: scope.workspaceId, now: Date.now(), canRead: () => true })).toEqual([operation]);
  expect(readableOperationEvidence(trace, { workspaceId: scope.workspaceId, now: Date.now(), canRead: () => false })).toEqual([]);
  expect(readableOperationEvidence(trace, { workspaceId: 'other', now: Date.now(), canRead: () => true })).toEqual([]);
  expect(JSON.stringify(observed)).not.toMatch(/private-value|private-credential|private\/path|actual-receipt/);
  expect(observe({ ...call, tool: 'functions.exec' }).operationEvidence).toBeUndefined();
  expect(observe({ ...call, tool: 'write_stdin' }).operationEvidence).toBeUndefined();
  expect(observe({ ...call, sourceComplete: false }).operationEvidence).toBeUndefined();
  expect(observe({ ...call, callId: null }).operationEvidence).toBeUndefined();
  expect(observe({ ...call, result: null }).operationEvidence?.outcome).toEqual({ status: 'unknown', final: false });
  for (const status of ['refused', 'denied', 'role-not-allowed', 'quota-exceeded'])
    expect(observe({ ...call, result: { ...call.result!, status, body: {} } }).operationEvidence?.outcome)
      .toMatchObject({ status: 'refused', final: true });
});

it('P005 shell environment, cwd, interpreter and effect remain semantically distinct after credential scrubbing', () => {
  const baseline = { cmd: 'echo safe', cwd: '/repo', env: { MODE: 'read', TOKEN: 'first-private' },
    shell: '/bin/bash', login: false, tty: false, effect: 'read', sandbox_permissions: 'use_default' };
  const before = observe(source('one', { args: baseline }));
  for (const change of [{ cwd: '/other' }, { env: { MODE: 'write', TOKEN: 'first-private' } },
    { shell: '/bin/sh' }, { login: true }, { tty: true }, { effect: 'write' }, { sandbox_permissions: 'require_escalated' }])
    expect(observe(source('changed', { args: { ...baseline, ...change } })).fingerprint).not.toBe(before.fingerprint);
  expect(observe(source('secret-change', { args: { ...baseline, env: { MODE: 'read', TOKEN: 'second-private' } } })).fingerprint)
    .toBe(before.fingerprint);
  expect(observe(source('aliases', { args: { command: baseline.cmd, workdir: baseline.cwd,
    environment: baseline.env, shell: baseline.shell, login: false, tty: false, effect: 'read', sandbox_permissions: 'use_default' } })).fingerprint)
    .toBe(before.fingerprint);
});

it('native UNKNOWN observations retain exact output availability for current-source revision checks', () => {
  const call = source('unknown-result');
  const available = observe({ ...call, result: { ...call.result!, body: { unrecognized: true } } });
  const missing = observe({ ...call, result: null });
  expect(available.outcome).toBe('UNKNOWN');
  expect(missing.outcome).toBe('UNKNOWN');
  const { resultAvailable: before, operationEvidence: availableEvidence, ...retained } = available;
  const { resultAvailable: after, operationEvidence: missingEvidence, ...lost } = missing;
  expect(before).toBe(true); expect(after).toBe(false);
  expect(availableEvidence?.outcome.receiptRef).toBeTruthy();
  expect(missingEvidence?.outcome.receiptRef).toBeUndefined();
  expect(retained).toEqual(lost);
});

it.each(['claude', 'codex', 'omp'] as const)('R2 native wrapper source remains unmeasured without receipts: %s', provider => {
  const call = source('wrapper', { provider, tool: 'functions.exec',
    args: { code: 'await tools.exec_command({cmd:"rg private"})' } });
  call.result = { ...call.result!, provider, body: { exit_code: 0 } };
  expect(observe(call)).toMatchObject({ kind: null, fingerprint: null, outcome: 'UNKNOWN' });
  expect(observe({ ...call, result: null })).toMatchObject({ outcome: 'UNKNOWN', resultAvailable: false });
  expect(groupNativeOperations([observe(call)]).operations).toEqual([]);
  const direct = source('actual-child', { provider });
  direct.result = { ...direct.result!, provider };
  expect(observe(direct)).toMatchObject({ kind: 'shell', outcome: 'success' });
  const yielded = { ...direct, result: { ...direct.result!, body: { session_id: 42 } } };
  const poll = { ...direct, tool: 'write_stdin', args: { session_id: 42 }, callId: 'poll',
    result: { ...direct.result!, callId: 'poll' } };
  const grouped = groupNativeOperations([observe(yielded), observe(poll)]);
  expect(grouped.operations).toHaveLength(1);
  expect(grouped.operations[0]!.outcome).toBe('UNKNOWN');
});

it('R2 native retries and settled failures survive exact receipt copy reconciliation', () => {
  const success = source('success');
  const failed = source('failed', { result: { ...source('failed').result!, body: { exit_code: 1 } } });
  const refused = source('refused', { result: { ...source('refused').result!, status: 'refused', body: {} } });
  const unknown = source('unknown', { result: null });
  const grouped = groupNativeOperations([success, { ...success, copyRef: 'activity:copy' }, failed, refused, unknown].map(s => observe(s)));
  expect(grouped.copiesCollapsed).toBe(1);
  expect(grouped.operations).toHaveLength(4);
  expect(grouped.chains).toMatchObject([{ logicalDemand: 4, successCount: 1, errorCount: 1, refusedCount: 1, unknownCount: 1 }]);
  expect(observe(source('hook', { origin: 'system' }))).toBeNull();
  expect(observe(source('unknown-owner', { verifiedAgent: false }))).toBeNull();
  const conflict = groupNativeOperations([observe(success), observe({ ...success,
    result: { ...success.result!, body: { exit_code: 1 } } })]);
  expect(conflict.operations).toEqual([]);
  expect(conflict.evidenceGaps).toContain('conflicting-operation-copies');
});

it('R12-CONTRACT', () => {
  const shell = [source('one'), source('two')].map(s => observe(s));
  const browser = [source('click1', { tool: 'browser_click', args: { selector: '#save' } }),
    source('click2', { tool: 'browser_click', args: { selector: '#save' } })].map(s => observe(s));
  expect(groupNativeOperations([...shell, ...browser]).chains.map(c => [c.kind, c.logicalDemand])).toEqual([['shell', 2], ['browser', 2]]);
  for (const args of [{ cmd: 'rg -i private ./src | head -5' }, { cmd: 'rg -n private ./src && head -5' }, { cmd: 'rg -n private ./other | head -5' }])
    expect(observe(source('different', { args })).fingerprint).not.toBe(shell[0]!.fingerprint);
  for (const args of [{ selector: '#cancel' }, { selector: '#save', text: 'different' }])
    expect(observe(source('different', { tool: 'browser_click', args })).fingerprint).not.toBe(browser[0]!.fingerprint);
  expect(observe(source('a', { tool: 'browser', args: { action: 'fill', selector: '#password', text: 'first-secret' } })).fingerprint)
    .toBe(observe(source('b', { tool: 'browser', args: { text: 'second-secret', action: 'fill', selector: '#password' } })).fingerprint);
  expect(observe(source('unsupported', { tool: 'invented-browser' })).evidenceGaps).toContain('unsupported-operation');
  expect(observeNativeOperation(source('system', { origin: 'system' }), scope)).toBeNull();
  expect(observeNativeOperation(source('human', { verifiedAgent: false }), scope)).toBeNull();
});

it('OUTCOME-P-012', async () => {
  // Credentials are removed before JSON escaping and before fingerprinting,
  // including nested browser values and short explicitly known credentials.
  for (const pair of [['first"secret', 'second"secret'], ['first\\secret', 'second\\secret'], ['first\nsecret', 'second\nsecret'], ['x', 'y']]) {
    const scoped = { ...scope, knownSecrets: pair };
    const shell = pair.map(value => observe(source('known', { args: { cmd: `echo ${value}` } }), scoped));
    const browser = pair.map(value => observe(source('known', { tool: 'browser', args: { action: 'evaluate', payload: { nested: [value] } } }), scoped));
    expect(shell[0]!.fingerprint).toBe(shell[1]!.fingerprint);
    expect(browser[0]!.fingerprint).toBe(browser[1]!.fingerprint);
  }
  for (const pair of [
    [{ cmd: 'curl --password tiny --token=first-opaque-value' }, { cmd: 'curl --password other --token=second-opaque-value' }],
    [{ cmd: 'TOKEN=first-opaque-value curl private' }, { cmd: 'TOKEN=second-opaque-value curl private' }],
    [{ cmd: 'echo known-first-secret-value' }, { cmd: 'echo known-second-secret-value' }],
  ]) {
    const scoped = { ...scope, knownSecrets: ['known-first-secret-value', 'known-second-secret-value'] };
    expect(observe(source('a', { args: pair[0] }), scoped).fingerprint).toBe(observe(source('b', { args: pair[1] }), scoped).fingerprint);
  }
  for (const pair of [
    [{ action: 'fill', selector: '#password', text: 'first-secret' }, { action: 'fill', selector: '#password', text: 'second-secret' }],
    [{ action: 'navigate', url: 'https://alice:secret@private.example/?token=tiny' }, { action: 'navigate', url: 'https://bob:other@private.example/?token=other' }],
    [{ action: 'click', selector: '#save', password: 'first-secret' }, { action: 'click', selector: '#save', password: 'second-secret' }],
  ]) {
    const rows = pair.map((args, i) => observe(source(String(i), { tool: 'browser', args })));
    expect(rows[0]!.fingerprint).toBe(rows[1]!.fingerprint);
    const chains = await readableNativeChains(rows, async () => true);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.summary).toBe('Recurring native browser operation');
    expect(JSON.stringify({ rows, chains })).not.toMatch(/first-secret|second-secret|private\.example|alice|bob/);
  }
  const a = observe(source('same'));
  expect(observe(source('same', { authorizationScope: 'other' }), { ...scope, sourceBoundary: 'other' }).fingerprint).not.toBe(a.fingerprint);
  expect(observe(source('same'), { ...scope, epoch: 'v2' }).actorToken).not.toBe(a.actorToken);
});

it('R22-DEDUP', () => {
  const first = observe(source('same')), second = observe(source('second'));
  const copies = groupNativeOperations([first, { ...first, sourceToken: 'activity-copy', at: '2026-10-24T12:00:01Z', outcome: 'UNKNOWN' }, second]);
  expect(copies).toMatchObject({ copiesCollapsed: 1, collisions: 0 });
  expect(copies.chains[0]).toMatchObject({ logicalDemand: 2, successCount: 2 });
  expect(copies.chains[0]!.sourceRefs).toContain('activity-copy');
  expect(groupNativeOperations([first, observe(source('same', { args: { cmd: 'rm private' } })), second])).toMatchObject({ collisions: 1, chains: [] });
  expect(groupNativeOperations([first, { ...first, outcome: 'error' }, second])).toMatchObject({ collisions: 1, chains: [] });
  expect(groupNativeOperations([first, observe(source('same', { namespace: 'other-session' }))]).operations).toHaveLength(2);
  expect(groupNativeOperations([observe(source('missing', { callId: null })), second]).chains).toEqual([]);
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL', () => {
  const positive = source('exact');
  expect(observe(positive).outcome).toBe('success');
  for (const result of [{ ...positive.result!, callId: 'other' }, { ...positive.result!, namespace: 'other' }, { ...positive.result!, provider: 'omp' as const }])
    expect(observe({ ...positive, result }).outcome).toBe('UNKNOWN');
  expect(observe(source('yielded', { result: { ...source('yielded').result!, body: { session_id: 12 } } })).outcome).toBe('UNKNOWN');
  expect(observe(source('bounded', { result: { ...source('bounded').result!, body: { exit_code: 0, truncated: true } } })).outcome).toBe('UNKNOWN');
});

const wire = (provider: NativeProvider, id: string, command = 'rg private') => {
  const timestamp = '2026-10-24T12:00:00Z';
  if (provider === 'codex') return [
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec_command', call_id: id, input: JSON.stringify({ cmd: command }) } },
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: '{"exit_code":0}' }] } },
  ];
  if (provider === 'claude') return [
    { timestamp, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } },
    { timestamp, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '{"exit_code":0}' }] } },
  ];
  return [
    { timestamp, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'shell', id, arguments: { command } }] } },
    { timestamp, type: 'message', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: '{"exit_code":0}' }] } },
  ];
};

function receiptWire(provider: NativeProvider, id: string, tool: string, args: unknown, body: unknown) {
  const timestamp = '2026-10-24T12:00:00Z';
  return (provider === 'codex' ? [
    { timestamp, type: 'response_item', payload: { type: 'function_call', name: tool, call_id: id, arguments: JSON.stringify(args) } },
    { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(body) } },
  ] : provider === 'claude' ? [
    { timestamp, type: 'assistant', message: { content: [{ type: 'tool_use', name: tool, id, input: args }] } },
    { timestamp, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(body) }] } },
  ] : [
    { timestamp, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: tool, id, arguments: args }] } },
    { timestamp, type: 'message', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: JSON.stringify(body) }] } },
  ]).map(record => JSON.stringify(record));
}
const transcriptContext = (provider: NativeProvider) => ({ workspaceId: scope.workspaceId, harnessSlug: 'native',
  authorizationScope: scope.sourceBoundary, actor: 'su-native', verifiedAgent: true, origin: 'agent' as const,
  provider, sessionId: 'session-1', complete: true });

it.each(['claude', 'codex', 'omp'] as const)('P005 %s managed yielded receipts settle one attempt through exact polls', async provider => {
  const start = (id: string, task: string) => receiptWire(provider, id, 'mcp__papercusp_su__capability_bash',
    { command: 'echo private', cwd: '/repo' }, { task_id: task, bash_id: task + '-bash', status: 'running' });
  const poll = (id: string, task: string, body: unknown) => receiptWire(provider, id, 'mcp__papercusp_su__capability_bash_output', { task_id: task }, body);
  const lines = [...start('attempt-one', 'job-one'), ...poll('empty', 'job-one', { status: 'running', output: '' }),
    ...poll('settled-one', 'job-one', { status: 'completed', exit_code: 0 }),
    ...start('attempt-two', 'job-two'), ...poll('settled-two', 'job-two', { status: 'failed', exit_code: 3 })];
  const calls = nativeTranscriptSources(lines, transcriptContext(provider));
  const grouped = groupNativeOperations(calls.map(call => observe(call)));
  expect(grouped.operations).toHaveLength(2);
  expect(grouped.chains).toMatchObject([{ logicalDemand: 2, successCount: 1, errorCount: 1, unknownCount: 0 }]);
  const first = grouped.operations[0]!.operationEvidence!;
  expect(first.lifecycle).toMatchObject({ attemptId: first.operationId, yielded: true, polls: [{}, {}] });
  expect(first.outcome).toMatchObject({ status: 'success', final: true });
  expect(new Set(first.lifecycle!.polls.map(p => p.providerCallId)).size).toBe(2);
  expect(first.source.providerCallId).not.toBe(first.lifecycle!.polls[0]!.providerCallId);
  expect(first.outcome.receiptRef).toBe(first.lifecycle!.polls[1]!.receiptRef);
  expect(grouped.operations[1]!.operationEvidence!.operationId).not.toBe(first.operationId);
  expect(JSON.stringify(grouped)).not.toMatch(/attempt-one|job-one|echo private|\/repo|settled-one/);
  const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: [], operations: grouped.operations.map(o => o.operationEvidence!) });
  expect(trace.operations?.[0]!.lifecycle).toEqual(first.lifecycle);
  expect(groupNativeOperations(nativeTranscriptSources(lines, { ...transcriptContext(provider), complete: false }).map(call => observe(call))).operations).toEqual([]);
});

it('P005 Codex native polls settle only the recorded earlier command, preserving original yield and wrapper exclusions', () => {
  const start = receiptWire('codex', 'command', 'functions.exec_command', { cmd: 'echo safe' }, { session_id: 42 });
  const poll = receiptWire('codex', 'result', 'functions.write_stdin', { session_id: 42, chars: '' }, { exit_code: 0 });
  const wrapper = receiptWire('codex', 'wrapper', 'functions.exec', { code: 'tools.exec_command({cmd:"echo invented"})' }, { session_id: 55 });
  const fakePoll = receiptWire('codex', 'wrapper-poll', 'functions.write_stdin', { session_id: 55 }, { exit_code: 0 });
  const calls = nativeTranscriptSources([...poll, ...start, ...wrapper, ...fakePoll, ...poll], transcriptContext('codex'));
  const command = calls.find(c => c.callId === 'command')!;
  expect(command.result!.body).toEqual({ session_id: 42 });
  expect(command.continuations).toHaveLength(1);
  const grouped = groupNativeOperations(calls.map(call => observe(call)));
  expect(grouped.operations).toHaveLength(1);
  expect(grouped.operations[0]!.operationEvidence).toMatchObject({ outcome: { status: 'success', final: true },
    lifecycle: { yielded: true, polls: [{}] } });
  const onlyEarly = nativeTranscriptSources([...poll, ...start], transcriptContext('codex'));
  expect(observe(onlyEarly.find(c => c.callId === 'command')!).operationEvidence?.outcome).toMatchObject({ status: 'running', final: false });
});

it('P005 conflicting/reused handles, mismatched aliases and unsupported result bodies cannot certify settlement', () => {
  const context = transcriptContext('codex');
  const start = (id: string, handle = 42) => receiptWire('codex', id, 'exec_command', { cmd: 'echo safe' }, { session_id: handle });
  const poll = (id: string, handle: number, body: unknown) => receiptWire('codex', id, 'write_stdin', { session_id: handle }, body);
  for (const lines of [
    [...start('one'), ...start('two'), ...poll('result', 42, { exit_code: 0 })],
    [...start('one'), ...poll('result', 43, { exit_code: 0 })],
    [...start('one'), ...poll('result', 42, { output: 'exit_code:0' })],
    [...start('one'), ...poll('result', 42, { exit_code: 0, truncated: true })],
    [...start('one'), ...poll('one-result', 42, { exit_code: 0 }), ...poll('two-result', 42, { exit_code: 1 })],
    [...receiptWire('codex', 'one', 'capability:bash', { command: 'echo safe' }, { task_id: 'task-one', bash_id: 'bash-one', status: 'running' }),
      ...receiptWire('codex', 'result', 'capability:bash_output', { task_id: 'task-one', bash_id: 'other' }, { exit_code: 0 })],
  ]) {
    const operations = groupNativeOperations(nativeTranscriptSources(lines, context).map(call => observe(call))).operations;
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(o => o.outcome === 'UNKNOWN' && o.operationEvidence?.outcome.final === false)).toBe(true);
  }
  const structured = source('structured', { tool: 'capability:bash', result: { ...source('structured').result!, body: {
    content: [{ type: 'text', text: 'exit 3 (human preview)' }], structuredContent: { exit_code: 3, status: 'failed' },
  } } });
  expect(observe(structured).operationEvidence?.outcome).toMatchObject({ status: 'error', final: true });
});

it('R26-PROVIDERS', () => {
  for (const provider of ['codex', 'claude', 'omp'] as const) {
    const context = { workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
      actor: 'su-native', verifiedAgent: true, origin: 'agent' as const, provider, sessionId: 'session-1', complete: true };
    const lines = [...wire(provider, 'one'), ...wire(provider, 'two')].map(v => JSON.stringify(v));
    const sources = nativeTranscriptSources(lines, context);
    expect(groupNativeOperations(sources.map(s => observe(s))).chains[0]).toMatchObject({ kind: 'shell', logicalDemand: 2, successCount: 2 });
    expect(nativeTranscriptSources([], context)).toEqual([]);
    expect(nativeTranscriptSources(lines, { ...context, complete: false }).map(s => observe(s)).every(s => s.fingerprint === null && s.outcome === 'UNKNOWN')).toBe(true);
  }
});

it.each(['claude', 'codex', 'omp'] as const)('recognizes replacement MCP shell calls in the %s provider transcript', provider => {
  const context = { workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
    actor: 'su-native', verifiedAgent: true, origin: 'agent' as const, provider, sessionId: 'session-1', complete: true };
  const lines = ['one', 'two'].flatMap(id => {
    const records: unknown[] = wire(provider, id);
    if (provider === 'codex') {
      records[0] = { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
        type: 'function_call', namespace: 'functions', name: 'mcp__papercusp_su__capability_bash',
        call_id: id, arguments: JSON.stringify({ command: 'rg private' }),
      } };
      records[1] = { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: id, output: '{"exit_code":0}',
      } };
    } else if (provider === 'claude') {
      const block = (records[0] as { message: { content: { name: string }[] } }).message.content[0]!;
      block.name = 'mcp__papercusp-su__capability_bash';
    } else {
      const block = (records[0] as { message: { content: { name: string }[] } }).message.content[0]!;
      block.name = 'mcp__papercusp_su__capability_bash';
    }
    return records.map(record => JSON.stringify(record));
  });
  const calls = nativeTranscriptSources(lines, context);
  expect(calls).toHaveLength(2);
  expect(groupNativeOperations(calls.map(call => observe(call))).chains).toMatchObject([
    { kind: 'shell', logicalDemand: 2, successCount: 2 },
  ]);
  expect(nativeTranscriptSources(lines, { ...context, complete: false }).map(call => observe(call)))
    .toEqual([expect.objectContaining({ fingerprint: null, outcome: 'UNKNOWN' }),
      expect.objectContaining({ fingerprint: null, outcome: 'UNKNOWN' })]);
});

it('keeps replacement names distinct from foreign servers, wrapper fanout and missing results', () => {
  const original = source('replacement', { tool: 'capability:bash', args: { command: 'rg private' } });
  const expected = observe(original);
  for (const tool of ['capability_bash', 'capability.bash', 'mcp__papercusp__capability_bash',
    'mcp__papercusp-su__capability_bash', 'functions.mcp__papercusp_su__capability_bash']) {
    const call = { ...original, tool };
    expect(observe(call)).toMatchObject({ kind: 'shell', fingerprint: expected.fingerprint, outcome: 'success' });
    expect(observe({ ...call, result: null }).outcome).toBe('UNKNOWN');
    expect(observe({ ...call, result: { ...call.result!, callId: 'other' } }).outcome).toBe('UNKNOWN');
    expect(observe({ ...call, args: { command: 'rg private --hidden' } }).fingerprint).not.toBe(expected.fingerprint);
  }
  for (const tool of ['mcp__foreign__capability_bash', 'functions.mcp__foreign__capability_bash',
    'mcp__papercusp-foreign__capability_bash', 'tools:invoke', 'functions.exec', 'capability:read']) {
    expect(observe({ ...original, tool })).toMatchObject({ kind: null, fingerprint: null, outcome: 'UNKNOWN' });
  }
  expect(observe({ ...original, tool: 'mcp__papercusp_su__capability_terminal',
    result: { ...original.result!, body: { opened: 1 } } })).toMatchObject({ kind: 'shell', outcome: 'UNKNOWN' });
});

it('R15-CURRENT-ACL R23-DERIVED-ACL', async () => {
  const rows = [source('one'), source('two')].map(s => observe(s));
  let allowed = true;
  const authorize = vi.fn(async () => allowed);
  expect(await readableNativeChains(rows, authorize)).toHaveLength(1);
  allowed = false;
  expect(await readableNativeChains(rows, authorize)).toEqual([]);
  expect(await readableNativeChains(rows, async id => id !== rows[1]!.sourceToken)).toEqual([]);
  expect(await readableNativeChains(rows, async () => { throw new Error('deleted'); })).toEqual([]);
  allowed = true;
  expect(await readableNativeChains(rows, authorize)).toHaveLength(1);
});

it('R25-PASSIVE', () => {
  const path = `/tmp/native-unit-sentinel-${process.pid}-${Date.now()}`;
  const command = `touch ${path}`;
  const rows = [source('one', { args: { cmd: command } }), source('two', { tool: 'browser', args: { action: 'evaluate', script: 'globalThis.__nativeSentinel = true' } })];
  rows.forEach(s => observe(s));
  expect(existsSync(path)).toBe(false);
  expect((globalThis as { __nativeSentinel?: boolean }).__nativeSentinel).toBeUndefined();
});

it('R20-ISOLATION', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mining = boundedStage(async () => { await held; throw new Error('mining failed'); }, 1000).catch(() => null);
  const append = vi.fn(async () => ({ id: 'canonical-record' }));
  const receipt = await recordActivity({ append }, { owner: 'su-native', agent: 'codex', toolName: 'exec_command', toolInput: { cmd: 'echo safe' } });
  expect(receipt.id).toBe('canonical-record'); expect(append).toHaveBeenCalledOnce();
  release(); await mining;
  expect((await recordActivity({ append }, { owner: 'su-native', toolName: 'exec_command', toolInput: { cmd: 'echo safe' } })).id).toBe('canonical-record');
});
