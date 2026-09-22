import { describe, expect, it } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { workspaceHostNetworkLabel, workspaceHostSpecColumns } from './desired-spec-host-row';

function spec(overrides: Partial<WorkspaceHostDesiredSpec> = {}): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-1',
    target: 'gcp',
    scope: { kind: 'project', id: 'project-a' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-small',
    image: { id: 'projects/images/global/images/papercusp-v1' },
    data: { volumeGiB: 40, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://test' } },
    ...overrides,
  } as WorkspaceHostDesiredSpec;
}

describe('workspaceHostSpecColumns', () => {
  it('projects every spec-derived column, taking identity from the spec', () => {
    expect(
      workspaceHostSpecColumns(
        spec({ provider: { network: { mode: 'managed', networkName: 'net-a' } } }),
      ),
    ).toEqual({
      id: 'host-1',
      target: 'gcp',
      scopeLabel: 'project-a',
      region: 'us-central1',
      size: 'e2-small',
      image: 'projects/images/global/images/papercusp-v1',
      diskGiB: 40,
      network: 'net-a',
    });
  });

  it('returns ONLY spec-derived columns, never lifecycle state', () => {
    // Lifecycle fields belong to the caller: the provisioning runner and hosted admission
    // legitimately write different observed states from the SAME spec, so a mapper that
    // emitted them would force one of the two callers to fight it.
    expect(Object.keys(workspaceHostSpecColumns(spec())).sort()).toEqual([
      'diskGiB',
      'id',
      'image',
      'network',
      'region',
      'scopeLabel',
      'size',
      'target',
    ]);
  });
});

describe('workspaceHostNetworkLabel', () => {
  it('prefers an explicit network name over the mode', () => {
    expect(
      workspaceHostNetworkLabel(spec({ provider: { network: { mode: 'managed', networkName: 'net-b' } } })),
    ).toBe('net-b');
  });

  it('falls back to the mode when no name is given', () => {
    expect(workspaceHostNetworkLabel(spec({ provider: { network: { mode: 'custom' } } }))).toBe('custom');
  });

  it.each([
    ['no provider block', spec()],
    ['no network key', spec({ provider: {} })],
    ['a non-object network', spec({ provider: { network: 'managed' } })],
    ['an array network', spec({ provider: { network: [] } })],
    ['blank strings', spec({ provider: { network: { mode: '   ', networkName: '' } } })],
  ])('falls back to provider-managed for %s', (_label, value) => {
    // A cosmetic label must never fail a provision, so every malformed shape degrades
    // rather than throwing.
    expect(workspaceHostNetworkLabel(value)).toBe('provider-managed');
  });

  it('trims a padded network name', () => {
    expect(workspaceHostNetworkLabel(spec({ provider: { network: { networkName: '  net-c  ' } } }))).toBe('net-c');
  });
});
