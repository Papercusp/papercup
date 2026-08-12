import { describe, expect, it, vi } from 'vitest';
import {
  callToolWithPressureRetry,
  buildMcpUrl,
  resolveContextTier,
  formatToolCallFailure,
  isLoopPressureShed,
  printResult,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
  PTOOL_TRUNCATED_RESULT_MESSAGE,
  resultToText,
  sanitizeJsonText,
  shouldPrintRawResult,
  timeoutForTool,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
} from './ptool.mjs';

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

describe('ptool call deadlines', () => {
  it('keeps the normal liveness ceiling while allowing git-sync:run to return its continuation', () => {
    expect(timeoutForTool('coord:send')).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('git-sync:run')).toBe(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS);
    expect(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
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
