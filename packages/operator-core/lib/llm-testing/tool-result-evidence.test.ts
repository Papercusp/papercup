import { describe, expect, it } from 'vitest';

import {
  TOOL_RESULT_EVIDENCE_MAX_CHARS,
  TOOL_RESULT_EVIDENCE_MAX_EVENTS,
} from '@papercusp/testing-shell/llm';

import {
  captureToolResultEvidence,
  normalizeToolResultEvidence,
} from './tool-result-evidence';

describe('tool-result evidence safety boundary', () => {
  it('redacts self-identifying and key-directed secrets before retaining output', () => {
    const apiKey = `opaque-${'a'.repeat(32)}`;
    const bearer = `Bearer ${'b'.repeat(36)}`;
    const providerKey = `sk-${'c'.repeat(48)}`;
    const raw = JSON.stringify({ apiKey, authorization: bearer, value: providerKey });

    const evidence = captureToolResultEvidence('work_items:get', raw, false);

    expect(evidence.output).toContain('[redacted]');
    expect(evidence.output).not.toContain(apiKey);
    expect(evidence.output).not.toContain(bearer);
    expect(evidence.output).not.toContain(providerKey);
    expect(evidence.sourceChars).toBe(raw.length);
    expect(evidence.truncated).toBe(false);
  });

  it('bounds each excerpt and marks the retained fragment as truncated', () => {
    const raw = 'x'.repeat(TOOL_RESULT_EVIDENCE_MAX_CHARS + 500);

    const evidence = captureToolResultEvidence('code:run', raw, true);

    expect(evidence.output.length).toBe(TOOL_RESULT_EVIDENCE_MAX_CHARS);
    expect(evidence.output.endsWith('[tool result truncated]')).toBe(true);
    expect(evidence.isError).toBe(true);
    expect(evidence.truncated).toBe(true);
    expect(evidence.sourceChars).toBe(raw.length);
  });

  it('re-scrubs persisted values, drops malformed entries, and caps event count', () => {
    const secret = `ghp_${'d'.repeat(36)}`;
    const values = [
      null,
      { name: 'docs:get', output: `token=${secret}`, isError: false, truncated: false, sourceChars: 42 },
      ...Array.from({ length: TOOL_RESULT_EVIDENCE_MAX_EVENTS + 10 }, (_, i) => ({
        name: `tool:${i}`,
        output: 'ok',
        isError: false,
        truncated: false,
        sourceChars: 2,
      })),
    ];

    const normalized = normalizeToolResultEvidence(values);

    expect(normalized).toHaveLength(TOOL_RESULT_EVIDENCE_MAX_EVENTS - 1);
    expect(normalized[0]?.output).toContain('[redacted]');
    expect(normalized[0]?.output).not.toContain(secret);
  });
});
