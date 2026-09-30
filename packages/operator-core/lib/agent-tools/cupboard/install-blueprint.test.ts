import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './install-blueprint';
import { gateInstallDoor } from '../../cupboard/install-door-gate-io';
import { installBlueprintFromCupboard } from '../../cupboard/install-blueprint-io';
import type { BlueprintReleaseRecord } from '../../cupboard/blueprint-release';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../cupboard/install-door-gate-io', () => ({ gateInstallDoor: vi.fn() }));
vi.mock('../../cupboard/install-blueprint-io', () => ({ installBlueprintFromCupboard: vi.fn() }));

const mockGate = vi.mocked(gateInstallDoor);
const mockInstall = vi.mocked(installBlueprintFromCupboard);

const releaseRecord = (version: string): BlueprintReleaseRecord => ({
  schemaVersion: 1,
  id: 'identity',
  version,
  contentHash: 'a'.repeat(64),
  artifactContentHash: 'b'.repeat(64),
  source: 'repo',
  installedAtMs: 0,
  slots: ['domain'],
  pins: [],
});

async function call(args: Record<string, unknown>) {
  const result = await (
    tool as unknown as {
      handler(args: unknown, ctx: unknown): Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { principal: { workspaceId: 'ws-principal' } });
  return JSON.parse(result.content[0]!.text);
}

describe('cupboard:install-blueprint lifecycle wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGate.mockResolvedValue({ ok: true, mode: 'unmanaged', detail: 'free listing' });
  });

  it('routes rollback through the shared release gate and immutable local history', async () => {
    mockInstall.mockResolvedValue({
      ok: true,
      result: {
        operation: 'rollback',
        record: releaseRecord('1.0.0'),
        installedTo: '/blueprints/identity',
        diff: { fromContentHash: null, toContentHash: 'a'.repeat(64), promptText: [], burnKnobs: [], grants: [] },
        activationRequired: true,
      },
    });

    const result = await call({ operation: 'rollback', blueprintId: 'identity', targetVersion: '1.0.0' });

    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        idOrRef: 'identity',
        kind: 'blueprint',
        subject: 'ws-principal',
        operation: 'rollback',
      }),
    );
    expect(mockInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rollback',
        blueprintId: 'identity',
        targetVersion: '1.0.0',
      }),
    );
    expect(result).toMatchObject({ ok: true, operation: 'rollback', activationRequired: true });
  });

  it('uninstalls locally without pretending byte delivery needs an entitlement gate', async () => {
    mockInstall.mockResolvedValue({
      ok: true,
      result: {
        operation: 'uninstall',
        removed: releaseRecord('2.0.0'),
        retained: [
          releaseRecord('1.0.0'),
          releaseRecord('2.0.0'),
        ],
        diff: { fromContentHash: 'a'.repeat(64), toContentHash: null, promptText: [], burnKnobs: [], grants: [] },
        activationRequired: true,
      },
    });

    const result = await call({ operation: 'uninstall', blueprintId: 'identity' });

    expect(mockGate).not.toHaveBeenCalled();
    expect(mockInstall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'uninstall', blueprintId: 'identity' }),
    );
    expect(result).toMatchObject({ ok: true, operation: 'uninstall', activationRequired: true });
  });

  it('returns immutable release identity, diffs and slot preflight for install/update', async () => {
    mockInstall.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        id: 'identity',
        version: '2.0.0',
        description: null,
        abstract: true,
        source: 'repo',
        installedTo: '/blueprints/identity',
        dependencies: { tools: [], packs: [], plugins: [], blueprints: [] },
        depCheck: null,
        operation: 'update',
        release: { version: '2.0.0', contentHash: `sha256:${'a'.repeat(64)}`, packageContentHash: 'b'.repeat(64) },
        diff: {
          fromContentHash: null,
          toContentHash: 'a'.repeat(64),
          promptText: [{ path: 'identity/prompts/p.md', beforeHash: null, afterHash: 'a'.repeat(64), patch: '-old\n+new' }],
          burnKnobs: [],
          grants: [],
        },
        activationPreflight: { ok: true, candidate: { id: 'identity', slots: ['domain'] }, conflicts: [] },
        classContracts: null,
        consent: {
          contentOnly: false,
          grants: ['crm.email@1.0.0'],
          providerBindings: ['crm.email@1.0.0 → crm-email-tool@1.0.0'],
          contextReads: [], rules: [], events: [], operations: [], pluginCode: [], sharedContent: [],
        },
        bindingJournal: {
          recovered: [],
          pots: [{ potSlug: 'sales-ops', dependentId: 'blueprint-install:abc', applied: true,
            bindings: ['crm.email@1.0.0 → acme-crm@2.0.0'], superseded: [] }],
          residue: [],
        },
        capabilityGrants: {
          ok: true,
          requirements: [{ classRef: 'crm.email@1.0.0', optional: false, state: 'choosable' }],
          satisfied: [],
          missingRequired: [],
          requiresChoice: [],
          missingOptional: [],
          selected: [{
            classRef: 'crm.email@1.0.0',
            providerPackage: 'acme-crm',
            providerVersion: '2.0.0',
            providerKind: 'tool',
            reason: 'explicit-selection',
            disclosureRequired: true,
          }],
          disclosures: ['Selected acme-crm@2.0.0 for crm.email@1.0.0 by explicit-selection.'],
        },
        capabilityProviderReview: {
          ok: true,
          roots: [{
            providerPackage: 'acme-crm', providerVersion: '2.0.0', status: 'installed',
            classRefs: ['crm.email@1.0.0'], kind: 'plugin', listingId: null,
          }],
          units: [],
          stillMissing: { tools: [], packs: [], plugins: [], events: [] },
          advisory: [],
          rounds: 0,
        },
        capabilityProviderInstalls: null,
        pluginInstalls: [],
        blueprintInstalls: [],
      },
    });

    const result = await call({
      operation: 'update',
      listingId: 'listing',
      activationStack: ['practice'],
      potSlug: 'sales-ops',
      capabilityRole: 'sales-worker',
      capabilityProviderSelections: { 'crm.email@1.0.0': 'acme-crm@2.0.0' },
    });

    expect(mockGate).toHaveBeenCalledWith(expect.objectContaining({ operation: 'install' }));
    expect(mockInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'update',
        listingId: 'listing',
        activationStack: ['practice'],
        workspaceId: 'ws-principal',
        potSlug: 'sales-ops',
        capabilityRole: 'sales-worker',
        capabilityMode: 'agent',
        capabilityProviderSelections: { 'crm.email@1.0.0': 'acme-crm@2.0.0' },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      operation: 'update',
      activationRequired: true,
      activationPreflight: { ok: true },
      diff: { promptText: [{ path: 'identity/prompts/p.md' }] },
      capabilityGrants: {
        selected: [{ providerPackage: 'acme-crm', disclosureRequired: true }],
      },
      capabilityProviderReview: {
        roots: [{ providerPackage: 'acme-crm', status: 'installed' }],
      },
    });
  });

  it('preserves the full provider package review on a consent-required refusal', async () => {
    mockInstall.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'capability_provider_install_consent_required',
      detail: 'selected capability provider packages require install consent after transitive review',
      data: {
        capabilityProviderReview: {
          ok: true,
          units: [
            { name: 'acme-crm', version: '2.0.0', review: { capabilities: ['net:fetch'] } },
            { name: 'audit-pack', version: '1.0.0', review: { capabilities: [] } },
          ],
        },
      },
    });

    const result = await call({
      listingId: 'identity-listing',
      potSlug: 'sales-ops',
      capabilityProviderSelections: { 'crm.email@1.0.0': 'acme-crm@2.0.0' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'capability_provider_install_consent_required',
      data: {
        capabilityProviderReview: {
          units: [{ name: 'acme-crm' }, { name: 'audit-pack' }],
        },
      },
    });
  });

  it('P-021: forwards class-contract consent and preserves the consent subject on refusal', async () => {
    const consentSubject = {
      artifactContentHash: 'b'.repeat(64),
      contracts: [{ ref: 'acme.ledger@1', contractHash: 'c'.repeat(64) }],
    };
    mockInstall.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'class_contract_consent_required',
      detail: 'blueprint "identity" carries 1 class contract(s) that need administrator consent',
      data: { consentSubject, contracts: [] },
    });
    const refused = await call({ listingId: 'identity-listing' });
    expect(mockInstall.mock.calls[0]![0]).not.toHaveProperty('classContractConsent');
    expect(refused).toMatchObject({ ok: false, status: 409, error: 'class_contract_consent_required', data: { consentSubject } });

    mockInstall.mockResolvedValueOnce({ ok: false, status: 422, error: 'class_contract_namespace-squat', detail: 'x' });
    const consent = { ...consentSubject, decision: 'approved' as const };
    await call({ listingId: 'identity-listing', classContractConsent: consent });
    expect(mockInstall.mock.calls[1]![0]).toMatchObject({ classContractConsent: consent });
  });

  it('preserves a role-ceiling refusal instead of presenting it as installation success', async () => {
    mockInstall.mockResolvedValue({
      ok: false, status: 403, error: 'capability_unsatisfied',
      detail: 'crm.email@1.0.0: outside-ceiling',
      data: { failures: [{ classRef: 'crm.email@1.0.0', cause: 'outside-ceiling' }] },
    });
    const result = await call({
      operation: 'install', listingId: 'identity-listing', potSlug: 'sales-ops', capabilityRole: 'read-only',
    });
    expect(mockInstall).toHaveBeenCalledWith(expect.objectContaining({ capabilityRole: 'read-only' }));
    expect(result).toMatchObject({
      ok: false, status: 403, error: 'capability_unsatisfied',
      data: { failures: [{ classRef: 'crm.email@1.0.0', cause: 'outside-ceiling' }] },
    });
  });
});
