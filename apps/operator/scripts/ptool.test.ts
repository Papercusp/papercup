import { describe, expect, it, vi } from 'vitest';
// @ts-ignore -- runtime CLI module intentionally tested from TypeScript.
import {
  callToolWithPressureRetry,
  printResult,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
  resultToText,
  sanitizeJsonText,
  timeoutForTool,
} from './ptool.mjs';

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
