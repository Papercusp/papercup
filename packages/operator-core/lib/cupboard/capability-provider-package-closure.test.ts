import { describe, expect, it } from 'vitest';
import { buildPackCatalogView, type PackDescriptor } from '@papercusp/blueprint-distribution';
import type { CapabilityProviderSelection } from './capability-grant-resolver';
import type { DerivedPackCatalog } from './pack-catalog';
import type { InstallPluginManifestReview } from './install-plugin-core';
import {
  installCapabilityProviderPackageClosure,
  reviewCapabilityProviderPackageClosure,
} from './capability-provider-package-closure';

const selection = (providerPackage: string, providerVersion: string, classRef: string): CapabilityProviderSelection => ({
  providerPackage,
  providerVersion,
  providerKind: 'tool',
  classRef,
  reason: 'explicit-selection',
  disclosureRequired: false,
});

const manifestReview = (
  name: string,
  version: string,
  kind: 'plugin' | 'pack',
  overrides: Partial<InstallPluginManifestReview> = {},
): InstallPluginManifestReview => ({
  name,
  version,
  kind,
  capabilities: [],
  dependencies: { tools: [], packs: [], plugins: [], events: [] },
  ...overrides,
});

function catalog(installed: PackDescriptor[], cupboard: PackDescriptor[]): DerivedPackCatalog {
  const builtinTools = new Set<string>();
  const view = buildPackCatalogView([...installed, ...cupboard], builtinTools);
  return { view, packs: view.packs, builtinTools, cupboardReachable: true };
}

describe('capability provider package closure', () => {
  it('sandbox-reviews the selected provider and its full transitive install set', async () => {
    const cupboard = new Map<string, PackDescriptor>([
      ['crm-provider', {
        name: 'crm-provider', kind: 'plugin', hasRuntime: true, source: 'cupboard',
        listingId: 'listing-crm', tools: ['crm.send'],
      }],
      ['audit-pack', {
        name: 'audit-pack', kind: 'pack', hasRuntime: false, source: 'cupboard',
        listingId: 'listing-audit', tools: ['audit.write'],
      }],
    ]);
    const reviews = new Map<string, InstallPluginManifestReview>([
      ['crm-provider', manifestReview('crm-provider', '2.0.0', 'plugin', {
        capabilities: ['net:fetch'],
        dependencies: { tools: ['audit.write'], packs: [], plugins: [], events: [] },
      })],
      ['audit-pack', manifestReview('audit-pack', '1.3.0', 'pack')],
    ]);

    const result = await reviewCapabilityProviderPackageClosure(
      [selection('crm-provider', '2.0.0', 'crm.email@1.0.0')],
      {
        deriveCatalog: async () => catalog([], [...cupboard.values()]),
        reviewUnit: async (unit) => {
          const review = reviews.get(unit.name)!;
          return { ok: true, review };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.roots).toMatchObject([{ providerPackage: 'crm-provider', status: 'installable' }]);
    expect(result.units.map((unit) => unit.name)).toEqual(['crm-provider', 'audit-pack']);
    expect(result.units[0]?.review.capabilities).toEqual(['net:fetch']);
  });

  it('installs only the reviewed allow-list and refuses a newly appearing transitive unit', async () => {
    const cupboard: PackDescriptor[] = [
      { name: 'crm-provider', kind: 'plugin', hasRuntime: true, source: 'cupboard', listingId: 'crm', tools: [] },
      { name: 'surprise', kind: 'plugin', hasRuntime: true, source: 'cupboard', listingId: 'surprise', tools: [] },
    ];
    const reviewed = manifestReview('crm-provider', '2.0.0', 'plugin');
    const review = {
      ok: true,
      roots: [{
        providerPackage: 'crm-provider', providerVersion: '2.0.0', classRefs: ['crm.email@1.0.0'],
        kind: 'plugin' as const, status: 'installable' as const, listingId: 'crm',
      }],
      units: [{ name: 'crm-provider', version: '2.0.0', kind: 'plugin' as const, listingId: 'crm', review: reviewed }],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 1,
    };
    const installed = new Set<string>();
    const result = await installCapabilityProviderPackageClosure(review, {
      deriveCatalog: async () => catalog(
        cupboard.filter((unit) => installed.has(unit.name)).map((unit) => ({ ...unit, source: 'installed' as const })),
        cupboard.filter((unit) => !installed.has(unit.name)),
      ),
      reviewUnit: async () => ({ ok: false, error: 'unused' }),
      installUnit: async (unit) => {
        installed.add(unit.name);
        return unit.name === 'crm-provider'
          ? {
              ok: true,
              review: reviewed,
              declaredDeps: { plugins: ['surprise'] },
            }
          : { ok: true, review: manifestReview(unit.name, '1.0.0', 'plugin') };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.receipts.map((unit) => unit.name)).toEqual(['crm-provider']);
    expect(result.advisory.join(' ')).toContain('not present in the consented provider review set');
    expect(installed.has('surprise')).toBe(false);
  });

  it('reuses an exact installed provider without inventing an install review', async () => {
    const installed: PackDescriptor = {
      name: 'crm-provider', version: '2.0.0', kind: 'plugin', hasRuntime: true,
      source: 'installed', tools: ['crm.send'],
    };
    const result = await reviewCapabilityProviderPackageClosure(
      [selection('crm-provider', '2.0.0', 'crm.email@1.0.0')],
      {
        deriveCatalog: async () => catalog([installed], []),
        reviewUnit: async () => ({ ok: false, error: 'must not run' }),
      },
    );
    expect(result).toMatchObject({ ok: true, units: [], roots: [{ status: 'installed' }] });
  });

  it('refuses when a different provider version lands between review and consent', async () => {
    const expected = manifestReview('crm-provider', '2.0.0', 'plugin');
    const review = {
      ok: true,
      roots: [{
        providerPackage: 'crm-provider', providerVersion: '2.0.0', classRefs: ['crm.email@1.0.0'],
        kind: 'plugin' as const, status: 'installable' as const, listingId: 'crm',
      }],
      units: [{ name: 'crm-provider', version: '2.0.0', kind: 'plugin' as const, listingId: 'crm', review: expected }],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 1,
    };
    const installUnit = async () => ({ ok: true as const, review: expected });
    const result = await installCapabilityProviderPackageClosure(review, {
      deriveCatalog: async () => catalog([{
        name: 'crm-provider', version: '3.0.0', kind: 'plugin', hasRuntime: true,
        source: 'installed', tools: [],
      }], []),
      reviewUnit: async () => ({ ok: false, error: 'unused' }),
      installUnit,
    });

    expect(result.ok).toBe(false);
    expect(result.advisory.join(' ')).toContain('current installed version is 3.0.0');
  });
});
