import { describe, expect, it } from 'vitest';
import { decodeTaintOutput, semgrepTaint } from './semgrep-taint-facade';

describe('local-taint evidence admission boundaries', () => {
  const captured = new Map([['/captured/input.ts', 'source.ts']]);
  it('refuses a progress/diagnostic prefix instead of silently discarding evidence', () => {
    const empty = JSON.stringify({ results: [], errors: [] });
    expect(() => decodeTaintOutput('.\n' + empty, captured)).toThrow();
    expect(() => decodeTaintOutput('warning: partial analysis\n' + empty, captured)).toThrow();
  });
  it('refuses partial/parser errors even when the analyzer returned no matches', () => {
    expect(() => decodeTaintOutput(JSON.stringify({ results: [], errors: [{ error_type: 'ParseError' }] }), captured)).toThrow('analysis_incomplete');
    expect(() => decodeTaintOutput(JSON.stringify({ results: [] }), captured)).toThrow('analysis_incomplete');
    expect(decodeTaintOutput(JSON.stringify({ results: [], errors: [] }), captured)).toEqual([]);
  });
  it('refuses findings that cannot be tied to a captured path, rule and one-based location', () => {
    for (const row of [
      { path: '/ambient/other.ts', check_id: 'native-local-taint', start: { line: 1 } },
      { path: '/captured/input.ts', check_id: 'other-rule', start: { line: 1 } },
      { path: '/captured/input.ts', check_id: 'native-local-taint', start: { line: 0 } },
    ]) expect(() => decodeTaintOutput(JSON.stringify({ results: [row], errors: [] }), captured)).toThrow('uncited_finding');
  });
  it('refuses an unsupported grammar without claiming healthy emptiness or dynamic safety', async () => {
    const result = await semgrepTaint({ language: 'cpp', rootPath: '/absent', paths: ['x.cpp'] });
    expect(result.error).toContain('unsupported');
    expect(result.freshness.health).toBe('unknown');
    expect(result.dynamicBoundary).toBe('unknown');
    expect(result.limitations.join(' ')).toContain('not proof of safety');
  });
});
