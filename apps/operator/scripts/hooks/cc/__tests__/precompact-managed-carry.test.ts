// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManagedCarryResponse,
  preCompactDecision,
  runManagedPreCompact,
  isDirectCliInvocation,
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

function rpc(inner: Record<string, unknown>, isError = false) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { isError, content: [{ type: 'text', text: JSON.stringify(inner) }] },
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
      params: { name: 'session:request-compaction', arguments: {} },
    });
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
    const invalidFetch = vi.fn();
    const invalid = await runManagedPreCompact(
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { env: ENV, fetchImpl: invalidFetch },
    );
    for (const decision of [down, malformed, invalid]) {
      expect(decision.continue).toBe(false);
    }
    expect(down.systemMessage).toContain('connection refused');
    expect(malformed.systemMessage).toContain('no MCP result');
    expect(invalid.systemMessage).toContain('invalid PreCompact payload');
    expect(invalidFetch).not.toHaveBeenCalled();
  });
});
