import { describe, expect, it } from 'vitest';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionDescriptor,
  type SuSessionEvent,
  type SuSessionIdentity,
} from '@papercusp/chat-protocol';
import { confirmedProviderRateLimit, nativeAcceptanceFailure, nativePendingImports, throwIfProviderRateLimited, throwIfProviderRefused } from './su-session-attached-live-rate-limit';
import { pollUntil } from './pui-e2e/poll-until';

const session: SuSessionIdentity<'claude'> = {
  agentChatId: 'fixture-chat',
  advSessionId: 1,
  backend: 'claude',
  nativeSessionId: 'fixture-native',
  ownerId: 'fixture-owner',
  workspaceId: 'fixture-ws',
  harnessSlug: null,
};

describe('native pending import diagnostics', () => {
  const node = (evaluated = false) => ({ evaluated, promise: Promise.resolve(),
    imports: new Set(['dependency.ts']), importers: new Set(['parent.ts']) });

  it('preserves unavailable and malformed worker evidence instead of reporting zero pending imports', () => {
    expect(nativePendingImports(undefined)).toMatchObject({ workerState: 'unavailable',
      resolving: { state: 'unavailable', count: null }, evaluating: { state: 'unavailable', pendingCount: null } });
    expect(nativePendingImports(null).workerState).toBe('invalid');
    expect(nativePendingImports({ resolvingModules: [], evaluatedModules: { idToModuleMap: {} } }))
      .toMatchObject({ resolving: { state: 'invalid', count: null }, evaluating: { state: 'invalid', pendingCount: null } });
    expect(nativePendingImports({ resolvingModules: new Set([null]),
      evaluatedModules: { idToModuleMap: new Map([['broken.ts', null]]) } }))
      .toMatchObject({ resolving: { state: 'invalid', invalidIds: 1 },
        evaluating: { state: 'invalid', invalidNodes: 1, pendingCount: null } });
  });

  it('names resolving and evaluating modules with both import edges, excluding completed modules', () => {
    const result = nativePendingImports({ resolvingModules: new Set(['resolving.ts']), evaluatedModules: {
      idToModuleMap: new Map([['pending.ts', node()], ['completed.ts', node(true)],
        ['idle.ts', { ...node(), promise: undefined }]]),
    } });
    expect(result).toMatchObject({ resolving: { state: 'available', ids: ['resolving.ts'] },
      evaluating: { state: 'available', total: 3, scanned: 3, scanComplete: true, pendingCount: 1,
        pending: [{ id: 'pending.ts', imports: { ids: ['dependency.ts'] }, importers: { ids: ['parent.ts'] } }] } });
    expect(nativePendingImports({ resolvingModules: new Set(), evaluatedModules: { idToModuleMap: new Map() } }))
      .toMatchObject({ resolving: { count: 0 }, evaluating: { pendingCount: 0, scanComplete: true } });
  });

  it('bounds emitted IDs and edges, marks truncation, and redacts credentials', () => {
    const longId = 'x'.repeat(500);
    const entries = Array.from({ length: 20 }, (_, i) => [`pending-${i}`, { ...node(),
      imports: new Set(Array.from({ length: 10 }, (_, j) => `edge-${j}`)), importers: new Set([longId]) }] as const);
    const result = nativePendingImports({ resolvingModules: new Set([longId, 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456']),
      evaluatedModules: { idToModuleMap: new Map(entries) } });
    expect(result.resolving.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.resolving.ids[0]).toHaveLength(256);
    expect(result.evaluating).toMatchObject({ pendingCount: 20, truncated: true });
    expect(result.evaluating.pending).toHaveLength(12);
    expect(result.evaluating.pending[0].imports).toMatchObject({ count: 10, truncated: true });
    expect(result.evaluating.pending[0].imports.ids).toHaveLength(4);
    expect(result.evaluating.pending[0].importers.truncated).toBe(true);
  });

  it('bounds the scan and leaves the full pending count unknown when the graph exceeds it', () => {
    const graph = new Map(Array.from({ length: 10_001 }, (_, i) => [`module-${i}`, node()]));
    expect(nativePendingImports({ evaluatedModules: { idToModuleMap: graph } }).evaluating)
      .toMatchObject({ total: 10_001, scanned: 10_000, pendingSeen: 10_000,
        pendingCount: null, scanComplete: false, truncated: true });
  });

  it('ranks completed import wall and self times separately without summing nested durations', () => {
    const result = nativePendingImports({ moduleExecutionInfo: new Map([
      ['catalogue.ts', { duration: 140_000, selfTime: 5, importer: 'fixture.ts' }],
      ['leaf.ts', { duration: 30_000, selfTime: 29_000, importer: 'catalogue.ts' }],
    ]) }).completed;
    expect(result).toMatchObject({ state: 'available', total: 2, scanned: 2, scanComplete: true,
      durationBasis: 'inclusive-evaluator-wall-ms', selfBasis: 'duration-minus-child-imports-ms' });
    expect(result.slowestByDuration.map(row => row.id)).toEqual(['catalogue.ts', 'leaf.ts']);
    expect(result.slowestBySelf.map(row => row.id)).toEqual(['leaf.ts', 'catalogue.ts']);
    expect(result.slowestByDuration[0]).toMatchObject({ durationMs: 140_000, selfMs: 5, importer: 'fixture.ts' });
  });

  it('preserves unknown or malformed timing metadata and bounds its output', () => {
    expect(nativePendingImports(undefined).completed).toMatchObject({ state: 'unavailable', total: null });
    expect(nativePendingImports({ moduleExecutionInfo: [] }).completed).toMatchObject({ state: 'invalid', total: null });
    expect(nativePendingImports({ moduleExecutionInfo: new Map([['bad.ts', { duration: NaN, selfTime: 0 }]]) }).completed)
      .toMatchObject({ state: 'invalid', invalidTimings: 1 });
    const result = nativePendingImports({ moduleExecutionInfo: new Map(Array.from({ length: 20 }, (_, i) =>
      [`module-${i}`, { duration: i, selfTime: i, importer: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' }])) }).completed;
    expect(result).toMatchObject({ total: 20, truncated: true });
    expect(result.slowestByDuration).toHaveLength(12);
    expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});

describe('R8 native failure evidence', () => {
  it('retains the requested route and structured refusal while served account remains unknown', () => {
    const error = new Error('codex_turn_failed: 429 Too Many Requests');
    const receipt = nativeAcceptanceFailure({ backend: 'codex', model: 'gpt-5.5', account: 'auto',
      stage: 'owner-turn', events: [{ type: 'error', code: 'codex_turn_failed', message: error.message } as SuSessionEvent], error });
    expect(receipt).toMatchObject({ backend: 'codex', model: 'gpt-5.5', accountRequested: 'auto',
      accountServed: null, ownerId: null, runtimeGeneration: null, stage: 'owner-turn', accepted: false,
      errors: [{ code: 'codex_turn_failed', message: error.message }] });
  });

  it('uses the measured descriptor account and redacts credentials in failure output', () => {
    const descriptor = { accountServed: 'codex-served', runtimeGeneration: 4, lifecycle: 'failed',
      identity: { ownerId: 'fixture-owner', nativeSessionId: 'fixture-native' } } as SuSessionDescriptor;
    const message = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456';
    const receipt = nativeAcceptanceFailure({ backend: 'codex', model: 'gpt-5.5', account: 'codex-requested',
      stage: 'owner-turn', descriptor, events: [{ type: 'error', code: 'refused', message } as SuSessionEvent], error: new Error(message) });
    expect(receipt).toMatchObject({ accountRequested: 'codex-requested', accountServed: 'codex-served',
      ownerId: 'fixture-owner', nativeSessionId: 'fixture-native', runtimeGeneration: 4, lifecycle: 'failed' });
    expect(JSON.stringify(receipt)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});

let sequence = 0;

function base() {
  sequence += 1;
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    session,
    eventId: `evt-${sequence}`,
    sequence,
    at: new Date().toISOString(),
  };
}

function errorEvent(message: string): SuSessionEvent {
  return {
    ...base(),
    type: 'error',
    scope: 'turn',
    code: 'claude_runtime_error',
    message,
    recoverable: true,
  } as SuSessionEvent;
}

function transcript(role: 'system' | 'assistant', content: string): SuSessionEvent {
  return {
    ...base(),
    type: 'transcript',
    phase: 'delta',
    turnId: 'turn-1',
    role,
    channel: 'text',
    content,
  } as SuSessionEvent;
}

describe('attached live provider-limit classifier', () => {
  it('does not classify missing evidence as a provider limit', () => {
    expect(confirmedProviderRateLimit([]).confirmed).toBe(false);
  });

  it('confirms a structured 429', () => {
    expect(confirmedProviderRateLimit([errorEvent('API Error: 429')]).confirmed).toBe(true);
  });

  it('confirms an explicit weekly usage wall', () => {
    expect(confirmedProviderRateLimit([errorEvent("You've hit your weekly limit")]).confirmed).toBe(true);
  });

  it('confirms structured rate-limit prose', () => {
    expect(confirmedProviderRateLimit([errorEvent('temporarily limiting requests')]).confirmed).toBe(true);
  });

  it('does not confirm an unrelated structured error', () => {
    expect(confirmedProviderRateLimit([errorEvent('invalid model configuration')]).confirmed).toBe(false);
  });

  it('requires repeated system transcript mentions without a structured error', () => {
    expect(confirmedProviderRateLimit([transcript('system', 'upstream 429, retrying')]).confirmed).toBe(false);
    expect(confirmedProviderRateLimit([
      transcript('system', 'upstream 429, retrying'),
      transcript('system', 'still rate limited, retrying'),
    ]).confirmed).toBe(true);
  });

  it('does not count assistant explanations as provider evidence', () => {
    expect(confirmedProviderRateLimit([
      transcript('assistant', 'A 429 is a rate limit response.'),
      transcript('assistant', 'If we hit a rate limit again I will back off.'),
    ]).confirmed).toBe(false);
  });
});

describe('live acceptance provider-capacity guard', () => {
  it('disqualifies generic readiness even when the screen predicate would succeed', async () => {
    let checks = 0;
    await expect(pollUntil(() => { checks += 1; return true; }, {
      timeoutMs: 120_000,
      beforeCheck: () => throwIfProviderRateLimited([errorEvent('API Error: 429')], 'Waiting for send readiness'),
    })).rejects.toThrow('Waiting for send readiness cannot run: confirmed provider rate limit');
    expect(checks).toBe(0);
  });

  it('stops a question wait on refusal arriving after the first observation', async () => {
    const events: SuSessionEvent[] = [];
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      events.push(errorEvent('429 request would exceed your rate limit'));
      return false;
    }, {
      timeoutMs: 120_000, intervalMs: 1,
      beforeCheck: () => throwIfProviderRateLimited(events, 'Waiting for question'),
    })).rejects.toThrow('Waiting for question cannot run: confirmed provider rate limit');
    expect(checks).toBe(1);
  });

  it('excludes an earlier pane refusal and still observes a new refusal', async () => {
    const events = [errorEvent('429 earlier pane')];
    const paneStart = events.length;
    const beforeCheck = () => throwIfProviderRateLimited(events.slice(paneStart), 'Current pane');
    expect((await pollUntil(() => true, { timeoutMs: 1_000, beforeCheck })).ok).toBe(true);
    events.push(errorEvent('429 current pane'));
    await expect(pollUntil(() => true, { timeoutMs: 1_000, beforeCheck })).rejects.toThrow('Current pane cannot run');
  });

  it('aborts an approval wait at the first confirmed refusal instead of consuming its timeout', async () => {
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([errorEvent('API Error: 429 request would exceed your rate limit')], 'Native tool approval');
      return false;
    }, { timeoutMs: 120_000, intervalMs: 100 })).rejects.toThrow(
      'Native tool approval cannot run: confirmed provider rate limit',
    );
    expect(checks).toBe(1);
  });

  it('allows a transient retry note to recover and reach the expected condition', async () => {
    let checks = 0;
    const outcome = await pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([transcript('system', 'upstream 429, retrying')], 'P-005 greeting');
      return checks === 2;
    }, { timeoutMs: 1_000, intervalMs: 1 });
    expect(outcome.ok).toBe(true);
    expect(checks).toBe(2);
  });

  it('keeps assistant explanations and unrelated errors available to their own acceptance assertions', () => {
    expect(() => throwIfProviderRateLimited([
      transcript('assistant', 'A 429 is a rate limit response.'),
      errorEvent('invalid model configuration'),
    ], 'P-005 read-explain')).not.toThrow();
  });
});

describe('live acceptance native model refusal guard', () => {
  const refusal = JSON.stringify({ detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." });
  const rejected = (): SuSessionEvent => ({
    ...base(), type: 'lifecycle', previousState: 'running', state: 'waiting-for-owner', reason: refusal,
  } as SuSessionEvent);

  it('fails before evaluating a screen predicate on the retained native lifecycle refusal', async () => {
    let checks = 0;
    await expect(pollUntil(() => { checks += 1; return true; }, {
      timeoutMs: 120_000,
      beforeCheck: () => throwIfProviderRefused([rejected()], 'Native reply'),
    })).rejects.toThrow('Native reply cannot run: confirmed provider model rejection');
    expect(checks).toBe(0);
  });

  it('fails an approval wait when the provider rejects the model after its first observation', async () => {
    const events: SuSessionEvent[] = [];
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      events.push(errorEvent(refusal));
      return false;
    }, {
      timeoutMs: 120_000, intervalMs: 1,
      beforeCheck: () => throwIfProviderRefused(events, 'Native tool approval'),
    })).rejects.toThrow('Native tool approval cannot run: confirmed provider model rejection');
    expect(checks).toBe(1);
  });

  it('does not treat assistant explanations, unrelated errors, or earlier panes as a current rejection', () => {
    const events = [rejected()];
    const paneStart = events.length;
    expect(() => throwIfProviderRefused([
      ...events.slice(paneStart), transcript('assistant', refusal), errorEvent('invalid model configuration'),
    ], 'Current pane')).not.toThrow();
    events.push(rejected());
    expect(() => throwIfProviderRefused(events.slice(paneStart), 'Current pane')).toThrow('provider model rejection');
  });

  it('preserves the existing rate-limit refusal', () => {
    expect(() => throwIfProviderRefused([errorEvent('API Error: 429')], 'Native reply'))
      .toThrow('confirmed provider rate limit');
  });
});
