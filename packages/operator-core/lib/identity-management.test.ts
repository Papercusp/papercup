import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { diffIdentitySpecifications, resolveIdentityStackMutation } from './identity-management';
import { getIdentitySource, listIdentitySources } from './agent-identities/source';
import type { SuLaunchSpecRecord } from './su-persona-render';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..', '..', '..');

function artifact(configuration: Record<string, unknown>, sourceRevision = 'rev-a') {
  return {
    schemaVersion: 1,
    specificationRevision: 'a'.repeat(64),
    compilerVersion: 'test',
    source: { id: 'test', kind: 'harness', contentHash: 'b'.repeat(64) },
    configuration,
    inputs: [],
    provenance: [{ path: 'roles[0].stack[0]', sourceRef: 'identity:test', sourceRevision }],
  } as unknown as ResolvedAgentSpecification;
}

function record(over: Partial<SuLaunchSpecRecord> = {}): SuLaunchSpecRecord {
  return {
    v: 1,
    agent: 'codex',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: 'full',
    model: null,
    planSlug: null,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: null,
    stack: [],
    ...over,
  };
}

describe('identity management service', () => {
  it('preserves the installed-source attestation diagnostic instead of returning an empty preview error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-preview-diagnostic-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    const identityId = 'zz-preview-unattested';
    try {
      process.env.PAPERCUSP_HOME = root;
      const dir = join(root, 'blueprints', identityId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'blueprint.yaml'), `id: ${identityId}\nslots:\n  - slot: domain\n`);
      const source = await getIdentitySource(identityId);
      expect(source).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: 'attestation-missing' })],
      });
      await expect(resolveIdentityStackMutation({
        workspaceId: 'papercusp-workspace', ownerId: 'su-test', action: 'preview',
        identityId, slot: 'domain', operatorBaseUrl: 'http://127.0.0.1:3170', modeSection: '',
      }, record(), null)).rejects.toThrow(/attestation-missing:.*no publisher attestation/);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the simple not-found error when no identity source resolves', async () => {
    await expect(resolveIdentityStackMutation({
      workspaceId: 'papercusp-workspace', ownerId: 'su-test', action: 'preview',
      identityId: 'zz-no-such-preview-identity', slot: 'domain',
      operatorBaseUrl: 'http://127.0.0.1:3170', modeSection: '',
    }, record(), null)).rejects.toThrow('identity-not-found');
  });

  it('projects authoritative slot cardinality for the UI instead of making the client restate the registry', async () => {
    const catalog = await listIdentitySources({ repoDir, limit: 100 });
    const engineer = catalog.identities.find((identity) => identity.id === 'papercusp-engineer');

    expect(engineer?.slots).toContainEqual({ slot: 'domain', cardinality: 'exclusive' });
  });

  it('diffs effective configuration without shipping prompt bytes to the table', () => {
    const rows = diffIdentitySpecifications(
      artifact({ roles: [{ id: 'su', stack: [] }] }),
      artifact({ roles: [{ id: 'su', stack: ['domain:research-steward'] }] }, 'rev-b'),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        field: 'configuration.roles[0].stack[0]',
        applied: null,
        selected: 'domain:research-steward',
        origin: null,
      }),
    );
  });

  it('a real alternative domain switch is fresh-context and replaces the exclusive holder', async () => {
    const result = await resolveIdentityStackMutation(
      {
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        action: 'switch',
        identityId: 'research-steward',
        slot: 'domain',
        operatorBaseUrl: 'http://127.0.0.1:3070',
        modeSection: '',
      },
      record({ stack: ['domain:papercusp-engineer'] }),
      repoDir,
    );
    expect(result).toMatchObject({
      changed: true,
      delivery: 'relaunch-with-carry',
      replaced: 'papercusp-engineer',
      stack: ['domain:research-steward'],
    });
  });

  it('rollback selects the bounded prior launch receipt, not a new store', async () => {
    const result = await resolveIdentityStackMutation(
      {
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        action: 'rollback',
        operatorBaseUrl: 'http://127.0.0.1:3070',
        modeSection: '',
      },
      record({
        stack: ['domain:research-steward'],
        identityHistory: [
          {
            stack: ['domain:papercusp-engineer'],
            specificationRevision: 'c'.repeat(64),
            stateRevision: 'old-state',
            specificationArtifact: artifact({}),
            recordedAt: '2026-09-09T00:00:00.000Z',
          },
        ],
      }),
      repoDir,
    );
    expect(result.stack).toEqual(['domain:papercusp-engineer']);
    expect(result.delivery).toBe('relaunch-with-carry');
  });
});
