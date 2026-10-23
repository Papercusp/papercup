import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { requestTscService, tscServiceIdentity, tscServiceSocketPath } from '../../../scripts/lib/tsc-service.mjs';
import { readProcessIdentity } from './process-identity';

it('completes a source-bound request through the installed focused socket service without full fallback', async context => {
  const root = resolve(import.meta.dirname, '../../..');
  const request = { root, project: resolve(root, 'packages/operator-core/tsconfig.json'),
    files: ['packages/operator-core/lib/serving-build.ts'], scope: 'named', requestId: randomUUID() };
  const socketPath = tscServiceSocketPath();
  const identity = tscServiceIdentity(request);
  const progress: unknown[] = [];
  const result = await requestTscService({ socketPath, request, timeoutMs: 30_000,
    onProgress: entry => progress.push(entry) });
  expect(result).toMatchObject({ kind: 'result', ok: true, requestId: request.requestId, identity,
    errorCount: 0, checked: request.files, namedNotInProgram: [] });
  expect(result).not.toHaveProperty('fallback');
  expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'progress',
    requestId: request.requestId, identity, phase: 'accepted' })]));
  const runtime = result.runtime as { pid: number; startedAt: number };
  expect(runtime.pid).toBeGreaterThan(0);
  expect(runtime.startedAt).toBeGreaterThan(0);
  const processIdentity = readProcessIdentity(runtime.pid);
  expect(processIdentity).toBeTruthy();
  const receipt = { observedAt: new Date().toISOString(), socketPath, request, identity,
    progress, result, processIdentity };
  Object.assign(context.task.meta, { papercuspFocusedServiceReceipt: receipt });
  console.info('FRICTION_FOCUSED_SERVICE_RECEIPT ' + JSON.stringify(receipt));
}, 40_000);
