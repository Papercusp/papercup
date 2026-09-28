/**
 * WI-10003621 recurrence guard: the inference gateway binds 127.0.0.1 and has no caller
 * auth, so on a hosted workspace host (where the customer account shares loopback) a
 * non-service uid must be refused before ANY route runs — inference and `/admin/*` alike.
 * Measured on avi-test r56 from the customer uid: `/admin/stats|config|route|owner-report|stalls`
 * all answered 200.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createInferenceGateway } from './gateway';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

function start(foreign: boolean, seen: number[] = []) {
  gateway = createInferenceGateway({
    accountId: 'test-account',
    token: async () => 'test-token',
    proactiveEgressProbeMs: 0,
    selfHeal: { enabled: false },
    loopbackPeerGate: (socket) => {
      seen.push(socket.remotePort ?? -1);
      return foreign ? { uid: 1001, reason: 'uid-mismatch' } : null;
    },
  });
  return gateway.listen(0);
}

describe('inference-gateway loopback peer-uid gate', () => {
  it('refuses a foreign loopback peer on admin reads, admin writes and inference with 403', async () => {
    const seen: number[] = [];
    const port = await start(true, seen);
    const base = 'http://127.0.0.1:' + port;
    for (const [method, path] of [
      ['GET', '/admin/stats'],
      ['GET', '/admin/config'],
      ['POST', '/admin/reload'],
      ['POST', '/v1/messages'],
    ] as const) {
      const response = await fetch(base + path, {
        method,
        ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { type: 'permission_error' },
        reason: 'uid-mismatch',
        gateway: true,
      });
    }
    // The gate saw the real accepted socket, not a placeholder.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((p) => p > 0)).toBe(true);
  });

  it('serves the service uid unchanged (positive control)', async () => {
    const port = await start(false);
    const response = await fetch('http://127.0.0.1:' + port + '/admin/stats');
    expect(response.status).toBe(200);
  });
});
