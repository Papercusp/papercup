import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import type { PotCapabilityProviderBindingRow } from '../capability-class-registry-store';
import { compileLaunchSpecificationArtifact } from '../role-launch-spec';
import { resolveIdentityGrantEnvelope } from '../capability-envelope/blueprint-envelopes';

const providerState = vi.hoisted(() => ({ version: '1.0.0' as string | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../memory/hive-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/hive-scope')>()),
  resolvePotSlugsForHarnesses: vi.fn(async () => ['sales']),
}));
vi.mock('../capability-class-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capability-class-registry-store')>()),
  getPotCapabilityProviderBinding: vi.fn(async () => providerState.version ? binding(providerState.version) : null),
}));

const CLASS = 'crm.email@1.0.0';
function binding(version: string): PotCapabilityProviderBindingRow {
  return {
    classRef: CLASS, providerPackage: 'acme-mail', providerVersion: version,
    conformanceRunId: `run-${version}`, registryRevision: 'registry-1',
    verbBindings: { send: 'acme:send' }, status: 'active', conformanceStatus: 'passed',
    behavioralStatus: 'not-required', behavioralRunRef: null,
    potSlug: 'sales', boundBy: 'owner', boundAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
  };
}

describe('selected identity capability declaration at launch', () => {
  it('pins its provider in the final artifact, intersects the host ceiling, and refuses an unbound requirement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-capability-launch-'));
    const identityId = 'mail-domain';
    const identityDir = join(root, '.papercusp', 'blueprints', identityId);
    try {
      mkdirSync(identityDir, { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), stringifyYaml({
        id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        grants: { requires: [CLASS] },
        knobs: { aiBackend: { default: { model: 'selected-mail-model' } } },
      }));
      const compile = () => compileLaunchSpecificationArtifact({
        promptText: 'Mail worker.', cwd: root, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: [`domain:${identityId}`],
        state: { schemaVersion: 1 },
      });
      providerState.version = '1.0.0';
      const launch = await compile();
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('workItem');
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('spine');
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('fleet');
      expect(launch.specificationArtifact.configuration.roles ?? []).toEqual([]);
      expect(launch.specificationArtifact.configuration.grants?.requires).toContain(CLASS);
      expect(launch.specificationArtifact.configuration.knobs?.aiBackend?.default?.model).toBe('selected-mail-model');
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'capability-provider', ref: CLASS, providerVersion: '1.0.0',
      }));
      const host = (ceilings: Array<{ allowCapabilities: string[] }>, current = binding('1.0.0')) =>
        resolveIdentityGrantEnvelope({
          specification: launch.specificationArtifact,
          appliedSpecificationRevision: launch.specificationRevision,
          policyRevision: 'policy-1', potSlug: 'sales', bindings: [current], ceilings,
          tools: new Map([['acme:send', ['mail:send']]]),
        });
      expect(host([{ allowCapabilities: ['mail:send'] }])).toMatchObject({
        applied: true, allowedTools: ['acme:send'], failures: [],
      });
      expect(host([{ allowCapabilities: [] }])).toMatchObject({
        allowedTools: [], failures: [{ cause: 'outside-ceiling' }],
      });
      expect(host([{ allowCapabilities: ['mail:send'] }], binding('2.0.0'))).toMatchObject({
        allowedTools: [], failures: [{ cause: 'provider-changed' }],
      });
      providerState.version = '2.0.0';
      expect((await compile()).specificationRevision).not.toBe(launch.specificationRevision);
      providerState.version = null;
      await expect(compile()).rejects.toThrow(/required capability class has no active pot provider binding/);
    } finally {
      providerState.version = '1.0.0';
      rmSync(root, { recursive: true, force: true });
    }
  });
});
