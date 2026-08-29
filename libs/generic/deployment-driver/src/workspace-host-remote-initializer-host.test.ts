import { describe, expect, it } from 'vitest';

import {
  WorkspaceHostOperationError,
  createProductionWorkspaceHostRemoteInitializerDeps,
  type WorkspaceHostCommandInput,
  type WorkspaceHostSystem,
} from './workspace-host-remote-initializer-host';
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
} from './workspace-host-credential-namespace';

const MATERIAL_ROOT = '/credentials';
const MATERIAL_PATH = `${MATERIAL_ROOT}/git-short-lived-delegation/7/material`;
const AUTHORIZATION_MATERIAL = 'https://git-user:private-token-value@github.com';
const NOW = new Date('2026-08-26T22:00:00.000Z');

class RecordingSystem implements WorkspaceHostSystem {
  readonly commands: WorkspaceHostCommandInput[] = [];
  readonly present = new Set<string>();

  async run(input: WorkspaceHostCommandInput) {
    this.commands.push(input);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async ensureDirectory(path: string) {
    this.present.add(path);
  }
  async pathExists(path: string) {
    return this.present.has(path);
  }
  async removePath(path: string) {
    this.present.delete(path);
  }
}

function gitBinding(expiresAt = '2026-08-26T23:00:00.000Z') {
  const fields = { forge: 'github', owner: 'papercupai', repository: 'private-canary' };
  return {
    channel: 'git' as const,
    credentialRef: {
      kind: 'git' as const,
      ref: buildWorkspaceHostCredentialReference('git-short-lived-delegation', fields),
    },
    delivery: {
      kind: 'short-lived-delegation' as const,
      generation: 7,
      audience: 'workspace-host-canary',
      expiresAt,
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        'git-short-lived-delegation',
        fields,
        7,
      ),
    },
    requestedAt: '2026-08-26T21:00:00.000Z',
  };
}

function fixture() {
  const system = new RecordingSystem();
  const deps = createProductionWorkspaceHostRemoteInitializerDeps({
    system,
    workspaceRoot: '/workspaces',
    credentialMaterialRoot: MATERIAL_ROOT,
    now: () => NOW,
  });
  return { system, deps };
}

describe('ProductionWorkspaceHostRemoteInitializerHost private Git credentials', () => {
  it('consumes only bound git-channel material outside argv and public evidence', async () => {
    const { system, deps } = fixture();
    system.present.add(MATERIAL_PATH);
    system.present.add('/workspaces/repository/.git');
    await deps.credentials.run('bind', gitBinding());

    const evidence = await deps.host.cloneRepository({
      repositoryUrl: 'https://github.com/papercupai/private-canary.git',
      visibility: 'private',
      destination: 'repository',
      credentialChannel: 'git',
    });

    expect(system.commands).toHaveLength(1);
    const command = system.commands[0]!;
    expect(command.args).toEqual([
      'clone',
      '--quiet',
      'https://github.com/papercupai/private-canary.git',
      '/workspaces/repository',
    ]);
    expect(command.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: `store --file=${MATERIAL_PATH}`,
    });
    expect(JSON.stringify(command.args)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(JSON.stringify(evidence)).not.toContain(MATERIAL_PATH);
    expect(JSON.stringify(evidence)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(evidence).toMatchObject({
      visibility: 'private',
      credentialChannel: 'git',
      cloned: true,
    });
  });

  it('fails closed before spawning git when bound material is absent', async () => {
    const { system, deps } = fixture();
    system.present.add(MATERIAL_PATH);
    await deps.credentials.run('bind', gitBinding());
    system.present.delete(MATERIAL_PATH);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: 'https://github.com/papercupai/private-canary.git',
        visibility: 'private',
        destination: 'repository',
        credentialChannel: 'git',
      }),
    ).rejects.toThrow('bound git credential material is absent');
    expect(system.commands).toEqual([]);
  });

  it('refuses a private clone routed through any channel other than git', async () => {
    const { system, deps } = fixture();

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: 'https://github.com/papercupai/private-canary.git',
        visibility: 'private',
        destination: 'repository',
        credentialChannel: 'cloud',
      }),
    ).rejects.toThrow("must consume the bound 'git' credential channel");
    expect(system.commands).toEqual([]);
  });

  it('fails closed before spawning git when bound material is expired', async () => {
    const { system, deps } = fixture();
    system.present.add(MATERIAL_PATH);
    await deps.credentials.run('bind', gitBinding('2026-08-26T21:59:59.000Z'));

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: 'https://github.com/papercupai/private-canary.git',
        visibility: 'private',
        destination: 'repository',
        credentialChannel: 'git',
      }),
    ).rejects.toThrow('bound git credential material has expired');
    expect(system.commands).toEqual([]);
  });

  it('fails closed before spawning git after the active binding is revoked', async () => {
    const { system, deps } = fixture();
    const binding = gitBinding();
    system.present.add(MATERIAL_PATH);
    await deps.credentials.run('bind', binding);
    await deps.credentials.run('revoke', binding);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: 'https://github.com/papercupai/private-canary.git',
        visibility: 'private',
        destination: 'repository',
        credentialChannel: 'git',
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostOperationError);
    expect(system.commands).toEqual([]);
  });
});
