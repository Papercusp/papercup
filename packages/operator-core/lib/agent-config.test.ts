import { describe, it, expect } from 'vitest';
import { effectiveBackend, parseSurfaceModels, parseBackends, type AgentConfig } from './agent-config';

function cfg(partial: Partial<AgentConfig>): AgentConfig {
  return { backend: 'auto', cmd: '', models: {}, ...partial };
}

describe('effectiveBackend', () => {
  it('returns an explicit backend verbatim (no inference)', () => {
    expect(effectiveBackend(cfg({ backend: 'claude-code', cmd: 'omp -p' }))).toBe('claude-code');
    expect(effectiveBackend(cfg({ backend: 'omp', cmd: 'claude -p' }))).toBe('omp');
  });

  it("infers claude-code from a `claude` binary when backend is 'auto'", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'claude -p' }))).toBe('claude-code');
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: '/usr/local/bin/claude -p --model opus' }))).toBe('claude-code');
  });

  it("infers omp from an `omp`/`pi` binary when backend is 'auto'", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'omp -p' }))).toBe('omp');
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: '/home/u/.bun/bin/pi -p' }))).toBe('omp');
  });

  it("defaults 'auto' with an unrecognized binary to omp", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'wrapper.sh' }))).toBe('omp');
  });
});

describe('parseSurfaceModels (OQ3)', () => {
  it('keeps known surfaces mapped to non-empty model ids, trimmed', () => {
    expect(parseSurfaceModels({ operator: ' gpt-5.5 ', oracle: 'claude-opus-4-7' })).toEqual({
      operator: 'gpt-5.5',
      oracle: 'claude-opus-4-7',
    });
  });

  it('drops unknown surface keys + empty/non-string values', () => {
    expect(parseSurfaceModels({ nope: 'x', operator: '', scanner: '  ', plans: 42 as unknown as string })).toEqual({});
  });

  it('returns {} for non-object input', () => {
    expect(parseSurfaceModels(null)).toEqual({});
    expect(parseSurfaceModels(['a'])).toEqual({});
  });
});

describe('parseBackends (drift guard for the SurfaceKey set)', () => {
  it('keeps known surfaces mapped to concrete subprocess backends', () => {
    expect(parseBackends({ operator: 'codex', oracle: 'claude-code', plans: 'omp' })).toEqual({
      operator: 'codex',
      oracle: 'claude-code',
      plans: 'omp',
    });
  });

  it("drops 'auto' / unknown backends + unknown surfaces", () => {
    expect(parseBackends({ operator: 'auto', nope: 'omp', scanner: 'gemini' })).toEqual({});
  });
});
