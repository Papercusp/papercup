/**
 * Operator → harness dispatch transport (`harness-provided-cadence-ops-2026-06-26`
 * P-004 / P-005). Hermetic coverage of `harnessApiBase`'s resolution order that
 * needs no PG: the env override, the deployed-frame path (frame passed directly),
 * and env-var name normalization. The local-registration path (PG-backed) is
 * exercised by the live arm/verify (P-010).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Frame } from '@papercusp/deployment-driver';

// Hermetic isolation (EI-5416): the resolver's step-3 LOCAL-registration lookup
// reads `loadHarnessRegistry()`. With no workspaceId it falls through to the
// host's DEFAULT workspace registry — so on a RUNNING dev box `oddsmith-ops` has
// a live `localEndpoint` advertised and the "no endpoint resolvable" case
// RESOLVES instead of rejecting (false RED in `test:affected`). Stub the registry
// so resolution genuinely has nothing to resolve, matching the test's intent.
vi.mock('../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-registry')>();
  return { ...actual, loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) };
});

const { harnessApiBase, harnessEndpointEnvVar, HarnessEndpointUnavailableError } = await import(
  './transport.js'
);

describe('harnessEndpointEnvVar', () => {
  it('normalizes a slug to an UPPER_SNAKE env var', () => {
    expect(harnessEndpointEnvVar('oddsmith-ops')).toBe('PAPERCUSP_HARNESS_ENDPOINT__ODDSMITH_OPS');
    expect(harnessEndpointEnvVar('a:b-c')).toBe('PAPERCUSP_HARNESS_ENDPOINT__A_B_C');
  });
});

describe('harnessApiBase resolution order', () => {
  const envVar = harnessEndpointEnvVar('oddsmith-ops');
  // Hermetic (EI-5416 follow-up): clear the endpoint env var BEFORE each test, not
  // only after. The green-checkpoint suite is spawned by the running operator, whose
  // process env can carry a `PAPERCUSP_HARNESS_ENDPOINT__*` for a live harness — an
  // ambient value the resolver's step-1 reads, making the "no endpoint resolvable"
  // case falsely RESOLVE (a CI-only RED that never reproduces in a clean shell). With
  // step-1 (env, here) + step-2 (no workspaceId → frame lookup skipped) + step-3
  // (loadHarnessRegistry mocked above) all neutralized, the throw is deterministic.
  beforeEach(() => {
    delete process.env[envVar];
  });
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

  it('the no-endpoint throw is a TYPED HarnessEndpointUnavailableError carrying code + slug (WI-1087 withhold discriminant)', async () => {
    // A cadence caller (blueprint-run) keys on the TYPE, not the message, to WITHHOLD
    // the run (the sidecar may register later) instead of reporting a program FAILURE.
    const err = await harnessApiBase('oddsmith-ops').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(HarnessEndpointUnavailableError);
    expect(err.code).toBe('harness_endpoint_unavailable');
    expect(err.harnessSlug).toBe('oddsmith-ops');
  });
});
