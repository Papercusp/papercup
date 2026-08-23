import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  intakeWorkOsWebhook,
  parseWorkOsWebhookEvent,
  verifyWorkOsWebhookSignature,
  WorkOsWebhookIntakeError,
  WorkOsWebhookReceiptStore,
  type VerifiedWorkOsWebhookEvent,
  type WorkOsWebhookReceiptSink,
} from './workos-webhook-intake';

const SECRET = 'whsec_test_never_log_this';
const NOW = new Date('2026-08-23T12:00:00.000Z');

function signature(body: string, at = NOW, secret = SECRET): string {
  const timestamp = String(at.getTime());
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function byteSignature(body: Uint8Array, at = NOW, secret = SECRET): string {
  const timestamp = String(at.getTime());
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://app.papercusp.com/api/auth/workos/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body,
  });
}

function eventJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'event_01',
    event: 'organization_membership.created',
    created_at: '2026-08-23T11:59:59.000Z',
    context: { organization_id: 'org_workos_01' },
    data: { id: 'membership_workos_01', organization_id: 'org_workos_01', version: 7 },
    ...overrides,
  });
}

async function captureIntake(body: string, extraHeaders: Record<string, string> = {}) {
  const enqueue = vi.fn<WorkOsWebhookReceiptSink['enqueue']>().mockResolvedValue({ deduplicated: false });
  const result = await intakeWorkOsWebhook({
    request: request(body, { 'workos-signature': signature(body), ...extraHeaders }),
    secret: SECRET,
    receiptSink: { enqueue },
    now: NOW,
  });
  return { result, enqueue };
}

