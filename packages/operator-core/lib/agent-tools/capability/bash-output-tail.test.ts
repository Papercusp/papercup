/**
 * capability:bash_output `tail` (EI-22068327735595657) — pure unit tests over
 * truncateToTailLines / applyOutputTail / applyOutputTailToResult. No subprocess,
 * deterministic. Mirrors the style of bash-output-filter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { applyOutputTail, applyOutputTailToResult, truncateToTailLines } from './bash_output';

describe('truncateToTailLines', () => {
  const text = 'apple\nbanana\napricot\ncherry';

  it('no tail → unchanged text', () => {
    expect(truncateToTailLines(text, undefined)).toBe(text);
  });

  it('tail <= 0 → unchanged text (never a caller error, just a no-op)', () => {
    expect(truncateToTailLines(text, 0)).toBe(text);
    expect(truncateToTailLines(text, -3)).toBe(text);
  });

  it('tail >= line count → unchanged text', () => {
    expect(truncateToTailLines(text, 4)).toBe(text);
    expect(truncateToTailLines(text, 100)).toBe(text);
  });

  it('keeps exactly the last N lines', () => {
    expect(truncateToTailLines(text, 2)).toBe('apricot\ncherry');
    expect(truncateToTailLines(text, 1)).toBe('cherry');
  });

  it('empty text stays empty regardless of tail', () => {
    expect(truncateToTailLines('', 5)).toBe('');
  });
});

describe('applyOutputTail', () => {
  it('no tail → returns the SAME object reference (no-op short-circuit)', () => {
    const payload = { output: 'a\nb\nc' };
    expect(applyOutputTail(payload, undefined)).toBe(payload);
    expect(applyOutputTail(payload, 0)).toBe(payload);
  });

  it('trims `output` when present', () => {
    const payload = { ok: true, output: 'a\nb\nc\nd' };
    expect(applyOutputTail(payload, 2)).toEqual({ ok: true, output: 'c\nd' });
  });

  it('trims `output_tail` when present (the stranded/recovered-branch field name)', () => {
    const payload = { ok: false, output_tail: 'x\ny\nz' };
    expect(applyOutputTail(payload, 1)).toEqual({ ok: false, output_tail: 'z' });
  });

  it('trims BOTH `output` and `output_tail` when a payload carries both', () => {
    const payload = { output: 'a\nb\nc', output_tail: 'a\nb\nc' };
    expect(applyOutputTail(payload, 1)).toEqual({ output: 'c', output_tail: 'c' });
  });

  it('a payload with neither field is returned unchanged (same reference)', () => {
    const payload = { ok: true, status: 'running' };
    expect(applyOutputTail(payload, 5)).toBe(payload);
  });

  it('a non-string value under output/output_tail is left alone, never throws', () => {
    const payload = { output: null as unknown as string, exit_code: 0 };
    expect(applyOutputTail(payload, 3)).toEqual(payload);
  });
});

describe('applyOutputTailToResult', () => {
  function textResult(payload: unknown, isError?: boolean) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    };
  }

  it('no tail → returns the SAME result reference', () => {
    const result = textResult({ output: 'a\nb\nc' });
    expect(applyOutputTailToResult(result, undefined)).toBe(result);
  });

  it('trims the output field inside the JSON text content', () => {
    const result = textResult({ ok: true, output: 'a\nb\nc\nd\ne' });
    const trimmed = applyOutputTailToResult(result, 3);
    expect(JSON.parse(trimmed.content[0]!.text!)).toEqual({ ok: true, output: 'c\nd\ne' });
  });

  it('preserves isError and every other JSON field untouched', () => {
    const result = textResult({ ok: false, reason: 'job_process_gone', output_tail: 'l1\nl2\nl3' }, true);
    const trimmed = applyOutputTailToResult(result, 1);
    expect(trimmed.isError).toBe(true);
    expect(JSON.parse(trimmed.content[0]!.text!)).toEqual({
      ok: false,
      reason: 'job_process_gone',
      output_tail: 'l3',
    });
  });

  it('non-JSON text content is left untouched, never throws', () => {
    const result = { content: [{ type: 'text' as const, text: 'not json {' }] };
    expect(applyOutputTailToResult(result, 5)).toEqual(result);
  });

  it('a non-text content item is passed through unchanged', () => {
    const result = {
      content: [{ type: 'image' as unknown as string, text: undefined }, { type: 'text' as const, text: JSON.stringify({ output: 'a\nb\nc' }) }],
    };
    const trimmed = applyOutputTailToResult(result, 1);
    expect(trimmed.content[0]).toEqual(result.content[0]);
    expect(JSON.parse(trimmed.content[1]!.text!)).toEqual({ output: 'c' });
  });
});
