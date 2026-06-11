/**
 * P-028 (production-readiness-test-coverage) — `agent-tools/flags` (get / list /
 * set). Operator-side MCP tools tested by importing each tool's `handler`
 * directly and asserting the projected `content[0].text` payload + that the
 * mocked flag-server helpers are called correctly. The dispatcher (role gates,
 * quota, telemetry) is covered in @papercusp/agent-mcp's own tests; this only
 * validates handler behavior given mocked lib helpers.
 *
 * flags:set is the high-tier one: it must publish a flag-change on success,
 * NOT publish on a backend failure (and flag isError), and best-effort the
 * audit-log insert without letting an insert failure mask the successful flip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_FLAG_KEYS } from '@papercusp/flags';

const KEY = ALL_FLAG_KEYS[0];

const getFlag = vi.fn();
const getAllFlags = vi.fn();
const setFlag = vi.fn();
const publishFlagChange = vi.fn();
const resolveDistinctId = vi.fn(() => 'did-test');
const recordFlagAudit = vi.fn(async () => {});

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'papercup',
    role: 'operator' as const,
    tx: null,
    ...over,
  } as never);

function parseTextPayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@papercusp/flags/server', () => ({ getFlag, getAllFlags, setFlag }));
  vi.doMock('../../../flag-bus', () => ({ publishFlagChange }));
  vi.doMock('../../../flag-distinct-id', () => ({ resolveDistinctId }));
  // flags:set now writes its audit row via recordFlagAudit (getOrgPg → real
  // PG, EI-293) — stub it so these hermetic handler tests never touch a DB.
  vi.doMock('../../../flag-audit', () => ({ recordFlagAudit }));
  getFlag.mockResolvedValue(false);
  getAllFlags.mockResolvedValue({});
  setFlag.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../../flag-bus');
  vi.doUnmock('../../../flag-distinct-id');
  vi.doUnmock('../../../flag-audit');
});

describe('flags:get', () => {
  it('resolves a flag via getFlag(key, distinctId) and wraps {key, enabled}', async () => {
    getFlag.mockResolvedValue(true);
    const { default: tool } = await import('../get');
    const result = await tool.handler({ key: KEY }, MAKE_CTX());
    expect(getFlag).toHaveBeenCalledWith(KEY, 'did-test');
    expect(parseTextPayload(result as never)).toEqual({ key: KEY, enabled: true });
  });

  it('reflects a disabled flag', async () => {
    getFlag.mockResolvedValue(false);
    const { default: tool } = await import('../get');
    const result = await tool.handler({ key: KEY }, MAKE_CTX());
    expect(parseTextPayload(result as never)).toEqual({ key: KEY, enabled: false });
  });
});

describe('flags:list', () => {
  it('wraps getAllFlags output and always includes the full key list', async () => {
    getAllFlags.mockResolvedValue({ [KEY]: true });
    const { default: tool } = await import('../list');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parseTextPayload(result as never);
    expect(payload.keys).toEqual([...ALL_FLAG_KEYS]);
    expect(payload[KEY]).toBe(true);
    expect(getAllFlags).toHaveBeenCalledWith('did-test');
  });
});

describe('flags:set', () => {
  it('flips a flag, publishes the change, and returns {ok:true}', async () => {
    setFlag.mockResolvedValue({ ok: true });
    const { default: tool } = await import('../set');
    const result = await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX());
    expect(setFlag).toHaveBeenCalledWith(KEY, true);
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
    expect(parseTextPayload(result as never)).toEqual({ ok: true, key: KEY, enabled: true });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('on backend failure: flags isError, forwards the reason, and does NOT publish', async () => {
    setFlag.mockResolvedValue({ ok: false, reason: 'posthog_unconfigured' });
    const { default: tool } = await import('../set');
    const result = await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX());
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parseTextPayload(result as never)).toEqual({ ok: false, reason: 'posthog_unconfigured', key: KEY });
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('records the flag audit with the principal slug as actor (EI-293)', async () => {
    const { default: tool } = await import('../set');
    await tool.handler(
      { key: KEY, enabled: false, reason: 'disable for V1' },
      MAKE_CTX({ principal: { slug: 'agent-x' } }),
    );
    // recordFlagAudit is the single correct writer (replaced the inline
    // ctx.tx INSERT that omitted id + workspace_id and silently failed).
    expect(recordFlagAudit).toHaveBeenCalledWith(KEY, false, 'agent-x', { reason: 'disable for V1' });
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
  });

  it("falls back to actor 'agent' when no principal is present", async () => {
    const { default: tool } = await import('../set');
    await tool.handler({ key: KEY, enabled: true, reason: 'enable it' }, MAKE_CTX());
    expect(recordFlagAudit).toHaveBeenCalledWith(KEY, true, 'agent', { reason: 'enable it' });
  });
  // recordFlagAudit's best-effort "never throws even on a write failure"
  // contract is covered against a real dead connection in
  // flag-audit.integration.test.ts (it's mocked here).
});