describe('WorkOS webhook authentication and parsing', () => {
  it('verifies the exact raw body, preserves whitespace, and derives only provider-scoped refs', async () => {
    const body = ` { "id": "event_01", "event": "user.updated", "created_at": "2026-08-23T11:59:59Z", "context": { "organization_id": "org_workos_01" }, "data": { "id": "user_workos_01", "version": 4, "tenant_id": "tenant_attacker", "workspace_id": "workspace_attacker", "capabilities": ["*"] }, "tenant_id": "tenant_root", "workspace_id": "workspace_root" }\n`;
    const { result, enqueue } = await captureIntake(body);

    expect(result).toMatchObject({
      eventId: 'event_01',
      eventType: 'user.updated',
      providerAccountId: 'org_workos_01',
      subjectRef: 'user_workos_01',
      eventVersion: '4',
      deduplicated: false,
    });
    const queued = enqueue.mock.calls[0][0];
    expect(queued.payload).toMatchObject({ tenant_id: 'tenant_root', workspace_id: 'workspace_root' });
    expect(queued).not.toHaveProperty('tenantId');
    expect(queued).not.toHaveProperty('workspaceId');
    expect(queued).not.toHaveProperty('capabilities');
  });

  it('verifies exact request bytes without losing a leading UTF-8 BOM', async () => {
    const json = eventJson();
    const encoded = new TextEncoder().encode(json);
    const body = new Uint8Array(encoded.byteLength + 3);
    body.set([0xef, 0xbb, 0xbf]);
    body.set(encoded, 3);
    const enqueue = vi.fn<WorkOsWebhookReceiptSink['enqueue']>().mockResolvedValue({
      deduplicated: false,
    });

    await expect(
      intakeWorkOsWebhook({
        request: request(body, { 'workos-signature': byteSignature(body) }),
        secret: SECRET,
        receiptSink: { enqueue },
        now: NOW,
      }),
    ).resolves.toMatchObject({ eventId: 'event_01' });
  });

  it('accepts any matching v1 during secret rotation and rejects tampering or malformed signatures', () => {
    const body = eventJson();
    const valid = signature(body);
    const validDigest = valid.slice(valid.indexOf('v1=') + 3);
    expect(() =>
      verifyWorkOsWebhookSignature({
        rawBody: body,
        signatureHeader: `t=${NOW.getTime()},v1=${'0'.repeat(64)},v1=${validDigest}`,
        secret: SECRET,
        nowMs: NOW.getTime(),
      }),
    ).not.toThrow();

    for (const signatureHeader of [
      null,
      'not-a-signature',
      `t=${NOW.getTime()},v1=xyz`,
      `t=${NOW.getTime()},v1=${'0'.repeat(64)}`,
    ]) {
      expect(() =>
        verifyWorkOsWebhookSignature({
          rawBody: body,
          signatureHeader,
          secret: SECRET,
          nowMs: NOW.getTime(),
        }),
      ).toThrow(WorkOsWebhookIntakeError);
    }
    expect(() =>
      verifyWorkOsWebhookSignature({
        rawBody: `${body} `,
        signatureHeader: valid,
        secret: SECRET,
        nowMs: NOW.getTime(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_signature' }));
  });

  it('rejects stale signatures and fails closed when the secret is absent', () => {
    const body = eventJson();
    const stale = new Date(NOW.getTime() - 5 * 60_000 - 1);
    expect(() =>
      verifyWorkOsWebhookSignature({
        rawBody: body,
        signatureHeader: signature(body, stale),
        secret: SECRET,
        nowMs: NOW.getTime(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'stale_signature', status: 401 }));
    expect(() =>
      verifyWorkOsWebhookSignature({
        rawBody: body,
        signatureHeader: signature(body),
        secret: undefined,
        nowMs: NOW.getTime(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'configuration_error', status: 503 }));
  });

  it('checks media type, encoding, declared size, actual size, UTF-8, and JSON shape', async () => {
    const body = eventJson();
    const cases: Array<[Request, string]> = [
      [
        request(body, { 'content-type': 'text/plain', 'workos-signature': signature(body) }),
        'unsupported_content_type',
      ],
      [
        request(body, { 'content-encoding': 'gzip', 'workos-signature': signature(body) }),
        'unsupported_content_encoding',
      ],
      [request(body, { 'content-length': '12x', 'workos-signature': signature(body) }), 'invalid_content_length'],
      [request(body, { 'content-length': '1025', 'workos-signature': signature(body) }), 'payload_too_large'],
      [
        request(`${body}${' '.repeat(1024)}`, { 'workos-signature': signature(`${body}${' '.repeat(1024)}`) }),
        'payload_too_large',
      ],
      [request(new Uint8Array([0xc3, 0x28]), { 'workos-signature': 'ignored' }), 'invalid_utf8'],
    ];
    for (const [req, code] of cases) {
      await expect(
        intakeWorkOsWebhook({
          request: req,
          secret: SECRET,
          receiptSink: { enqueue: vi.fn() },
          now: NOW,
          maxBodyBytes: 1024,
        }),
      ).rejects.toMatchObject({ code });
    }

    const invalidJson = '{"id":';
    await expect(
      intakeWorkOsWebhook({
        request: request(invalidJson, { 'workos-signature': signature(invalidJson) }),
        secret: SECRET,
        receiptSink: { enqueue: vi.fn() },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
    expect(() => parseWorkOsWebhookEvent(JSON.stringify({ id: 'x', event: 'x', data: {} }))).toThrowError(
      expect.objectContaining({ code: 'invalid_event' }),
    );
  });

  it('authenticates before parsing so an unverified malformed body reveals no parser result', async () => {
    const body = '{"id":';
    await expect(
      intakeWorkOsWebhook({
        request: request(body, { 'workos-signature': signature(body, NOW, 'wrong-secret') }),
        secret: SECRET,
        receiptSink: { enqueue: vi.fn() },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });
});

describe('WorkOsWebhookReceiptStore', () => {
  const parsed = (): VerifiedWorkOsWebhookEvent => parseWorkOsWebhookEvent(eventJson());

  function mockSql(responses: unknown[][]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return responses.shift() ?? [];
    });
    return { sql: sql as never, calls };
  }

  it('persists the verified receipt as a real jsonb object before reporting acceptance', async () => {
    const event = parsed();
    const { sql, calls } = mockSql([[{ payload_sha256: event.payloadSha256 }]]);
    const store = new WorkOsWebhookReceiptStore(sql, () => NOW);

    await expect(store.enqueue(event, { signatureKeyRef: 'workos-key-2026-08' })).resolves.toEqual({
      deduplicated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('ON CONFLICT (provider, event_id) DO NOTHING');
    expect(calls[0].text).toContain('::text::jsonb');
    expect(calls[0].values).toContain(JSON.stringify(event.payload));
    expect(calls[0].values).not.toContain(SECRET);
  });

  it('acknowledges an exact digest duplicate and rejects an id collision', async () => {
    const event = parsed();
    const duplicate = mockSql([[], [{ payload_sha256: event.payloadSha256 }]]);
    await expect(new WorkOsWebhookReceiptStore(duplicate.sql, () => NOW).enqueue(event)).resolves.toEqual({
      deduplicated: true,
    });

    const collision = mockSql([[], [{ payload_sha256: 'f'.repeat(64) }]]);
    await expect(new WorkOsWebhookReceiptStore(collision.sql, () => NOW).enqueue(event)).rejects.toMatchObject({
      code: 'receipt_collision',
      status: 409,
    });
  });
});
