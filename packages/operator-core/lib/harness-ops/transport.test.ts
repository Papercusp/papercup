/**
 * Operator → harness dispatch transport (`harness-provided-cadence-ops-2026-06-26`
 * P-004 / P-005). Hermetic coverage of `harnessApiBase`'s resolution order that
 * needs no PG: the env override, the deployed-frame path (frame passed directly),
 * and env-var name normalization. The local-registration path (PG-backed) is
 * exercised by the live arm/verify (P-010).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { harnessApiBase, harnessEndpointEnvVar } from './transport.js';
import type { Frame } from '@papercusp/deployment-driver';

describe('harnessEndpointEnvVar', () => {
  it('normalizes a slug to an UPPER_SNAKE env var', () => {
    expect(harnessEndpointEnvVar('oddsmith-ops')).toBe('PAPERCUSP_HARNESS_ENDPOINT__ODDSMITH_OPS');
    expect(harnessEndpointEnvVar('a:b-c')).toBe('PAPERCUSP_HARNESS_ENDPOINT__A_B_C');
  });
});

describe('harnessApiBase resolution order', () => {
  const envVar = harnessEndpointEnvVar('oddsmith-ops');
  afterEach(() => {
    delete process.env[envVar];
  });

  it('1. env override wins and is normalized (trailing slash stripped)', async () => {
    process.env[envVar] = 'http://127.0.0.1:9999/';
    const base = await harnessApiBase('oddsmith-ops');
    expect(base).toBe('http://127.0.0.1:9999');
  });

  it('2. a passed deployed frame with host+callablePort yields the deployed base', async () => {
    const frame: Frame = {
      id: 'frame-1',
      target: 'local',
      placement: 'remote',
      host: '10.0.0.5',
      callablePort: 8080,
    } as Frame;
    const base = await harnessApiBase('oddsmith-ops', undefined, frame);
    expect(base).toBe('http://10.0.0.5:8080');
  });

  it('env override takes precedence over a passed frame', async () => {
    process.env[envVar] = 'http://override:1234';
    const frame: Frame = {
      id: 'f',
      target: 'local',
      placement: 'remote',
      host: '10.0.0.5',
      callablePort: 8080,
    } as Frame;
    expect(await harnessApiBase('oddsmith-ops', undefined, frame)).toBe('http://override:1234');
  });

  it('throws a clear, actionable error when no endpoint is resolvable', async () => {
    // no env override, no frame, no workspace ⇒ no registry lookup ⇒ fail closed
    await expect(harnessApiBase('oddsmith-ops')).rejects.toThrow(/no dispatch endpoint registered/);
  });
});
