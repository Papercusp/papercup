import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AdmitImmediatelyDriver,
  Governor,
  type AdmissionContext,
  type AdmissionRequest,
} from '../resource-governor/admission';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { createInferenceGateway } from './gateway';
import {
  GATEWAY_ADMISSION_BYPASS_KEYS,
  GATEWAY_ADMISSION_BYPASS_REGISTRY,
  admitGatewayRequest,
  gatewayAdmissionClassFor,
  gatewayAdmissionKindForBypassKey,
  toGatewayAdmissionRequest,
} from './admission-context';
import { _resetDbHealth } from './db-health';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: http.Server | undefined;

beforeEach(() => {
  // Gateway DB health is a process-wide telemetry singleton. Other test files
  // deliberately exercise sustained DB failures; without a reset, this file's
  // otherwise-hermetic /healthz assertion inherits their 503 latch when Vitest
  // co-locates the files in one worker.
  _resetDbHealth();
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await new Promise<void>((resolve) => {
    if (!upstream) return resolve();
    upstream.close(() => resolve());
  });
  upstream = undefined;
  _resetDbHealth();
});

test('gateway request facts map to one canonical admission request without a capacity formula', () => {
  const request = toGatewayAdmissionRequest({
    kind: 'codex',
    lane: 'openai-responses',
    provider: 'codex',
    accountId: 'acct-1',
    model: 'gpt-test',
    ownerId: 'su-owner',
    streaming: true,
    pinMode: 'hard',
    priority: 7,
    deadlineAtMs: 1234,
    idempotencyKey: 'gateway:test:1',
    payloadRef: 'payload:abc',
    metadata: { caller: 'test' },
  });

  assert.equal(gatewayAdmissionClassFor('codex'), 'inference');
  assert.equal(request.admissionClass, 'inference');
  assert.equal(request.priority, 7);
  assert.equal(request.deadlineAtMs, 1234);
  assert.equal(request.payloadRef, 'payload:abc');
  assert.equal(request.metadata?.['gateway.provider'], 'codex');
  assert.equal(request.metadata?.['gateway.streaming'], true);
  assert.equal(request.metadata?.caller, 'test');
  assert.equal(request.demand?.providerRequests, 1, 'the adapter supplies the canonical provider demand default');
});

test('registered bypasses produce a bypass outcome and release exactly once', async () => {
  const governor = new Governor(new AdmitImmediatelyDriver(), { bypassKeys: GATEWAY_ADMISSION_BYPASS_REGISTRY });
  const lease = await admitGatewayRequest(governor, {
    kind: gatewayAdmissionKindForBypassKey(GATEWAY_ADMISSION_BYPASS_KEYS.healthz),
    lane: '/healthz',
    idempotencyKey: 'gateway:test:healthz',
    bypassKey: GATEWAY_ADMISSION_BYPASS_KEYS.healthz,
  });

  assert.equal(lease.outcome.kind, 'bypass');
  if (lease.outcome.kind === 'bypass') assert.equal(lease.outcome.bypassKey, GATEWAY_ADMISSION_BYPASS_KEYS.healthz);
  assert.equal(lease.context.gateway.kind, 'health');
  assert.equal((await lease.release()).released, true);
  assert.equal((await lease.release()).released, false);
});

test('server control paths use registered bypass admission while maintenance uses the control class', async () => {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'summary' }] }));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const base = new Governor(new AdmitImmediatelyDriver(), { bypassKeys: GATEWAY_ADMISSION_BYPASS_REGISTRY });
  const admitted: AdmissionRequest[] = [];
  const released: AdmissionContext[] = [];
  const admissionGovernor = {
    admit: async (request: AdmissionRequest) => {
      admitted.push(request);
      return base.admit(request);
    },
    release: async (context: AdmissionContext, demand?: AdmissionRequest['demand']) => {
      released.push(context);
      return base.release(context, demand);
    },
  };

  gateway = createInferenceGateway({
    accountId: 'acct-1',
    token: async () => 'token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 4 }),
    admissionGovernor,
    proactiveEgressProbeMs: 0,
    selfHeal: { enabled: false },
    maintenanceModel: 'maintenance-test',
    maintenanceMaxTokens: 32,
  });
  const port = await gateway.listen(0);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  const stats = await fetch(`http://127.0.0.1:${port}/admin/stats?source=test`);
  assert.equal(stats.status, 200);
  const summary = await fetch(`http://127.0.0.1:${port}/maintenance/summarize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'summarize' }),
  });
  assert.equal(summary.status, 200);

  const healthAdmission = admitted.find((request) => request.bypassKey === GATEWAY_ADMISSION_BYPASS_KEYS.healthz);
  const statsAdmission = admitted.find((request) => request.bypassKey === GATEWAY_ADMISSION_BYPASS_KEYS.stats);
  const maintenanceAdmission = admitted.find((request) => request.metadata?.['gateway.kind'] === 'maintenance');
  const innerInferenceAdmission = admitted.find(
    (request) => request.metadata?.['gateway.kind'] === 'claude' && !request.bypassKey,
  );
  assert.ok(healthAdmission, 'healthz is admitted through the registered bypass');
  assert.ok(statsAdmission, 'stats is admitted through the registered bypass');
  assert.equal(healthAdmission?.admissionClass, 'control');
  assert.equal(statsAdmission?.admissionClass, 'control');
  assert.equal(maintenanceAdmission?.admissionClass, 'control');
  assert.equal(maintenanceAdmission?.bypassKey, undefined, 'maintenance is not a silent bypass');
  assert.ok(
    (maintenanceAdmission?.deadlineAtMs ?? 0) - Date.now() <= 150_000,
    'maintenance carries its bounded whole-call deadline into admission',
  );
  assert.ok(innerInferenceAdmission, 'the loopback model call still crosses normal inference admission');
  assert.equal(released.length, admitted.length, 'every server/loopback lease is released after its response settles');
});
