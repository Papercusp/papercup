import { createHash } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { bindNativeGymLlmCalls, snapshotNativeGymGatewayConfig, startNativeGymGateway,
  type NativeGymGatewayConfig } from '../proposer';
import { startGatewayService, type GatewayServiceOptions, type RunningGatewayService } from '../../inference-gateway/launch';
import type { GatewayCarryTrialAttempt } from '../../inference-gateway/gateway';
import { processMonotonicClock } from '../../process-monotonic-clock';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const token = 'PRIVATE_NATIVE_TOKEN_0123456789abcdef0123456789abcdef';
function config(): NativeGymGatewayConfig {
  return { token, carryTrial: { manifestSha256: digest('native manifest'), armId: 'native-cycle',
    protocols: ['anthropic-messages', 'openai-responses'], requestTokenSha256: digest(token),
    authorizeAttempt: async attempt => ({ attemptId: attempt.attemptId, reservationRef: 'native-reservation',
      clockId: attempt.clockId, validUntilMonotonicMs: processMonotonicClock.now() + 5_000,
      validateAuthorization: () => {} }) } };
}
const service = (stop = vi.fn(async () => {})) => ({ port: 12345, stop } as unknown as RunningGatewayService);
const attempt = (cfg: NativeGymGatewayConfig): GatewayCarryTrialAttempt => ({ attemptId: 'provider-attempt',
  manifestSha256: cfg.carryTrial.manifestSha256, armId: cfg.carryTrial.armId, transport: 'anthropic-http',
  accountId: 'selected-account', credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_SELECTED_TOKEN'),
  target: 'https://provider.invalid/v1/messages', body: '{}', bodySha256: digest('{}'),
  clockId: processMonotonicClock.id, signal: new AbortController().signal });

