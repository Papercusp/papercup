/**
 * EI-337: applyToProcessEnv must RESTORE the boot-time env on empty config
 * values — not delete them. The module captures BOOT_AGENT_ENV at load, so
 * each test stubs the env first, resets the module registry, and dynamically
 * imports a fresh copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('./agent-config');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('applyToProcessEnv — boot-env restore (EI-337)', () => {
  it('an empty cmd/models config restores the BOOT values instead of deleting them', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', '{"worker":"opus"}');
    vi.stubEnv('AGENT_BACKEND', 'claude-code');
    const { applyToProcessEnv } = await freshModule();

    // A save with explicit values mutates the live env…
    applyToProcessEnv({ backend: 'omp', cmd: 'omp -p', models: { cup: 'sonnet' } });
    expect(process.env.AGENT_CMD).toBe('omp -p');
    expect(process.env.AGENT_BACKEND).toBe('omp');
    expect(process.env.AGENT_MODELS).toBe('{"cup":"sonnet"}');

    // …and a save with EMPTY values reverts to what the host booted with —
    // the pre-fix behavior deleted these, silently dropping the .env.local
    // config until the next restart.
    applyToProcessEnv({ backend: 'auto', cmd: '', models: {} });
    expect(process.env.AGENT_CMD).toBe('claude -p --model haiku');
    expect(process.env.AGENT_MODELS).toBe('{"worker":"opus"}');
    expect(process.env.AGENT_BACKEND).toBe('claude-code');
  });

  it('a host booted WITHOUT the vars stays unset after an empty save', async () => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    vi.stubEnv('AGENT_BACKEND', undefined as unknown as string);
    const { applyToProcessEnv } = await freshModule();

    applyToProcessEnv({ backend: 'claude-code', cmd: 'claude -p', models: {} });
    expect(process.env.AGENT_CMD).toBe('claude -p');
    applyToProcessEnv({ backend: 'auto', cmd: '', models: {} });
    expect(process.env.AGENT_CMD).toBeUndefined();
    expect(process.env.AGENT_BACKEND).toBeUndefined();
    expect(process.env.AGENT_MODELS).toBeUndefined();
  });
});
