import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  callToolWithPressureRetry,
  callToolWithReplayRecovery,
  buildCallToolParams,
  buildMcpUrl,
  resolveContextTier,
  resolveTokenPath,
  resolveTokenPaths,
  formatToolCallFailure,
  isLoopPressureShed,
  isTransportFailure,
  printResult,
  PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
  PTOOL_POST_CONNECT_RETRIES,
  PTOOL_SCORECARD_EMIT_TIMEOUT_MS,
  PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS,
  PTOOL_TRUNCATED_RESULT_MESSAGE,
  resultToText,
  sanitizeJsonText,
  shouldPrintRawResult,
  timeoutForTool,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
} from './ptool.mjs';

describe('ptool bootstrap dependencies', () => {
  it('declares the MCP SDK directly in the operator workspace', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
  });
});

describe('ptool MCP identity binding', () => {
  it('carries the live PAPERCUSP_SID as the MCP client query parameter', () => {
    const url = buildMcpUrl('http://127.0.0.1:3170', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      client: 'su-live-owner-123',
    });

    expect(url.searchParams.get('client')).toBe('su-live-owner-123');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
    expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
  });

  it('defaults direct sessions to trimmed payloads and allows an explicit full escape hatch', () => {
    expect(resolveContextTier({ env: { NODE_ENV: 'test' } })).toBe('trimmed');
    expect(resolveContextTier({ env: { NODE_ENV: 'test', PAPERCUSP_CONTEXT_TIER: ' full ' } })).toBe('full');
    expect(buildMcpUrl('http://127.0.0.1:3170', { contextTier: 'full' }).searchParams.get('ctx_tier'))
      .toBe('full');
  });
});

describe('ptool bearer-token resolution', () => {
  it('keeps explicit and environment token overrides authoritative', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_MCP_TOKEN_FILE: '/run/papercusp/explicit-token',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };

    expect(resolveTokenPaths({
      tokenFile: '/tmp/cli-token',
      env,
      home: '/home/tester',
    })).toEqual(['/tmp/cli-token']);
    expect(resolveTokenPaths({ env, home: '/home/tester' }))
      .toEqual(['/run/papercusp/explicit-token']);
  });

  it('falls back to the shared host token when an isolated workspace token is absent', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };
    const paths = resolveTokenPaths({ env, home: '/home/tester' });

    expect(paths).toEqual([
      '/home/tester/.papercusp-workspaces/demo/.papercusp/superuser-token',
      '/home/tester/.papercusp/superuser-token',
    ]);
    expect(resolveTokenPath({ env, home: '/home/tester' })).toBe(paths[0]);
  });
});

describe('ptool call deadlines', () => {
  it('keeps the normal liveness ceiling while allowing durable continuations to return', () => {
    expect(timeoutForTool('coord:send')).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('fleet:launch-on-plan')).toBe(300_000);
    expect(timeoutForTool('tools:invoke', { name: 'fleet:launch-on-plan' })).toBe(300_000);
    expect(timeoutForTool('git-sync:run')).toBe(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS);
    expect(timeoutForTool('backup:snapshot_create')).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('templates:new-app')).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('scorecards:emit')).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    expect(timeoutForTool('coord:orient')).toBe(60_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:orient',
      args: {},
    })).toBe(60_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'backup:snapshot_create',
      args: { reason: 'pre_destructive' },
    })).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:send',
      args: {},
    })).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'templates:new-app',
      args: { template: 'papercusp-android-app', slug: 'demo' },
    })).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scorecards:emit',
      args: { rubricRef: 'acceptance-demo' },
    })).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    expect(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_SCORECARD_EMIT_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it('passes the selected deadline to both MCP timeout guards', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    await callToolWithPressureRetry(
      { callTool },
      { name: 'git-sync:run', arguments: {} },
      { timeoutMs: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS, maxAttempts: 1 },
    );

    expect(callTool).toHaveBeenCalledWith(
      { name: 'git-sync:run', arguments: {} },
      undefined,
      {
        timeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
        maxTotalTimeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
      },
    );
  });
});

describe('ptool tools/call failure diagnostics', () => {
  it('preserves transport and cause details while requiring state verification before retry', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });

    const message = formatToolCallFailure('work_items:complete', error);

    expect(message).toContain('tools/call work_items:complete');
    expect(message).toContain('fetch failed');
    expect(message).toContain('UND_ERR_SOCKET: other side closed');
    expect(message).toContain('the tool call may have executed');
    expect(message).toContain('verify its state before retrying');
    expect(message).toContain('Do not blindly retry a mutation');
  });

  it('does not mislabel a known pre-dispatch pressure shed as ambiguous', () => {
    const error = new Error('loop_pressure_critical');

    expect(isLoopPressureShed(error)).toBe(true);
    expect(formatToolCallFailure('coord:send', error)).toContain('rejected before dispatch');
    expect(formatToolCallFailure('coord:send', error)).toContain('no tool execution occurred');
    expect(formatToolCallFailure('coord:send', error)).not.toContain('may have executed');
  });
});

