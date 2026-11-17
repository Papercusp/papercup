import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';

const resolvers = vi.hoisted(() => ({
  cookie: vi.fn(), appKey: vi.fn(), device: vi.fn(), superuser: vi.fn(), bearer: vi.fn(), loopback: vi.fn(),
}));
vi.mock('./principal/from-cookie', () => ({ principalFromCookie: resolvers.cookie }));
vi.mock('../connected-apps/principal', () => ({ resolveAppKeyPrincipal: resolvers.appKey }));
vi.mock('./principal/from-device-jwt', () => ({ principalFromDeviceJwt: resolvers.device }));
vi.mock('./principal/from-superuser-token', () => ({ principalFromSuperuserToken: resolvers.superuser }));
vi.mock('./principal/from-bearer-token', () => ({ principalFromBearerToken: resolvers.bearer }));
vi.mock('./principal/from-loopback', () => ({ principalFromLoopback: resolvers.loopback }));

import { requirePrincipal } from './require-principal';

const principal = { kind: 'system' as const, trust: 'trusted' as const, slug: 'private-identity',
  workspaceId: 'private-workspace', authMethod: 'bearer-token' as const, capabilities: new Set(['*']) };
const headers = () => new Headers({ authorization: 'Bearer private-credential' });

beforeEach(() => {
  for (const resolver of Object.values(resolvers)) resolver.mockReset().mockReturnValue(null);
});

describe('principal resolver timing preserves authority', () => {
  it('identifies a pending bearer lookup and stops on its failure', async () => {
    let now = 0;
    const phases = createPhaseTracker({ now: () => now });
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    resolvers.bearer.mockImplementation(() => { entered(); return new Promise((_, fail) => { reject = fail; }); });
    resolvers.loopback.mockReturnValue(principal);
    const result = requirePrincipal(headers(), {}, phases);
    const failed = expect(result).rejects.toThrow('lookup unavailable');
    await started;
    now = 240;
    expect(phases.toMetadata()?.pending).toEqual([{ phase: 'principal:bearer', startMs: 0, elapsedMs: 240 }]);
    expect(resolvers.loopback).not.toHaveBeenCalled();
    reject(new Error('lookup unavailable'));
    await failed;
    expect(phases.toMetadata()?.pending).toEqual([]);
    expect(phases.intervals()).toContainEqual({ phase: 'principal:bearer', startMs: 0, durationMs: 240 });
    expect(resolvers.loopback).not.toHaveBeenCalled();
    expect(JSON.stringify(phases.toMetadata())).not.toMatch(/private-/);
  });

  it('keeps cookies ahead of bearer identities and excludes skipped resolvers', async () => {
    const phases = createPhaseTracker();
    resolvers.cookie.mockReturnValue(principal);
    expect(await requirePrincipal(headers(), {}, phases)).toBe(principal);
    expect(phases.intervals().map(p => p.phase)).toEqual(['principal:cookie']);
    for (const [name, resolver] of Object.entries(resolvers))
      if (name !== 'cookie') expect(resolver).not.toHaveBeenCalled();
  });

  it('keeps a presented invalid app key terminal while timing it', async () => {
    const phases = createPhaseTracker();
    resolvers.appKey.mockReturnValue({ ok: false, reason: 'revoked' });
    await expect(requirePrincipal(headers(), {}, phases)).rejects.toMatchObject({ status: 401 });
    expect(phases.intervals().map(p => p.phase)).toEqual(['principal:cookie', 'principal:appKey']);
    expect(resolvers.device).not.toHaveBeenCalled();
    expect(resolvers.superuser).not.toHaveBeenCalled();
    expect(resolvers.bearer).not.toHaveBeenCalled();
    expect(resolvers.loopback).not.toHaveBeenCalled();
  });

  it('retains the superuser short circuit and the post-resolution requirements', async () => {
    const phases = createPhaseTracker();
    resolvers.superuser.mockReturnValue(principal);
    await expect(requirePrincipal(headers(), { kind: ['user'] }, phases)).rejects.toMatchObject({ status: 403 });
    expect(phases.intervals().map(p => p.phase)).toEqual([
      'principal:cookie', 'principal:appKey', 'principal:device', 'principal:superuser',
    ]);
    expect(resolvers.bearer).not.toHaveBeenCalled();
    expect(resolvers.loopback).not.toHaveBeenCalled();
  });
});
