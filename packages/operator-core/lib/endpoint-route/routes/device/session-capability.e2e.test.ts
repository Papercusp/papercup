/**
 * Real pairing and per-device session authority against the maintained current-build API.
 * Opt in with PAPERCUSP_DEVICE_SESSIONS_LIVE_API and PAPERCUSP_TEST_RUN_WORKSPACE.
 * Uses one private device and a nonexistent session; never sends to or ends a real agent.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../../../sensitive-text';

const base = process.env.PAPERCUSP_DEVICE_SESSIONS_LIVE_API;
const workspaceId = process.env.PAPERCUSP_TEST_RUN_WORKSPACE;

type Reply = { status: number; data: Record<string, any> };

function diagnostic(reply: Reply): string {
  // Pairing replies carry credentials. Never serialize a response wholesale.
  return redactSensitiveText(JSON.stringify({ status: reply.status,
    error: reply.data.error, code: reply.data.code, message: reply.data.message }));
}

describe.skipIf(!base)('paired-device sessions on the current-build API', () => {
  it('refuses every unauthorized door, serves the granted roster and refuses immediately after revocation', async () => {
    expect(workspaceId, 'Select the private-fixture workspace explicitly').toBeTruthy();
    const api = new URL(base!);
    expect(api.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost']).toContain(api.hostname);
    // The live release is reserved for final shipment verification.
    expect(api.port).not.toBe('3070');
    expect(api.pathname.replace(/\/$/, '')).toBe('/api');

    const request = async (path: string, method = 'GET', token?: string, body?: object): Promise<Reply> => {
      const response = await fetch(base!.replace(/\/$/, '') + path, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, data: await response.json() };
    };
    const expectedSha = process.env.PAPERCUSP_DEVICE_SESSIONS_EXPECTED_SHA;
    expect(expectedSha, 'Pin the measured containing operator build').toMatch(/^[a-f0-9]{10,40}$/);
    const health = await request('/health');
    expect(health.status, diagnostic(health)).toBe(200);
    expect(health.data.bundleStale).toBeUndefined();
    expect(health.data.sha).toBe(expectedSha);
    console.log(`DEVICE_SESSIONS_RUNTIME=${JSON.stringify({ api: api.origin,
      sha: health.data.sha, at: health.data.ts })}`);
    const absentOwner = `su-mobile-private-absent-${randomUUID()}`;
    const doors = [
      ['GET', '/device/sessions'],
      ['GET', `/device/sessions/${absentOwner}/transcript`],
      ['GET', `/device/sessions/${absentOwner}/transcript?stream=1`],
      ['POST', `/device/sessions/${absentOwner}/messages`],
      ['POST', `/device/sessions/${absentOwner}/end`],
      ['GET', '/device/rest-query?name=deviceSessions.list&args=%7B%7D'],
    ] as const;
    const probe = (method: string, path: string, token?: string) => request(path, method, token,
      method === 'POST' ? { text: 'private capability probe', idempotencyKey: randomUUID() } : undefined);
    let deviceId: string | undefined;
    try {
      for (const [method, path] of doors) {
        for (const token of [undefined, 'invalid-device-jwt']) {
          const reply = await probe(method, path, token);
          expect([401, 403], `${method} ${path}: ${diagnostic(reply)}`).toContain(reply.status);
        }
      }
      const mint = await request('/device/desktop/mint-pair-token', 'POST', undefined, { workspaceId });
      expect(mint.status, diagnostic(mint)).toBe(200);
      const pair = await request('/device/pair', 'POST', undefined, { pairToken: mint.data.qrPayload.pairToken });
      deviceId = pair.data.deviceId;
      expect(pair.status, diagnostic(pair)).toBe(200);
      expect(typeof deviceId).toBe('string');
      expect(typeof pair.data.deviceToken).toBe('string');
      const token = pair.data.deviceToken as string;
      const grant = (enabled: boolean) => request(`/device/desktop/devices/${deviceId}/agent-sessions`,
        'POST', undefined, { workspaceId, enabled });
      for (const [method, path] of doors) {
        const reply = await probe(method, path, token);
        expect(reply.status, `${path}: ${diagnostic(reply)}`).toBe(403);
      }
      const enabled = await grant(true);
      expect(enabled.status, diagnostic(enabled)).toBe(200);
      for (const [method, path] of doors) {
        const reply = await probe(method, path, token);
        // Targeted actions must reach the workspace guard and refuse the nonce owner.
        const expected = path.includes(absentOwner) ? 404 : 200;
        expect(reply.status, `${path}: ${diagnostic(reply)}`).toBe(expected);
        if (path === '/device/sessions') expect(Array.isArray(reply.data.sessions)).toBe(true);
        if (path.startsWith('/device/rest-query')) expect(Array.isArray(reply.data.rows)).toBe(true);
      }
      const disabled = await grant(false);
      expect(disabled.status, diagnostic(disabled)).toBe(200);
      for (const [method, path] of doors) {
        const reply = await probe(method, path, token);
        expect(reply.status, `${path}: ${diagnostic(reply)}`).toBe(403);
      }
      const after = await request('/health');
      expect(after.status, diagnostic(after)).toBe(200);
      expect(after.data.sha, 'The serving build must remain pinned for the entire journey').toBe(health.data.sha);
      expect(after.data.bundleStale).toBeUndefined();
    } finally {
      if (deviceId) {
        const cleanup = await request(`/device/desktop/devices/${deviceId}`, 'DELETE');
        expect(cleanup.status, diagnostic(cleanup)).toBe(200);
      }
    }
  }, 180_000);
});
