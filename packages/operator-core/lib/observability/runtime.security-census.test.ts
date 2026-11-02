import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedSurface } from '@papercusp/testing-shell/census';
import { readRuntimeSecurityCensus, registerRuntimeSecurityCapture } from './runtime';

const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0)) release(); });
const surface = (id: string): ObservedSurface => ({ kind: 'mounted-http-handler',
  surfaceId: id, fidelity: 'observed', attrs: { actualEffectCoverage: 'unknown' } });

describe('owning-process security discovery', () => {
  it('keeps absent or failed host capture unavailable and unqualified', async () => {
    const absent = await readRuntimeSecurityCensus();
    expect(absent.status).toBe('unavailable');
    expect(absent.unresolved).toContain('security-host-capture-not-registered');
    releases.push(registerRuntimeSecurityCapture(async () => { throw Error('fixture failure'); }));
    const failed = await readRuntimeSecurityCensus();
    expect(failed.status).toBe('unavailable');
    expect(failed.unresolved).toContain('security-host-capture-failed');
    expect(failed.populationComplete).toBe(false); expect(failed.executionAdmitted).toBe(false);
  });

  it('hashes the full population, preserves duplicates and detaches live metadata', async () => {
    const surfaces = [surface('one'), surface('two')];
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces, declaredSurfaces: [], unresolved: ['nested-unknown'] })));
    const first = await readRuntimeSecurityCensus(1), larger = await readRuntimeSecurityCensus(2);
    expect(first.discoverySha256).toBe(larger.discoverySha256);
    expect(first.total).toBe(2); expect(first.rows).toHaveLength(1);
    expect(first.truncatedByLimit).toBe(true); expect(larger.truncatedByLimit).toBe(false);
    (surfaces[0]!.attrs as Record<string, unknown>).actualEffectCoverage = 'changed';
    expect(first.rows[0]!.attrs.actualEffectCoverage).toBe('unknown');
    expect((await readRuntimeSecurityCensus()).discoverySha256).not.toBe(first.discoverySha256);
    surfaces.push(surface('two'));
    const duplicate = await readRuntimeSecurityCensus();
    expect(duplicate.total).toBe(3);
    expect(duplicate.unresolved.some(gap => gap.startsWith('security-census-duplicate:'))).toBe(true);
    expect(duplicate.unresolved).toContain('nested-unknown'); expect(duplicate.closureAccepted).toBe(false);
  });

  it('rejects invalid bounds and lets old disposers preserve the replacement host', async () => {
    const old = registerRuntimeSecurityCapture(async () => ({ surfaces: [], declaredSurfaces: [], unresolved: [] }));
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces: [surface('replacement')], declaredSurfaces: [], unresolved: [] })));
    old(); expect((await readRuntimeSecurityCensus()).total).toBe(1);
    for (const limit of [0, 501, 1.5]) await expect(readRuntimeSecurityCensus(limit)).rejects.toThrow('invalid_limit');
  });
});
