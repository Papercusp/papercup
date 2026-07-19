/**
 * run-tool.test.ts — POST /api/agent-mcp/run-tool (EI-1751's callerSid pass-
 * through). `isLoopbackRequest` + `invokeServerCapability` are mocked; this
 * pins the route's own shaping: `callerSid` is forwarded ONLY when it is a
 * non-empty string, trimmed, and hard-capped at 128 chars — never passed
 * through raw, and never required (an absent/non-string callerSid omits the
 * field entirely so invokeServerCapability's own `?? null` default applies).
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/agent-mcp/run-tool.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: vi.fn(() => true) }));
vi.mock('../../../agent-tools', () => ({}));
vi.mock('../../../capabilities/invoke', () => ({ invokeServerCapability: vi.fn() }));

import { invokeServerCapability } from '../../../capabilities/invoke';
const invokeM = vi.mocked(invokeServerCapability);
const tool = (await import('./run-tool')).default;

function req(body: unknown): Parameters<typeof tool.handler>[0] {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof tool.handler>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeM.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
});

describe('POST /agent-mcp/run-tool — callerSid shaping', () => {
  it('no callerSid in the body ⇒ omits the field entirely', async () => {
    await tool.handler(req({ name: 't:x' }));
    expect(invokeM).toHaveBeenCalledWith({ name: 't:x', args: undefined, confirmed: false });
  });

  it('a plain string callerSid is forwarded trimmed', async () => {
    await tool.handler(req({ name: 't:x', callerSid: '  pui-4242  ' }));
    expect(invokeM).toHaveBeenCalledWith(
      expect.objectContaining({ callerSid: 'pui-4242' }),
    );
  });

  it('a non-string callerSid is dropped, not coerced', async () => {
    await tool.handler(req({ name: 't:x', callerSid: 12345 }));
    const call = invokeM.mock.calls[0]![0];
    expect(call).not.toHaveProperty('callerSid');
  });

  it('an oversized callerSid is hard-capped at 128 chars', async () => {
    const long = 'x'.repeat(500);
    await tool.handler(req({ name: 't:x', callerSid: long }));
    const call = invokeM.mock.calls[0]![0] as { callerSid?: string };
    expect(call.callerSid).toHaveLength(128);
  });

  it('a blank/whitespace-only callerSid is treated as absent', async () => {
    await tool.handler(req({ name: 't:x', callerSid: '   ' }));
    const call = invokeM.mock.calls[0]![0];
    expect(call).not.toHaveProperty('callerSid');
  });
});