describe('native Gym scoped gateway lifecycle', () => {
  it.each([undefined, null, {}, { token }, { ...config(), token: 'wrong' },
    { ...config(), carryTrial: { ...config().carryTrial, protocols: ['openai-responses'] } },
    { ...config(), carryTrial: { ...config().carryTrial, protocols: ['anthropic-messages'] } },
    { ...config(), carryTrial: { ...config().carryTrial, authorizeAttempt: null } }])(
    'refuses incomplete authority before service setup: %j', async value => {
      const start = vi.fn(async () => service());
      await expect(startNativeGymGateway(value as NativeGymGatewayConfig, 'workspace', () => {}, start))
        .rejects.toMatchObject({ costUsd: 0 });
      expect(start).not.toHaveBeenCalled();
    });

  it('copies authority before the first setup await and uses the maintained service on a private port', async () => {
    const cfg = config(); const providerAttempt = attempt(cfg);
    const authorize = vi.fn(cfg.carryTrial.authorizeAttempt);
    Object.assign(cfg.carryTrial, { authorizeAttempt: authorize });
    let supplied!: GatewayServiceOptions;
    const start = vi.fn(async (options: GatewayServiceOptions) => {
      supplied = options;
      cfg.token = 'substituted';
      Object.assign(cfg.carryTrial, { armId: 'substituted', manifestSha256: digest('substituted'),
        protocols: ['anthropic-messages'], authorizeAttempt: async () => null });
      return service();
    });
    const native = await startNativeGymGateway(cfg, 'credential-workspace', () => {}, start);
    expect(supplied).toMatchObject({ workspace: 'credential-workspace', port: 0,
      carryTrial: { armId: 'native-cycle', manifestSha256: digest('native manifest'),
        requestTokenSha256: digest(token), protocols: ['anthropic-messages', 'openai-responses'] } });
    expect(supplied.carryTrial!.authorizeAttempt).not.toBe(cfg.carryTrial.authorizeAttempt);
    const receipt = await supplied.carryTrial!.authorizeAttempt(providerAttempt);
    expect(receipt).not.toBeNull(); receipt!.validateAuthorization!();
    expect(authorize).toHaveBeenCalledWith(providerAttempt);
    expect(native.transport.statelessGateway).toEqual({ baseURL: 'http://127.0.0.1:12345', token });
    await native.stop();
  });

  it('requires a synchronous final provider authority check in each copied receipt', async () => {
    const cfg = config();
    Object.assign(cfg.carryTrial, { authorizeAttempt: async (attempt: Parameters<NativeGymGatewayConfig['carryTrial']['authorizeAttempt']>[0]) =>
      ({ attemptId: attempt.attemptId, reservationRef: 'reservation', clockId: attempt.clockId, validUntilMonotonicMs: 999999 }) });
    const frozen = snapshotNativeGymGatewayConfig(cfg);
    await expect(frozen.carryTrial.authorizeAttempt(attempt(cfg))).resolves.toBeNull();
  });

  it.each(['anthropic', 'codex'] as const)('authorizes only its exact loopback bearer request (%s)', async protocol => {
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service());
    const body = JSON.stringify(protocol === 'anthropic' ? { max_tokens: 500 } : { max_output_tokens: 500 });
    const request = { attemptId: 'attempt', callId: 'call', attempt: 1, method: 'POST',
      url: `http://127.0.0.1:12345/v1/${protocol === 'anthropic' ? 'messages' : 'responses'}`,
      body, bodySha256: digest(body), credentialSha256: digest(JSON.stringify({ authorization: `Bearer ${token}`, apiKey: null })),
      signal: new AbortController().signal };
    const authorize = native.transport.authorizeStatelessRequest!;
    const check = await authorize(request); expect(check).toBeTypeOf('function'); check!();
    for (const patch of [{ url: 'https://remote.invalid/v1/messages' }, { method: 'GET' },
      { bodySha256: digest('substituted') }, { credentialSha256: digest('foreign') },
      { url: request.url + '?credential=private' }, { url: 'http://127.0.0.1:12345/stats' }]) {
      await expect(authorize({ ...request, ...patch })).resolves.toBeNull();
    }
    await native.stop();
    expect(() => check!()).toThrow();
    await expect(authorize(request)).resolves.toBeNull();
  });

  it('revokes before teardown and stops the service once', async () => {
    const stop = vi.fn(async () => {});
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service(stop));
    await native.stop(); await native.stop(); expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each(['authorized', 'revoked', 'missing-final-check'] as const)(
    'binds the actual selected credential and body through the maintained private HTTP service (%s)', async state => {
      let requests = 0; let providerAuth: string | undefined;
      const upstream = http.createServer((req, res) => {
        requests++; providerAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const cfg = config(); let finalChecks = 0;
      const authorize = vi.fn(async (actual: GatewayCarryTrialAttempt) => {
        expect(actual.credentialSha256).toBe(digest('Bearer PRIVATE_SELECTED_TOKEN'));
        expect(actual.credentialSha256).not.toBe(cfg.carryTrial.requestTokenSha256);
        expect(actual.accountId).toBe('selected-account');
        expect(actual.bodySha256).toBe(digest(actual.body));
        expect(JSON.parse(actual.body)).toMatchObject({ max_tokens: 41,
          messages: [{ role: 'user', content: 'PRIVATE_TASK' }] });
        const base = { attemptId: actual.attemptId, reservationRef: 'native-reservation', clockId: actual.clockId,
          validUntilMonotonicMs: processMonotonicClock.now() + 5_000 };
        return state === 'missing-final-check' ? base : { ...base, validateAuthorization: () => {
          finalChecks++; expect(requests).toBe(0);
          if (state === 'revoked') throw new Error('PRIVATE_REVOKED_AUTHORITY');
        } };
      });
      Object.assign(cfg.carryTrial, { authorizeAttempt: authorize });
      let native: Awaited<ReturnType<typeof startNativeGymGateway>> | undefined;
      try {
        native = await startNativeGymGateway(cfg, 'private-test-workspace', () => {}, options =>
          startGatewayService({ ...options, upstreamBase,
            resolveAccount: async () => ({ accountId: 'selected-account', credentialRef: 'token:/dev/null', source: 'env' }),
            makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'PRIVATE_SELECTED_TOKEN', invalidate: () => {} }),
            observePool: () => () => {}, refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
        const response = await fetch(`${native.transport.statelessGateway!.baseURL}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 41, messages: [{ role: 'user', content: 'PRIVATE_TASK' }] }),
        });
        expect(response.status).toBe(state === 'authorized' ? 200 : 403);
        expect(await response.text()).not.toMatch(/PRIVATE_/);
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(finalChecks).toBe(state === 'missing-final-check' ? 0 : 1);
        expect(requests).toBe(state === 'authorized' ? 1 : 0);
        expect(providerAuth).toBe(state === 'authorized' ? 'Bearer PRIVATE_SELECTED_TOKEN' : undefined);
      } finally {
        await native?.stop();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    });

  it('binds both real consumers to a private transport copied before a retry', async () => {
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service());
    const receipt = { text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { costUsd: 0 })).mockResolvedValue(receipt);
    const original = { ...native.transport.statelessGateway! };
    const guard = native.transport.authorizeStatelessRequest;
    const bound = bindNativeGymLlmCalls(call, 'harness', { log: () => {}, transport: native.transport,
      sleep: async () => { native.transport.statelessGateway!.token = 'substituted';
        native.transport.authorizeStatelessRequest = async () => null; } });
    const request = { model: 'claude-fixture', maxTokens: 500, messages: [{ role: 'user' as const, content: 'PRIVATE_REQUEST' }] };
    await bound.judge(request); await bound.proposer(request);
    for (const [sent] of call.mock.calls) expect(sent).toMatchObject({ statelessGateway: original,
      authorizeStatelessRequest: guard, requireOutputTokenLimit: true, priority: 'gym', harnessSlug: 'harness' });
    await native.stop();
  });
});
