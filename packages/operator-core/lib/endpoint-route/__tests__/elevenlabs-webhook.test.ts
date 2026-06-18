/**
 * EL webhook handler behavior (routes/elevenlabs/webhook.ts + post-call.ts).
 * The HMAC *auth helper* is covered by elevenlabs-webhook-auth.test.ts; this
 * suite covers the HANDLERS:
 *   - webhook.ts: server-side tool dispatch through the action registry —
 *     signature gate, payload parsing (flat + data-wrapped), registry lookup,
 *     and routing (deliver-to-tab for browser:'required' commands, runCommand
 *     for server commands, runQuery for queries) with the EL dynamic_variables
 *     mapped onto the CommandContext.
 *   - post-call.ts: its own HMAC verify + early-exit branches (secret missing,
 *     bad sig, bad json, no conversation_id, no matching conversation) and the
 *     transcription persistence path, driven with a fake org-PG.
 *
 * P-005 of plan voice-production-test-coverage-2026-06-01.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── webhook.ts dependencies ────────────────────────────────────────────────
vi.mock('../../elevenlabs-webhook-auth', () => ({
  verifyElevenLabsSignature: vi.fn(() => ({ ok: true })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
const get = vi.fn();
// `...args` makes each mock's `.mock.calls[N]` a variadic tuple, so the assertions below that
// index `calls[0][0..2]` type-check (the bare `() =>` form inferred a 0-arg empty-tuple call).
const runCommand = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'command' }));
const runQuery = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'query' }));
const deliver = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'tab' }));
vi.mock('../../commands/registry', () => ({
  get: (...a: unknown[]) => get(...(a as [])),
  runCommand: (...a: unknown[]) => runCommand(...(a as [])),
  runQuery: (...a: unknown[]) => runQuery(...(a as [])),
}));
vi.mock('../../commands/session-registry', () => ({ deliver: (...a: unknown[]) => deliver(...(a as [])) }));
vi.mock('../../commands/audit-server', () => ({}));
vi.mock('../../commands/defs', () => ({}));

// ── post-call.ts dependencies (fake org-PG) ────────────────────────────────
let selectResult: Array<{ conversation_id: string }> = [];
const sqlMock = vi.fn(() => Promise.resolve([] as unknown[]));
function thenable(resolve: () => unknown): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(resolve());
      return () => thenable(resolve);
    },
    apply() {
      return thenable(resolve);
    },
  });
}
const fakeDb = {
  selectDistinct: () => thenable(() => selectResult),
  update: () => thenable(() => []),
};
// Partial mock: keep every real export (agent-mcp's bootstrap needs schemaOf +
// generated at import time) and override only getOrgPg so no real PG is opened.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: fakeDb, sql: sqlMock }) };
});

import webhookTool from '../routes/elevenlabs/webhook';
import postCallTool from '../routes/elevenlabs/post-call';
import { verifyElevenLabsSignature } from '../../elevenlabs-webhook-auth';

type Json = Record<string, unknown>;

function webhookReq(payload: unknown, opts: { body?: string } = {}): Request {
  return new Request('http://localhost/api/elevenlabs/webhook', {
    method: 'POST',
    headers: { 'elevenlabs-signature': 'sig-placeholder' },
    body: opts.body ?? JSON.stringify(payload),
  });
}

async function callWebhook(payload: unknown, opts: { body?: string } = {}) {
  const res = await webhookTool.handler(webhookReq(payload, opts), {} as never);
  return { res, body: (await res.json()) as Json };
}

beforeEach(() => {
  vi.mocked(verifyElevenLabsSignature).mockReturnValue({ ok: true } as never);
  get.mockReset();
  runCommand.mockClear();
  runQuery.mockClear();
  deliver.mockClear();
});

describe('POST /elevenlabs/webhook — server-side tool dispatch', () => {
  it('401 when the signature check fails', async () => {
    vi.mocked(verifyElevenLabsSignature).mockReturnValue({ ok: false, reason: 'bad-mac' } as never);
    const { res, body } = await callWebhook({ tool_name: 'panel.open' });
    expect(res.status).toBe(401);
    expect((body.error as Json).code).toBe('auth');
  });

  it('400 invalid-json when the body is not JSON (signature ok)', async () => {
    const { res, body } = await callWebhook(null, { body: 'not json {' });
    expect(res.status).toBe(400);
    expect((body.error as Json).code).toBe('invalid-json');
  });

  it('400 no-tool when tool_name is missing', async () => {
    const { res, body } = await callWebhook({ parameters: {} });
    expect(res.status).toBe(400);
    expect((body.error as Json).code).toBe('no-tool');
  });

  it('404 unknown-tool when the registry has no such tool', async () => {
    get.mockReturnValue(undefined);
    const { res, body } = await callWebhook({ tool_name: 'does.not.exist' });
    expect(res.status).toBe(404);
    expect((body.error as Json).code).toBe('unknown-tool');
  });

  it("routes a browser:'required' command to deliver-to-tab", async () => {
    get.mockReturnValue({ kind: 'command', browser: 'required' });
    const { body } = await callWebhook({
      tool_name: 'panel.open',
      parameters: { side: 'left' },
      dynamic_variables: { workspace_id: 'ws-phone' },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe('ws-phone'); // workspace from dynamic_variables
    expect(deliver.mock.calls[0][1]).toEqual({ id: 'panel.open', args: { side: 'left' } });
    expect(runCommand).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, ran: 'tab' });
  });

  it('routes a server-side command to runCommand with the mapped CommandContext', async () => {
    get.mockReturnValue({ kind: 'command', browser: 'optional' });
    await callWebhook({
      tool_name: 'scan.workspace',
      parameters: { deep: true },
      dynamic_variables: { workspace_id: 'ws-x', surface: 'mobile-ios', device_id: 'dev-7' },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toBe('scan.workspace');
    expect(runCommand.mock.calls[0][1]).toEqual({ deep: true });
    expect(runCommand.mock.calls[0][2]).toMatchObject({
      agent: 'operator',
      workspace: 'ws-x',
      surface: 'mobile-ios',
      deviceId: 'dev-7',
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('routes a query to runQuery', async () => {
    get.mockReturnValue({ kind: 'query' });
    const { body } = await callWebhook({ tool_name: 'status.summary', parameters: {} });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toBe('status.summary');
    expect(body).toEqual({ ok: true, ran: 'query' });
  });

  it('accepts the data-wrapped payload shape (tool_name + parameters under data)', async () => {
    get.mockReturnValue({ kind: 'query' });
    await callWebhook({ data: { tool_name: 'status.summary', parameters: { q: 1 } } });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][1]).toEqual({ q: 1 });
  });

  it('falls back to activeWorkspaceId() when dynamic_variables has no workspace_id', async () => {
    get.mockReturnValue({ kind: 'query' });
    await callWebhook({ tool_name: 'status.summary' });
    expect(runQuery.mock.calls[0][2]).toMatchObject({ workspace: 'ws-active' });
  });

  it('leaves surface undefined for an unrecognized surface value', async () => {
    get.mockReturnValue({ kind: 'command', browser: 'optional' });
    await callWebhook({ tool_name: 'x.y', dynamic_variables: { surface: 'smartwatch' } });
    expect(runCommand.mock.calls[0][2]).toMatchObject({ surface: undefined });
  });
});

describe('POST /elevenlabs/post-call — receiver', () => {
  const SECRET = 'post-call-secret-0123456789abcdef';

  function sign(rawBody: string, tSec = Math.floor(Date.now() / 1000)): string {
    const v0 = crypto.createHmac('sha256', SECRET).update(`${tSec}.${rawBody}`).digest('hex');
    return `t=${tSec},v0=${v0}`;
  }
  function postCallReq(payload: unknown, opts: { sig?: string | null; body?: string } = {}): Request {
    const body = opts.body ?? JSON.stringify(payload);
    const headers: Record<string, string> = {};
    const sig = opts.sig === undefined ? sign(body) : opts.sig;
    if (sig) headers['elevenlabs-signature'] = sig;
    return new Request('http://localhost/api/elevenlabs/post-call', { method: 'POST', headers, body });
  }
  async function callPostCall(payload: unknown, opts: { sig?: string | null; body?: string } = {}) {
    const res = await postCallTool.handler(postCallReq(payload, opts), {} as never);
    return { res, body: (await res.json()) as Json };
  }

  beforeEach(() => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET;
    selectResult = [];
    sqlMock.mockClear();
    sqlMock.mockReturnValue(Promise.resolve([]));
    // post-call logs on the reject paths; silence so they don't add stderr
    // noise (and stay safe if a config enables fail-on-console).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it('503 when the webhook secret is not configured', async () => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    const { res } = await callPostCall({ type: 'post_call_transcription', data: { conversation_id: 'el-1' } });
    expect(res.status).toBe(503);
  });

  it('401 on a missing / invalid signature', async () => {
    const { res } = await callPostCall({ type: 'x', data: {} }, { sig: null });
    expect(res.status).toBe(401);
  });

  it('401 on a stale timestamp (outside the 5-min tolerance)', async () => {
    const body = JSON.stringify({ type: 'x', data: {} });
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const { res } = await callPostCall(null, { body, sig: sign(body, staleTs) });
    expect(res.status).toBe(401);
  });

  it('400 on invalid JSON with a valid signature', async () => {
    const { res } = await callPostCall(null, { body: 'not-json' });
    expect(res.status).toBe(400);
  });

  it('returns received:true with a note when there is no conversation_id', async () => {
    const { body } = await callPostCall({ type: 'post_call_transcription', data: {} });
    expect(body).toMatchObject({ received: true, note: 'no conversation_id' });
  });

  it('returns received:true with a note when no local conversation matches', async () => {
    selectResult = [];
    const { body } = await callPostCall({
      type: 'post_call_transcription',
      data: { conversation_id: 'el-unmatched' },
    });
    expect(body).toMatchObject({ received: true, note: 'no matching conversation' });
  });

  it('persists a matched transcription (UPDATE conversation + INSERT el_conv_calls) and acks', async () => {
    selectResult = [{ conversation_id: 'our-1' }];
    const { body } = await callPostCall({
      type: 'post_call_transcription',
      data: { conversation_id: 'el-42', agent_id: 'agent-x', metadata: { call_duration_secs: 42 }, has_audio: true },
    });
    expect(body).toEqual({ received: true });
    // ran the UPDATE conversation + INSERT el_conv_calls tagged-template queries
    expect(sqlMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
