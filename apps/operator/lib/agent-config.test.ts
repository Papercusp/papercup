import { describe, it, expect } from 'vitest';
import { effectiveBackend, type AgentConfig } from './agent-config';

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
