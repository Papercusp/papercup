import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './install-blueprint';
import { gateInstallDoor } from '../../cupboard/install-door-gate-io';
import { installBlueprintFromCupboard } from '../../cupboard/install-blueprint-io';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../cupboard/install-door-gate-io', () => ({ gateInstallDoor: vi.fn() }));
vi.mock('../../cupboard/install-blueprint-io', () => ({ installBlueprintFromCupboard: vi.fn() }));

const mockGate = vi.mocked(gateInstallDoor);
const mockInstall = vi.mocked(installBlueprintFromCupboard);

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
        record: { id: 'identity', version: '1.0.0' },
        installedTo: '/blueprints/identity',
        diff: { promptText: [], burnKnobs: [] },
        activationRequired: true,
      },
    } as never);

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
        removed: { id: 'identity', version: '2.0.0' },
        retained: [
          { id: 'identity', version: '1.0.0' },
          { id: 'identity', version: '2.0.0' },
        ],
        diff: { promptText: [], burnKnobs: [] },
        activationRequired: true,
      },
    } as never);

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
        abstract: true,
        source: 'repo',
        installedTo: '/blueprints/identity',
        dependencies: { tools: [], packs: [], plugins: [], blueprints: [] },
        depCheck: null,
        operation: 'update',
        release: { version: '2.0.0', contentHash: `sha256:${'a'.repeat(64)}`, packageContentHash: 'b'.repeat(64) },
        diff: { promptText: [{ path: 'identity/prompts/p.md', patch: '-old\n+new' }], burnKnobs: [] },
        activationPreflight: { ok: true, candidate: { id: 'identity', slots: ['domain'] }, conflicts: [] },
        capabilityGrants: {
          ok: true,
          requirements: [{ classRef: 'crm.email@1.0.0', state: 'choosable' }],
          selected: [{
            classRef: 'crm.email@1.0.0',
            providerPackage: 'acme-crm',
            providerVersion: '2.0.0',
            reason: 'explicit-selection',
            disclosureRequired: true,
          }],
          disclosures: ['Selected acme-crm@2.0.0 for crm.email@1.0.0 by explicit-selection.'],
        },
        pluginInstalls: [],
        blueprintInstalls: [],
      },
    } as never);

    const result = await call({
      operation: 'update',
      listingId: 'listing',
      activationStack: ['practice'],
      potSlug: 'sales-ops',
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
    });
  });
});
