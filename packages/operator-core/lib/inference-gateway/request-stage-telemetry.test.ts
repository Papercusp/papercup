import { describe, expect, it } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import http from 'node:http';
import {
  GatewayRequestTelemetry,
  MAX_CACHE_FINGERPRINT_BYTES,
  assertCompleteGatewayRequestTimeline,
  classifyGatewayTelemetryOutcome,
  assessStartupCacheSharing,
  type StartupCacheEvidence,
} from './request-stage-telemetry';

describe('bounded upstream HTTP write observations', () => {
  const target = 'http://127.0.0.1:12345/private-path?secret=PRIVATE_QUERY';
  const request = () => ({ origin: 'http://127.0.0.1:12345', path: '/private-path?secret=PRIVATE_QUERY', method: 'POST' });
  const emit = (phase: 'create' | 'bodySent' | 'error' | 'sendHeaders', outgoing: object) =>
    channel(`undici:${phase === 'sendHeaders' ? 'client' : 'request'}:${phase}`).publish({ request: outgoing,
      headers: 'PRIVATE_HEADER', error: new Error('PRIVATE_ERROR') });
  const fixture = () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'su-writes', provider: 'codex', protocol: 'openai-responses', transport: 'bearer-http' });
    return { telemetry, span };
  };

  it('observes real global-fetch socket writes without storing the target, request body or credentials', async () => {
    const { telemetry, span } = fixture();
    let received = '';
    const server = http.createServer(async (req, res) => {
      for await (const chunk of req) received += String(chunk);
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/PRIVATE_PATH`;
    try {
      const response = await span.observeUpstreamFetch(url, 'POST', 'prepared-account', () => fetch(url,
        { method: 'POST', body: 'PRIVATE_BODY', headers: { authorization: 'PRIVATE_AUTH' } }));
      expect(await response.text()).toBe('ok');
      expect(received).toBe('PRIVATE_BODY');
      span.finish('ok', 200);
      const snapshot = telemetry.snapshot(), call = snapshot.recent[0].upstreamWrites.calls[0];
      expect(call).toMatchObject({ accountId: 'prepared-account', clock: 'performance.now', outcome: 'returned',
        responseStatus: 200, matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
      expect(call.events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
      expect(call.events.map(event => event.requestOrdinal)).toEqual([1, 1, 1]);
      expect(call.clockId).toMatch(/^gateway-upstream:/);
      for (let i = 1; i < call.events.length; i++) expect(call.events[i].atMs).toBeGreaterThanOrEqual(call.events[i - 1].atMs);
      expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|127\.0\.0\.1/);
      call.events[0].atMs = -1;
      const owner = telemetry.snapshotForOwner('su-writes');
      expect(owner.recent[0].upstreamWrites.calls[0].events[0].atMs).toBeGreaterThan(0);
      owner.recent[0].upstreamWrites.calls[0].accountId = 'tampered';
      expect(telemetry.snapshot().recent[0].upstreamWrites.calls[0].accountId).toBe('prepared-account');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps unsupported fetches unobserved and preserves errors and listener cleanup', async () => {
    const before = channel('undici:request:create').hasSubscribers;
    const { telemetry, span } = fixture(), sentinel = new Error('PRIVATE_FAILURE');
    expect(await span.observeUpstreamFetch(target, 'POST', 'account', async () => 7)).toBe(7);
    await expect(span.observeUpstreamFetch(target, 'POST', 'account', async () => { throw sentinel; })).rejects.toBe(sentinel);
    expect(channel('undici:request:create').hasSubscribers).toBe(before);
    span.finish('upstream-error', 502);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.outcome)).toEqual(['returned', 'threw']);
    expect(calls.every(call => call.matchedRequests === 0 && call.events.length === 0)).toBe(true);
  });

  it('joins pooled-socket events by request object across overlapping foreign async contexts', async () => {
    const { telemetry, span } = fixture();
    const a = request(), b = request();
    await span.observeUpstreamFetch(target, 'POST', 'account-a', async () => {
      emit('create', a);
      await span.observeUpstreamFetch(target, 'POST', 'account-b', async () => {
        emit('create', b); emit('sendHeaders', a); emit('sendHeaders', b); emit('bodySent', a); emit('error', b);
      });
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.accountId)).toEqual(['account-a', 'account-b']);
    expect(calls[0].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
    expect(calls[1].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'error']);
    expect(JSON.stringify(calls)).not.toMatch(/PRIVATE_/);
  });

  it('retains pre-send failures and repeated transport writes without collapsing attempts', async () => {
    const { telemetry, span } = fixture();
    await span.observeUpstreamFetch(target, 'POST', 'failed-account', async () => {
      const outgoing = request(); emit('create', outgoing); emit('error', outgoing);
    });
    await span.observeUpstreamFetch(target, 'POST', 'next-account', async () => {
      const outgoing = request(); emit('create', outgoing); emit('sendHeaders', outgoing); emit('error', outgoing);
      emit('sendHeaders', outgoing); emit('bodySent', outgoing);
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.ordinal)).toEqual([1, 2]);
    expect(calls[0].events.map(event => event.phase)).toEqual(['created', 'error']);
    expect(calls[1].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'error', 'headers-write-start', 'body-write-complete']);
  });

  it('exposes unexpected targets and ignores late events after the fetch has settled', async () => {
    const { telemetry, span } = fixture(), outgoing = request();
    await span.observeUpstreamFetch(target, 'POST', 'account-a', async () => {
      emit('create', outgoing); emit('create', { ...request(), path: '/unexpected' });
    });
    await span.observeUpstreamFetch(target, 'POST', 'account-b', async () => {
      emit('bodySent', outgoing); // old request must not attach to B or mutate A
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls[0]).toMatchObject({ matchedRequests: 1, unexpectedRequests: 1 });
    expect(calls[0].events.map(event => event.phase)).toEqual(['created']);
    expect(calls[1].events).toEqual([]);
  });

  it('bounds requests, events and calls with explicit overflow, without suppressing fetches', async () => {
    const { telemetry, span } = fixture(); let invoked = 0;
    for (let i = 0; i < 34; i++) await span.observeUpstreamFetch(target, 'POST', 'account', async () => {
      invoked++;
      for (let j = 0; j < 10; j++) {
        const outgoing = request(); emit('create', outgoing);
        for (let k = 0; k < 6; k++) emit('sendHeaders', outgoing);
      }
    });
    span.finish('ok', 200);
    const writes = telemetry.snapshot().recent[0].upstreamWrites;
    expect(invoked).toBe(34); expect(writes.droppedCalls).toBe(2); expect(writes.calls).toHaveLength(32);
    expect(writes.calls[0]).toMatchObject({ matchedRequests: 10, droppedRequests: 2, droppedEvents: 24 });
    expect(writes.calls.every(call => call.events.length === 32)).toBe(true);
  });

  it('does not manufacture a matching account by truncation or track after span finalization', async () => {
    const { telemetry, span } = fixture();
    await span.observeUpstreamFetch(target, 'POST', 'x'.repeat(121), async () => undefined);
    span.finish('ok', 200);
    let ran = false;
    await span.observeUpstreamFetch(target, 'POST', 'later-account', async () => { ran = true; });
    expect(ran).toBe(true);
    const writes = telemetry.snapshot().recent[0].upstreamWrites;
    expect(writes.calls).toHaveLength(1); expect(writes.calls[0].accountId).toBeNull();
  });

  it('does not attribute an unobserved nested fetch to its parent observation', async () => {
    const { telemetry, span } = fixture();
    const ended = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    ended.finish('ok', 200);
    await span.observeUpstreamFetch(target, 'POST', 'parent', async () => {
      emit('create', request());
      await ended.observeUpstreamFetch(target, 'POST', 'unobserved', async () => {
        const child = request(); emit('create', child); emit('bodySent', child);
      });
    });
    span.finish('ok', 200);
    const writes = telemetry.snapshotForOwner('su-writes').recent[0].upstreamWrites;
    expect(writes.calls[0].matchedRequests).toBe(1);
    expect(writes.calls[0].events.map(event => event.phase)).toEqual(['created']);
  });
});

describe('ten-agent startup sharing evidence (R-10)', () => {
  const fingerprint = { sha256: 'a'.repeat(64), bytes: 1000, hashedBytes: 1000 };
  const cohort = (): StartupCacheEvidence[] => Array.from({ length: 10 }, (_, index) => ({
    authorizationScope: 'tenant-a/provider-project-a', model: 'test-model', transport: 'bearer-http',
    tools: { ...fingerprint }, instructions: { ...fingerprint }, startedAt: index * 100,
    availableAt: index * 100 + 50, expiresAt: 300000, cacheReadTokens: null, cacheWriteTokens: null,
  }));
  it('finds nine sequential component matches but never promises one write and nine hits', () => {
    expect(assessStartupCacheSharing(cohort())).toEqual({ requests: 10, comparable: 10, unknown: 0,
      componentGroups: 1, withEarlierEligibleComponentMatch: 9, coldOrConcurrent: 1, timingUnknown: 0,
      observedReadRequests: 0, observedWriteRequests: 0, readCoverage: 0, writeCoverage: 0,
      singleWriteGuaranteed: false });
  });
  it('allows all ten simultaneous cold starts to require writes before any cache is eligible', () => {
    const concurrent = cohort().map(row => ({ ...row, startedAt: 0, availableAt: 50,
      cacheReadTokens: 0, cacheWriteTokens: 1000 }));
    expect(assessStartupCacheSharing(concurrent)).toMatchObject({ coldOrConcurrent: 10,
      withEarlierEligibleComponentMatch: 0, observedWriteRequests: 10, singleWriteGuaranteed: false });
  });
  it('never groups across authorization scope, model or transport boundaries', () => {
    for (const dimension of ['authorizationScope', 'model', 'transport'] as const) {
      const rows = cohort().map((row, index) => ({ ...row,
        [dimension]: dimension === 'transport' ? (index < 5 ? 'bearer-http' : 'oauth-http') : `${dimension}-${index}`,
      })) as StartupCacheEvidence[];
      expect(assessStartupCacheSharing(rows).componentGroups).toBe(dimension === 'transport' ? 2 : 10);
    }
  });
  it('treats absent authorization and partial fingerprints as unknown, not identical', () => {
    const rows = cohort().map((row, index) => index < 5 ? { ...row, authorizationScope: null }
      : { ...row, instructions: { ...fingerprint, bytes: 100000, hashedBytes: 65536 } });
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 0, unknown: 10,
      withEarlierEligibleComponentMatch: 0 });
  });
  it('honors expiry and leaves unobservable subscription timing unknown', () => {
    expect(assessStartupCacheSharing(cohort().map(row => ({ ...row, expiresAt: row.availableAt! + 10 }))))
      .toMatchObject({ withEarlierEligibleComponentMatch: 0, coldOrConcurrent: 10 });
    expect(assessStartupCacheSharing(cohort().map(row => ({ ...row, availableAt: null, expiresAt: null }))))
      .toMatchObject({ withEarlierEligibleComponentMatch: 0, timingUnknown: 9 });
  });
  it('detects changed tool order/schema and instruction content without retaining raw content', () => {
    const telemetry = new GatewayRequestTelemetry();
    const shapes = [
      { tools: [{ name: 'a' }, { name: 'b' }], instructions: 'base' },
      { tools: [{ name: 'b' }, { name: 'a' }], instructions: 'base' },
      { tools: [{ name: 'a', description: 'changed' }, { name: 'b' }], instructions: 'base' },
      { tools: [{ name: 'a' }, { name: 'b' }], instructions: 'base with volatile text before stable boundary' },
    ];
    const rows = shapes.map((body, index) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify(body)));
      const cache = span.finish('ok', 200)!.cache;
      return { ...cohort()[index], tools: cache.tools, instructions: cache.instructions };
    });
    expect(assessStartupCacheSharing(rows).componentGroups).toBe(4);
    expect(JSON.stringify(assessStartupCacheSharing(rows))).not.toContain('volatile');
  });
});

function completeCloudSpan(telemetry: GatewayRequestTelemetry, advance: (ms: number) => void, owner = 'su-test') {
  const span = telemetry.begin({
    ownerId: owner,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
  });
  advance(1);
  span.routeSelected();
  advance(2);
  span.admitted();
  span.beginStage('bodyRead');
  advance(3);
  span.endStage('bodyRead');
  span.beginStage('auth');
  advance(4);
  span.endStage('auth');
  span.setModel('claude-opus-4');
  span.setCacheRouting('rewritten');
  span.recordAttempt();
  span.beginStage('upstreamTtfb');
  advance(5);
  span.endStage('upstreamTtfb');
  span.setStreaming(true);
  span.beginStage('stream');
  advance(6);
  span.endStage('stream');
  return span.finish('ok', 200)!;
}

describe('GatewayRequestTelemetry', () => {
  const nativeIds = { session_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc',
    thread_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc', turn_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d30',
    window_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d31:0' };
  const nativeBody = (meta: unknown = nativeIds) => ({
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify(meta) },
  });

  it('retains only exact native ids, independently of serving account, and isolates returned snapshots', () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
    const body = nativeBody({ ...nativeIds, ownerId: 'forged-owner', servingAccountId: 'forged-account',
      prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_TOKEN', nested: { password: 'PRIVATE_PASSWORD' } });
    span.setNativeCorrelation(body);
    body.client_metadata['x-codex-turn-metadata'] = 'changed';
    span.setServingAccount('actual-account');
    span.finish('ok', 200);
    const before = telemetry.snapshot();
    expect(before.recent[0]).toMatchObject({ ownerId: 'su-native', cache: { servingAccountId: 'actual-account' },
      nativeCorrelation: { status: 'observed', sessionId: nativeIds.session_id, threadId: nativeIds.thread_id,
        turnId: nativeIds.turn_id, windowId: nativeIds.window_id } });
    expect(JSON.stringify(before)).not.toMatch(/PRIVATE_|forged-/);
    before.recent[0].nativeCorrelation.threadId = 'changed';
    const owner = telemetry.snapshotForOwner('su-native');
    expect(owner.recent[0].nativeCorrelation.threadId).toBe(nativeIds.thread_id);
    owner.recent[0].nativeCorrelation.turnId = 'changed';
    expect(telemetry.snapshot().recent[0].nativeCorrelation.turnId).toBe(nativeIds.turn_id);
    span.setNativeCorrelation(nativeBody({ ...nativeIds, turn_id: nativeIds.window_id }));
    expect(telemetry.snapshot().recent[0].nativeCorrelation.turnId).toBe(nativeIds.turn_id);
  });

  it.each([
    ['no-client', {}, 'missing'], ['no-meta', { client_metadata: {} }, 'missing'],
    ['null-body', null, 'invalid'], ['array-body', [], 'invalid'],
    ['null-client', { client_metadata: null }, 'invalid'],
    ['object-meta', { client_metadata: { 'x-codex-turn-metadata': nativeIds } }, 'invalid'],
    ['bad-json', { client_metadata: { 'x-codex-turn-metadata': '{' } }, 'invalid'],
    ['array-meta', nativeBody([]), 'invalid'],
    ['missing-turn', nativeBody({ thread_id: nativeIds.thread_id }), 'invalid'],
    ['overlong-id', nativeBody({ ...nativeIds, turn_id: nativeIds.turn_id + 'x' }), 'invalid'],
    ['whitespace-id', nativeBody({ ...nativeIds, turn_id: ' ' + nativeIds.turn_id }), 'invalid'],
    ['invalid-optional', nativeBody({ ...nativeIds, session_id: null }), 'invalid'],
    ['invalid-window', nativeBody({ ...nativeIds, window_id: nativeIds.window_id + ':extra' }), 'invalid'],
    ['oversized-meta', nativeBody({ ...nativeIds, extra: 'x'.repeat(4096) }), 'oversized'],
    ['multibyte-meta', nativeBody({ ...nativeIds, extra: '界'.repeat(1400) }), 'oversized'],
  ])('keeps %s metadata explicitly unknown without stale identifiers', (_name, body, status) => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setNativeCorrelation(nativeBody());
    span.setNativeCorrelation(body);
    expect(span.finish('client-error', 400)?.nativeCorrelation).toEqual({ status,
      sessionId: null, threadId: null, turnId: null, windowId: null });
  });

  it('does not infer native identity from owner or equate a native turn with one request', () => {
    const telemetry = new GatewayRequestTelemetry();
    const absent = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
    expect(absent.finish('shed', 503)?.nativeCorrelation.status).toBe('unobserved');
    for (const outcome of ['ok', 'upstream-error'] as const) {
      const span = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
      span.setNativeCorrelation(nativeBody({ thread_id: nativeIds.thread_id, turn_id: nativeIds.turn_id }));
      span.recordAttempt(); span.recordAttempt(); span.recordFailover();
      span.finish(outcome, outcome === 'ok' ? 200 : 500);
    }
    const rows = telemetry.snapshotForOwner('su-native').recent.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].requestId).not.toBe(rows[1].requestId);
    expect(rows[0].nativeCorrelation).toEqual(rows[1].nativeCorrelation);
    expect(rows.every(row => row.cache.servingAccountId === null && row.attempts === 2 && row.failovers === 1)).toBe(true);
  });

  it('reports observed account/cache usage with explicit unknown miss cause and bounded coverage', () => {
    const telemetry = new GatewayRequestTelemetry();
    expect(telemetry.snapshot().requests.cacheUsageCoverage).toBeNull();
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    span.setServingAccount('actually-served');
    span.recordFailover();
    span.recordCacheUsage(10, 0, 20, 'msg-native');
    span.finish('ok', 200);
    telemetry.begin({ provider: 'codex', protocol: 'openai-responses' }).finish('shed', 503);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({ finalized: 2, cacheUsageObserved: 1, cacheUsageCoverage: 0.5 });
    expect(snapshot.recent[0].cache).toMatchObject({ servingAccountId: 'actually-served', providerRequestId: 'msg-native',
      inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 0, reuse: 'zero-read', missReason: 'unknown' });
    expect(snapshot.recent[1].cache.reuse).toBe('unobserved');
    expect(snapshot.recent[1].cache.servingAccountId).toBeNull();
  });

  it('fingerprints tools and instructions without retaining their content or the dynamic conversation', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = (message: string) => Buffer.from(JSON.stringify({ tools: [{ name: 'private-tool', description: 'not-for-logs' }],
      instructions: 'secret-instructions', input: message }));
    const first = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    first.setCacheShape(body('first dynamic message'));
    first.recordCacheUsage(20, 80, 0);
    first.finish('ok', 200);
    const second = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    second.setCacheShape(body('different dynamic message'));
    second.recordCacheUsage(0, 100, 0);
    second.finish('ok', 200);
    const snapshot = telemetry.snapshot();
    expect(snapshot.recent[0].cache.tools).toEqual(snapshot.recent[1].cache.tools);
    expect(snapshot.recent[0].cache.instructions).toEqual(snapshot.recent[1].cache.instructions);
    expect(snapshot.recent[0].cache.reuse).toBe('partial-hit');
    expect(snapshot.recent[1].cache.reuse).toBe('full-hit');
    expect(snapshot.recent[1].previousObservedRequestGapMs).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/private-tool|not-for-logs|secret-instructions|dynamic message/);
    snapshot.recent[0].cache.tools!.sha256 = 'corrupted-caller-copy';
    expect(telemetry.snapshotForOwner('su-test').recent[0].cache.tools!.sha256).not.toBe('corrupted-caller-copy');
  });

  it('compares complete representative large tool and instruction blocks', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = {
      tools: [{ name: 'large-tool', description: 't'.repeat(230_000) }],
      instructions: 'i'.repeat(157_000),
    };
    const rows = ['first conversation', 'second conversation'].map((input, index) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify({ ...body, input })));
      const cache = span.finish('ok', 200)!.cache;
      expect(cache.tools!.hashedBytes).toBe(cache.tools!.bytes);
      expect(cache.instructions!.hashedBytes).toBe(cache.instructions!.bytes);
      return { authorizationScope: 'same-observed-scope', model: 'same-model', transport: 'bearer-http' as const,
        tools: cache.tools, instructions: cache.instructions, startedAt: index * 100,
        availableAt: index * 100 + 50, expiresAt: 1000, cacheReadTokens: null, cacheWriteTokens: null };
    });
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 2, componentGroups: 1,
      withEarlierEligibleComponentMatch: 1, singleWriteGuaranteed: false });
  });

  it.each(['tools', 'instructions'] as const)('distinguishes equal-length %s changes after the old 64KiB cutoff', (field) => {
    const telemetry = new GatewayRequestTelemetry();
    const rows = ['A', 'B'].map((suffix, index) => {
      const value = 'x'.repeat(70_000) + suffix;
      const body = { tools: [{ name: 'stable-tool', description: field === 'tools' ? value : 'stable' }],
        instructions: field === 'instructions' ? value : 'stable' };
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify(body)));
      const cache = span.finish('ok', 200)!.cache;
      return { authorizationScope: 'same-observed-scope', model: 'same-model', transport: 'bearer-http' as const,
        tools: cache.tools, instructions: cache.instructions, startedAt: index * 100,
        availableAt: null, expiresAt: null, cacheReadTokens: null, cacheWriteTokens: null };
    });
    // The grouping key includes bytes: unequal lengths would hide a truncated-hash bug.
    expect(rows[0][field]!.bytes).toBe(rows[1][field]!.bytes);
    expect(rows[0][field]!.sha256).not.toBe(rows[1][field]!.sha256);
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 2, componentGroups: 2 });
  });

  it('bounds fingerprint work and does not call partial or missing observations exact', () => {
    const telemetry = new GatewayRequestTelemetry({ recentCapacity: 1 });
    const capped = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    const instructions = 'x'.repeat(MAX_CACHE_FINGERPRINT_BYTES + 1);
    capped.setCacheShape(Buffer.from(JSON.stringify({ instructions })));
    const first = capped.finish('ok', 200)!;
    expect(first.cache.instructions).toMatchObject({ bytes: Buffer.byteLength(JSON.stringify(instructions)),
      hashedBytes: MAX_CACHE_FINGERPRINT_BYTES });
    const oversized = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    oversized.setCacheShape(Buffer.alloc(2_097_153));
    oversized.recordCacheUsage(Number.NaN, 0, 0);
    expect(oversized.finish('ok', 200)?.cache).toMatchObject({ shape: 'oversized', reuse: 'unobserved', instructions: null });
    expect(telemetry.snapshot().recent).toHaveLength(1);
  });

  it('measures fingerprint overhead and rejects non-object request shapes', () => {
    let clock = 0;
    const telemetry = new GatewayRequestTelemetry({ now: () => ++clock });
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setCacheShape(Buffer.from('null'));
    const timeline = span.finish('client-error', 400)!;
    expect(timeline.cacheObservationMs).toBe(1);
    expect(timeline.cache.shape).toBe('invalid');
  });

  it('does not mislabel missing write usage as a measured zero or full hit', () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.recordCacheUsage(0, 100, undefined);
    expect(span.finish('ok', 200)?.cache).toMatchObject({ cacheWriteTokens: null, reuse: 'hit-unknown-write' });
    expect(telemetry.snapshot().requests).toMatchObject({ cacheUsageObserved: 1, cacheWriteObserved: 0 });
  });

  it('publishes bounded p50/p95/p99 samples with exact request/outcome reconciliation', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, sampleCapacity: 3, recentCapacity: 2 });
    const advance = (ms: number) => { now += ms; };

    for (let i = 0; i < 5; i++) {
      const timeline = completeCloudSpan(telemetry, (ms) => advance(ms + i), `su-${i}`);
      assertCompleteGatewayRequestTimeline(timeline);
    }
    const active = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    active.routeSelected();

    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({
      started: 6,
      finalized: 5,
      active: 1,
      sampled: 5,
      coverage: 1,
      reconciled: true,
      outcomeReconciled: true,
      missingStageTimelines: 0,
    });
    expect(snapshot.outcomes.ok).toBe(5);
    expect(snapshot.outcomes.unclassified).toBe(0);
    expect(snapshot.stages.upstreamTtfb).toMatchObject({ count: 5, retained: 3 });
    expect(snapshot.stages.upstreamTtfb.p50).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p95).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p99).not.toBeNull();
    expect(snapshot.recent).toHaveLength(2);
  });

  it('makes a missing required stage a loud validation failure and counted telemetry defect', () => {
    let now = 10;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    now += 1;
    span.routeSelected();
    now += 1;
    span.admitted();
    // Deliberately omit body/auth/upstream stages.
    const timeline = span.finish('ok', 200)!;

    expect(() => assertCompleteGatewayRequestTimeline(timeline)).toThrow(/bodyRead.*upstreamTtfb.*auth/);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests.missingStageTimelines).toBe(1);
    expect(snapshot.missingStageByName.bodyRead).toBe(1);
    expect(snapshot.missingStageByName.auth).toBe(1);
    expect(snapshot.missingStageByName.upstreamTtfb).toBe(1);
  });

  it('attributes aggregate queueWait to typed durable/provider admission segments with queue state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({
      ownerId: 'su-latency',
      provider: 'codex',
      protocol: 'openai-responses',
      transport: 'oauth-http',
    });
    span.routeSelected();

    span.admissionQueued('payloadSpool');
    now += 5;
    span.admissionAdmitted('payloadSpool');

    span.admissionQueued('durable', { priority: 20 });
    now += 12;
    span.admissionAdmitted('durable', { priority: 20 });

    span.admissionQueued('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 849,
        queued: 17,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 721, queued: 16 }],
      },
    });
    now += 66_110;
    span.admissionAdmitted('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 850,
        queued: 16,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 722, queued: 15 }],
      },
    });
    span.admitted();
    span.beginStage('bodyRead');
    span.endStage('bodyRead');
    span.beginStage('auth');
    span.endStage('auth');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 3;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    expect(timeline.durationsMs.queueWait).toBe(66_127);
    expect(timeline.admission).toEqual({
      payloadSpool: {
        queued: expect.objectContaining({ offsetMs: 0 }),
        admitted: expect.objectContaining({ offsetMs: 5 }),
        waitMs: 5,
      },
      durable: {
        queued: expect.objectContaining({ offsetMs: 5, priority: 20 }),
        admitted: expect.objectContaining({ offsetMs: 17, priority: 20 }),
        waitMs: 12,
      },
      provider: {
        queued: {
          offsetMs: 17,
          priority: 20,
          tier: 2,
          running: 849,
          queued: 17,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 721,
          tierQueued: 16,
        },
        admitted: {
          offsetMs: 66_127,
          priority: 20,
          tier: 2,
          running: 850,
          queued: 16,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 722,
          tierQueued: 15,
        },
        waitMs: 66_110,
      },
    });
    expect(telemetry.snapshotForOwner('su-latency').recent[0]?.admission.provider?.waitMs).toBe(66_110);
  });

  it('never retains arbitrary bodies, credentials, headers, URLs, or error prose', () => {
    let now = 100;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const seed = {
      ownerId: 'su safe owner\nBearer SECRET_TOKEN',
      provider: 'local' as const,
      protocol: 'openai-chat' as const,
      transport: 'local-http' as const,
      requestBody: 'PROMPT_SECRET',
      authorization: 'Bearer SECRET_TOKEN',
      url: 'https://secret.invalid/private',
    };
    const span = telemetry.begin(seed);
    span.routeSelected();
    span.admitted();
    span.beginStage('bodyRead');
    now += 1;
    span.endStage('bodyRead');
    span.setModel('model\nSECRET_MODEL_SUFFIX');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 1;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    const serialized = JSON.stringify(telemetry.snapshot());
    expect(serialized).not.toContain('PROMPT_SECRET');
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toContain('secret.invalid');
    expect(timeline.ownerId).toBe('su');
    expect(timeline.model).toBe('model?SECRET_MODEL_SUFFIX');
  });

  it('classifies one stable final outcome from status and terminal conditions', () => {
    expect(classifyGatewayTelemetryOutcome(200)).toBe('ok');
    expect(classifyGatewayTelemetryOutcome(400)).toBe('client-error');
    expect(classifyGatewayTelemetryOutcome(429)).toBe('upstream-429');
    expect(classifyGatewayTelemetryOutcome(503)).toBe('upstream-error');
    expect(classifyGatewayTelemetryOutcome(null, { cancelled: true })).toBe('cancelled');
    expect(classifyGatewayTelemetryOutcome(429, { shed: true })).toBe('shed');
    expect(classifyGatewayTelemetryOutcome(500, { gatewayError: true })).toBe('gateway-error');
    expect(classifyGatewayTelemetryOutcome(null)).toBe('unclassified');
  });

  it('adds owner summaries to the existing per-owner read without unbounded per-owner state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, recentCapacity: 3 });
    for (const owner of ['su-a', 'su-b', 'su-a']) {
      completeCloudSpan(telemetry, (ms) => { now += ms; }, owner);
    }
    const owner = telemetry.snapshotForOwner('su-a');
    expect(owner.finalized).toBe(2);
    expect(owner.outcomes.ok).toBe(2);
    expect(owner.stages.total.count).toBe(2);
    expect(owner.recent.every((timeline) => timeline.ownerId === 'su-a')).toBe(true);
  });
});