describe('ptool keyed result recovery without concurrent replay', () => {
  it('puts one caller-supplied idempotency key beside the format metadata', () => {
    expect(buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    })).toEqual({
      name: 'work_items:complete',
      arguments: { id: 'EI-1' },
      _meta: { format: 'json', idempotencyKey: 'ptool-key-1' },
    });
  });

  it('negotiates projected object-schema calls as JSON instead of requesting the unprojected structured twin', () => {
    expect(buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' }, idempotencyKey: 'ptool-projected-1' },
    )).toEqual({
      name: 'sessions:read',
      arguments: { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      _meta: { format: 'json', idempotencyKey: 'ptool-projected-1' },
    });
  });

  it('uses schema-neutral MCP request validation for a projected call', async () => {
    const result = { content: [{ type: 'text', text: '{"turns":[{"turn_idx":1}]}' }] };
    const client = {
      callTool: vi.fn(),
      request: vi.fn().mockResolvedValue(result),
    };
    const params = buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' } },
    );

    await expect(callToolWithPressureRetry(client, params, {
      maxAttempts: 1,
      timeoutMs: 1,
    })).resolves.toBe(result);

    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toEqual({ method: 'tools/call', params });
    expect(client.request.mock.calls[0][2]).toEqual({ timeout: 1, maxTotalTimeout: 1 });
  });

  it('recognizes MCP stream-close/deadline failures but not tool errors', () => {
    expect(isTransportFailure(Object.assign(new Error('Connection closed'), { code: -32000 }))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error('Request timed out'), { code: -32001 }))).toBe(true);
    expect(isTransportFailure(new Error('MCP error -32602: invalid arguments'))).toBe(false);
    expect(isTransportFailure(new Error('tool failed after dispatch'))).toBe(false);
  });

  it('does not reconnect after a post-connect close while the original may still be running', async () => {
    const params = buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    });
    const failure = Object.assign(new Error('Connection closed'), { code: -32000 });
    const first = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn(),
    };
    const reconnect = vi.fn();

    await expect(callToolWithReplayRecovery(first, params, {
      reconnect,
      timeoutMs: 1,
    })).rejects.toBe(failure);

    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('cannot re-enable automatic replay with a larger per-call retry budget', async () => {
    const firstError = Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' });
    const first = { callTool: vi.fn().mockRejectedValue(firstError), close: vi.fn() };
    const reconnect = vi.fn();
    const params = buildCallToolParams('coord:send', {}, { idempotencyKey: 'ptool-key-2' });

    await expect(callToolWithReplayRecovery(first, params, { reconnect, maxAttempts: 99 })).rejects.toBe(firstError);
    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
  });
});

describe('ptool result formatting', () => {
  it('prints structuredContent when the MCP response has no content blocks', () => {
    expect(resultToText({ structuredContent: { ok: true, value: 7 } }))
      .toBe('{"ok":true,"value":7}');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(printResult({ structuredContent: { ok: true } }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('prefers complete structuredContent over lossy text content', () => {
    expect(resultToText({
      content: [{ type: 'text', text: '{"items":[\n[result-door: truncated]' }],
      structuredContent: { items: [{ id: 'P-001' }] },
    })).toBe('{"items":[{"id":"P-001"}]}');
  });

  it('fails loudly instead of emitting a result-door-truncated JSON prefix', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = {
        content: [{
          type: 'text',
          text: '{"items":[{"id":"P-001"},\n[result-door: this result exceeded the token budget and was truncated.',
        }],
      };
      expect(printResult(result, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(PTOOL_TRUNCATED_RESULT_MESSAGE);
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('may have executed');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('verify its state before retrying');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('narrow the query');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('jq');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('keeps appended advisory content off raw stdout so jq can parse the payload', () => {
    const result = {
      content: [
        { type: 'text', text: '{"ok":true,"value":7}' },
        { type: 'text', text: 'See also: loop:arm (start a loop)' },
      ],
    };

    expect(resultToText(result, { raw: true })).toBe('{"ok":true,"value":7}');
    expect(resultToText(result, { raw: false })).toBe(
      '{"ok":true,"value":7}\nSee also: loop:arm (start a loop)',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(printResult(result, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true,"value":7}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('fails loudly instead of exiting zero with blank stdout for an empty response', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(printResult({ content: [] }, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'ptool: operator returned an empty MCP result; no content or structuredContent was received',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('escapes raw controls inside JSON text for jq-safe raw output', () => {
    const nul = String.fromCharCode(0);
    const raw = `{"message":"before${nul}after\nline"}`;
    const repaired = sanitizeJsonText(raw);

    expect(JSON.parse(repaired)).toEqual({ message: `before${nul}after\nline` });
    expect(repaired).toContain('\\u0000');
    expect(repaired).toContain('\\u000a');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(printResult({ content: [{ type: 'text', text: raw }] }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith(repaired);
      expect(printResult({ content: [{ type: 'text', text: raw }] }, { raw: false })).toBe(0);
      expect(log).toHaveBeenLastCalledWith(JSON.stringify(JSON.parse(repaired), null, 2));
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('leaves non-JSON text unchanged', () => {
    const text = `plain${String.fromCharCode(0)}text`;
    expect(sanitizeJsonText(text)).toBe(text);
  });

  it('repairs a truncated JSON prefix without requiring a valid whole document', () => {
    const truncated = '{"message":"first\nsecond';
    expect(sanitizeJsonText(truncated)).toBe('{"message":"first\\u000asecond');
  });
});

describe('ptool scripted JSON output', () => {
  it('uses the raw JSON extractor for every explicit JSON input, without requiring --raw', () => {
    expect(shouldPrintRawResult('inline', false)).toBe(true);
    expect(shouldPrintRawResult('file', false)).toBe(true);
    expect(shouldPrintRawResult('stdin', false)).toBe(true);
    expect(shouldPrintRawResult(null, false)).toBe(false);
    expect(shouldPrintRawResult(null, true)).toBe(true);
  });
});
