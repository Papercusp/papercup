// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManagedCarryResponse,
  preCompactDecision,
  runManagedPreCompact,
  isDirectCliInvocation,
  inspectCodexTranscript,
} from '../precompact-managed-carry.mjs';

const PAYLOAD = {
  hook_event_name: 'PreCompact',
  trigger: 'auto',
  session_id: 'native-1',
  turn_id: 'turn-1',
};
const ENV = {
  PAPERCUSP_MCP_URL:
    'http://127.0.0.1:3070/api/mcp?role=worker&sig=SIGNED&client=role-1',
  PAPERCUSP_SID: 'role-1',
  PAPERCUSP_HARNESS_SLUG: 'papercusp',
};

function rpc(
  inner: Record<string, unknown>,
  isError = false,
  resultExtra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError,
      content: [{ type: 'text', text: JSON.stringify(inner) }],
      ...resultExtra,
    },
  });
}

describe('managed Codex PreCompact bridge', () => {
  it('loads as an installed hook from an unrelated cwd without operator-core resolution', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'managed-carry-hook-cwd-'));
    try {
      const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(new URL('../precompact-managed-carry.mjs', import.meta.url).href)})`], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PAPERCUSP_MCP_URL: '', PAPERCUSP_SID: '' },
      });
      expect(out).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses a basename-pinned direct-entry check for the verbatim installed copy', () => {
    expect(isDirectCliInvocation(join(homedir(), '.papercusp/hooks/cc/precompact-managed-carry.mjs'))).toBe(true);
    expect(isDirectCliInvocation('/tmp/other-hook.mjs')).toBe(false);
  });

  it('queues session:request-compaction on the exact signed route and vetoes native compaction', async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedRequest: RequestInit | undefined;
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, request?: RequestInit) => {
        capturedUrl = url;
        capturedRequest = request;
        return new Response(
          rpc({ ok: true, requested: true, respawn: 'queued' }),
          { status: 200 },
        );
      },
    );
    const decision = await runManagedPreCompact(PAYLOAD, { env: ENV, fetchImpl });

    expect(decision.continue).toBe(false);
    expect(decision.systemMessage).toContain('QUEUED');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe(ENV.PAPERCUSP_MCP_URL);
    expect(capturedRequest?.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(capturedRequest?.body))).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'session:request-compaction',
        arguments: {},
        _meta: { format: 'json' },
      },
    });
  });

  it('accepts a structured MCP result when the text content block is absent', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      rpc({}, false, {
        content: [],
        structuredContent: { ok: true, requested: true, respawn: 'queued' },
      }),
    ));
    const decision = await runManagedPreCompact(PAYLOAD, { env: ENV, fetchImpl });

    expect(decision.continue).toBe(false);
    expect(decision.systemMessage).toContain('QUEUED');
  });

  it('selects the current native receipt instead of an unrelated owner fallback', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      const { params } = JSON.parse(String(request?.body));
      // The owner can have several launch records. The maintained MCP
      // classifier selects the exact caller row only with this native carrier.
      return new Response(params._meta?.threadId === PAYLOAD.session_id
        ? rpc({ ok: true, requested: true, respawn: 'queued' })
        : rpc({ ok: false, error: 'authorization_denied', message: 'Identity capability (unresolved): stale-artifact; resolution=receipt-missing' }, true));
    });
    const decision = await runManagedPreCompact(PAYLOAD, {
      env: { ...ENV, CODEX_SESSION_ID: 'inherited-predecessor' },
      fetchImpl,
    });

    expect(decision.systemMessage).toContain('QUEUED');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).params._meta)
      .toEqual({ format: 'json', threadId: PAYLOAD.session_id });
  });

  it.each([undefined, null, '', '   ', {}, 'native/session', 'x'.repeat(129)])(
    'refuses an invalid native identity (%j) before using owner-only authority', async (session_id) => {
      const fetchImpl = vi.fn();
      const decision = await runManagedPreCompact({ ...PAYLOAD, session_id }, { env: ENV, fetchImpl });

      expect(decision.continue).toBe(false);
      expect(decision.systemMessage).toContain('native session identity');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('preserves a foreign-native refusal without retrying on the owner-only route', async () => {
    const fetchImpl = vi.fn(async () => new Response(rpc({
      ok: false, error: 'superuser_foreign_native_session',
    }, true)));
    const decision = await runManagedPreCompact(PAYLOAD, { env: ENV, fetchImpl });

    expect(decision.continue).toBe(false);
    expect(decision.systemMessage).toContain('superuser_foreign_native_session');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the token file only for the superuser route and never changes that route', async () => {
    const env = {
      ...ENV,
      PAPERCUSP_MCP_URL:
        'http://127.0.0.1:9071/api/mcp?superuser=1&workspace=ws&client=su-1',
      PAPERCUSP_SID: 'su-1',
      PAPERCUSP_MCP_AUTH: 'superuser-token',
    };
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedRequest: RequestInit | undefined;
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, request?: RequestInit) => {
        capturedUrl = url;
        capturedRequest = request;
        return new Response(rpc({ ok: true, requested: true, respawn: 'queued' }));
      },
    );
    await runManagedPreCompact(PAYLOAD, {
      env,
      fetchImpl,
      readToken: () => 'secret-token',
    });
    expect(capturedUrl).toBe(env.PAPERCUSP_MCP_URL);
    expect(capturedRequest?.headers).toHaveProperty('Authorization', 'Bearer secret-token');
  });

  it('parses SSE and preserves an explicit flush refusal while still vetoing native compaction', async () => {
    const frame = rpc(
      {
        ok: false,
        requested: false,
        error: 'flush-required',
        note: 'checkpoint WI-1 first',
      },
      true,
    );
    const fetchImpl = vi.fn(async () =>
      new Response(`event: message\ndata: ${frame}\n\n`, { status: 200 }),
    );
    const decision = await runManagedPreCompact(PAYLOAD, { env: ENV, fetchImpl });
    expect(decision).toMatchObject({ continue: false });
    expect(decision.systemMessage).toContain('flush-required');
    expect(decision.systemMessage).toContain('checkpoint WI-1 first');
  });

  it('fails closed on transport failure, malformed output, and invalid hook input', async () => {
    const down = await runManagedPreCompact(PAYLOAD, {
      env: ENV,
      fetchImpl: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const malformed = preCompactDecision(parseManagedCarryResponse('not-json'));
    const compactResult = preCompactDecision(parseManagedCarryResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: false, content: [{ type: 'text', text: 'ok: true\nrequested: true\nrespawn: queued' }] },
    })));
    const invalidFetch = vi.fn();
    const invalid = await runManagedPreCompact(
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { env: ENV, fetchImpl: invalidFetch },
    );
    for (const decision of [down, malformed, compactResult, invalid]) {
      expect(decision.continue).toBe(false);
    }
    expect(down.systemMessage).toContain('connection refused');
    expect(malformed.systemMessage).toContain('no MCP result');
    expect(compactResult.systemMessage).toContain('no JSON text');
    expect(invalid.systemMessage).toContain('invalid PreCompact payload');
    expect(invalidFetch).not.toHaveBeenCalled();
  });

  it.each(['json', 'sse'])('preserves a plain-text MCP refusal over %s without allowing native compaction', async (format) => {
    const refusal = 'tool_not_allowed: session:request-compaction is unavailable on this route. Use the managed session route.';
    const frame = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { isError: true, content: [{ type: 'text', text: refusal }] },
    });
    const fetchImpl = vi.fn(async () => new Response(
      format === 'sse' ? `event: message\ndata: ${frame}\n\n` : frame,
    ));
    const decision = await runManagedPreCompact(PAYLOAD, { env: ENV, fetchImpl });

    expect(decision.continue).toBe(false);
    expect(decision.systemMessage).toContain(refusal);
    expect(decision.systemMessage).not.toContain('unreadable tool error');
    expect(decision.systemMessage).not.toContain('QUEUED');
  });

  it('bounds plain-text MCP error details and preserves the fail-closed decision', () => {
    const parsed = parseManagedCarryResponse(JSON.stringify({
      result: { isError: true, content: [{ type: 'text', text: `request_timeout: ${'x'.repeat(2000)}` }] },
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toMatch(/^request_timeout:/);
    expect(parsed.detail?.length).toBeLessThanOrEqual(700);
    expect(preCompactDecision(parsed).continue).toBe(false);
  });
});

/**
 * WI-10002522 — the inherited-context respawn storm. A legacy managed Codex carry
 * successor was a native fork of its predecessor, so an over-limit predecessor
 * yields an over-limit successor that trips auto-compaction before its first
 * sample. Re-queuing the managed boundary there forked the same context again:
 * 13 cuts in 10 minutes, zero model turns (codex log: 784140 / 784800 tokens).
 * Fixtures mirror the rollout shape Codex 0.156 wrote for those successors.
 * Preserve this guard for old hosts and explicit forks even though current
 * managed carry now starts fresh (EI-24046655564306940).
 */
describe('managed Codex PreCompact bridge — inherited-context successor', () => {
  const PREDECESSOR = '01a0cb00-df6e-7693-b888-867722b452ee';
  const meta = (forkedFrom: string | null) =>
    JSON.stringify({
      timestamp: '2026-09-23T00:14:44.000Z',
      type: 'session_meta',
      payload: {
        id: '01a0cb8f-0000-7000-8000-000000000001',
        cli_version: '0.156.0',
        ...(forkedFrom ? { forked_from_id: forkedFrom, history_mode: 'fork' } : {}),
      },
    });
  const event = (payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '2026-09-23T00:14:45.000Z', type: 'event_msg', payload });
  const SAMPLED = event({
    type: 'token_count',
    info: { last_token_usage: { input_tokens: 784140 }, model_context_window: 828400 },
  });

  function withRollout(lines: string[], fn: (path: string) => Promise<void> | void) {
    const dir = mkdtempSync(join(tmpdir(), 'managed-carry-rollout-'));
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return Promise.resolve(fn(path)).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it('lets Codex compact natively (no managed request) when the thread is an unsampled fork', async () => {
    await withRollout(
      [
        meta(PREDECESSOR),
        event({ type: 'task_started', model_context_window: 828400 }),
        // A token_count carrying only rate limits (info:null) is not a sample.
        event({ type: 'token_count', info: null }),
        event({ type: 'turn_aborted', reason: 'interrupted' }),
      ],
      async (transcript_path) => {
        const fetchImpl = vi.fn();
        const decision = await runManagedPreCompact({ ...PAYLOAD, transcript_path }, { env: ENV, fetchImpl });
        expect(decision.continue).toBe(true);
        expect(decision).not.toHaveProperty('stopReason');
        expect(decision.systemMessage).toContain('INHERITED');
        expect(decision.systemMessage).toContain(PREDECESSOR);
        expect(fetchImpl).not.toHaveBeenCalled();

        // CONTROL — the same turn with the transcript check switched off is the
        // pre-fix bridge, and it re-queues the managed boundary: the storm. If this
        // ever stops holding, the assertions above no longer distinguish the fix.
        const stormFetch = vi.fn(
          async () => new Response(rpc({ ok: true, requested: true, respawn: 'queued' }), { status: 200 }),
        );
        const preFix = await runManagedPreCompact(
          { ...PAYLOAD, transcript_path },
          {
            env: ENV,
            fetchImpl: stormFetch,
            inspectTranscript: () => ({ readable: false, forkedFromId: null, sampled: null }),
          },
        );
        expect(preFix.continue).toBe(false);
        expect(preFix.systemMessage).toContain('QUEUED');
        expect(stormFetch).toHaveBeenCalledOnce();
      },
    );
  });

  it('keeps the managed boundary for a sampled fork, an original thread, and an unreadable transcript', async () => {
    const queued = () =>
      vi.fn(async () => new Response(rpc({ ok: true, requested: true, respawn: 'queued' }), { status: 200 }));
    await withRollout([meta(PREDECESSOR), event({ type: 'task_started' }), SAMPLED], async (sampledFork) => {
      await withRollout([meta(null), event({ type: 'task_started' })], async (original) => {
        for (const transcript_path of [sampledFork, original, join(tmpdir(), 'missing-rollout.jsonl'), undefined]) {
          const fetchImpl = queued();
          const decision = await runManagedPreCompact({ ...PAYLOAD, transcript_path }, { env: ENV, fetchImpl });
          expect(decision.continue).toBe(false);
          expect(decision.systemMessage).toContain('QUEUED');
          expect(fetchImpl).toHaveBeenCalledOnce();
        }
      });
    });
  });

  it('classifies the rollout from its own first line and token_count events', async () => {
    await withRollout([meta(PREDECESSOR), event({ type: 'task_started' })], (path) => {
      expect(inspectCodexTranscript(path)).toEqual({ readable: true, forkedFromId: PREDECESSOR, sampled: false });
    });
    await withRollout([meta(PREDECESSOR), SAMPLED], (path) => {
      expect(inspectCodexTranscript(path)).toEqual({ readable: true, forkedFromId: PREDECESSOR, sampled: true });
    });
    // An original thread is never scanned for samples — the answer is "not checked", not a guess.
    await withRollout([meta(null), SAMPLED], (path) => {
      expect(inspectCodexTranscript(path)).toEqual({ readable: true, forkedFromId: null, sampled: null });
    });
    await withRollout([event({ type: 'task_started' })], (path) => {
      expect(inspectCodexTranscript(path).readable).toBe(false);
    });
    expect(inspectCodexTranscript('')).toEqual({ readable: false, forkedFromId: null, sampled: null });
  });
});
