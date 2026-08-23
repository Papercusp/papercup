import { describe, expect, it, vi } from 'vitest';
import { WorkOsWebhookIntakeError, type WorkOsWebhookReceiptResult } from '../../../auth/hosted/workos-webhook-intake';
import { createWorkOsWebhookRoute, type WorkOsWebhookLogger } from './workos-webhook';

const RECEIPT: WorkOsWebhookReceiptResult = {
  eventId: 'event_01',
  eventType: 'user.updated',
  eventCreatedAt: new Date('2026-08-23T12:00:00.000Z'),
  providerAccountId: 'org_workos_01',
  subjectRef: 'user_workos_01',
  eventVersion: '4',
  payload: {
    id: 'event_01',
    event: 'user.updated',
    created_at: '2026-08-23T12:00:00.000Z',
    data: { id: 'user_workos_01' },
  },
  payloadSha256: 'a'.repeat(64),
  deduplicated: true,
};

function request(): Request {
  return new Request('https://app.papercusp.com/api/auth/workos/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'workos-signature': 't=secret-timestamp,v1=secret-signature',
    },
    body: '{"password":"body-must-not-be-logged"}',
  });
}

function logger() {
  return {
    info: vi.fn<WorkOsWebhookLogger['info']>(),
    warn: vi.fn<WorkOsWebhookLogger['warn']>(),
  };
}

async function invoke(route: ReturnType<typeof createWorkOsWebhookRoute>): Promise<Response> {
  return (await route.handler(request(), {} as never)) as Response;
}

describe('POST /api/auth/workos/webhook', () => {
  it('is a public signature-authenticated route and acknowledges a durable duplicate with 200', async () => {
    const logs = logger();
    const intake = vi.fn().mockResolvedValue(RECEIPT);
    const route = createWorkOsWebhookRoute({
      intake,
      secret: () => 'whsec_route_test',
      signatureKeyRef: () => 'key-ref-test',
      logger: logs,
    });

    const response = await invoke(route);
    expect(route).toMatchObject({ method: 'POST', path: '/auth/workos/webhook', auth: 'public' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      event_id: 'event_01',
      event_type: 'user.updated',
      deduplicated: true,
    });
    expect(intake).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: 'whsec_route_test',
        signatureKeyRef: 'key-ref-test',
      }),
    );
    expect(logs.info).toHaveBeenCalledWith('[auth/workos-webhook] accepted', {
      code: 'accepted',
      eventId: 'event_01',
      eventType: 'user.updated',
      deduplicated: true,
    });
  });

  it('returns 503 when durable enqueue fails and exposes only a safe code', async () => {
    const logs = logger();
    const route = createWorkOsWebhookRoute({
      intake: vi.fn().mockRejectedValue(new Error('postgres://secret@host body-must-not-be-logged')),
      secret: () => 'whsec_route_test',
      logger: logs,
    });

    const response = await invoke(route);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: 'enqueue_failed', retryable: true },
    });
    expect(logs.warn).toHaveBeenCalledWith('[auth/workos-webhook] rejected', {
      code: 'enqueue_failed',
      retryable: true,
    });
  });

  it('preserves typed client failures and never logs the secret, signature, body, or raw cause', async () => {
    const logs = logger();
    const route = createWorkOsWebhookRoute({
      intake: vi.fn().mockRejectedValue(new WorkOsWebhookIntakeError('invalid_signature', 401, false, 'safe message')),
      secret: () => 'whsec_route_test',
      logger: logs,
    });

    const response = await invoke(route);
    expect(response.status).toBe(401);
    const renderedLogs = JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls]);
    expect(renderedLogs).toContain('invalid_signature');
    expect(renderedLogs).not.toContain('whsec_route_test');
    expect(renderedLogs).not.toContain('secret-signature');
    expect(renderedLogs).not.toContain('body-must-not-be-logged');
    expect(renderedLogs).not.toContain('safe message');
  });
});
