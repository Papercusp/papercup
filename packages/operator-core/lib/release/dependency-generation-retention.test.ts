import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDependencyGenerationRetention } from './dependency-generation-retention';

const registry = vi.hoisted(() => ({
  read: vi.fn(),
  load: vi.fn(),
  contentPath: vi.fn(),
  integrationRoot: vi.fn(),
}));
vi.mock('../workspace-registry', () => ({ readRegistry: registry.read }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: registry.load,
  resolveHarnessContentPath: registry.contentPath,
}));
vi.mock('../harness/routines/release-actions', () => ({ resolveIntegrationRoot: registry.integrationRoot }));
// WI-10007542: the prune start runs behind governed admission. The seam is faked so this
// unit suite never reaches the durable admission tables.
const governed = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../resource-governor/execution', () => ({ runGovernedOperation: governed.run }));

let fixture: string;
let integration: string;
let output: string;
let script: string;

beforeEach(() => {
  vi.resetAllMocks();
  fixture = mkdtempSync(join(tmpdir(), 'dependency-retention-'));
  integration = join(fixture, 'integration');
  output = join(fixture, 'prune-arguments');
  script = join(fixture, 'tooling/apps/operator/bin/release/dependency-generation.sh');
  mkdirSync(integration, { recursive: true });
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, 'printf "%s\\n" "$@" >> "$PAPERCUSP_RETENTION_TEST_OUTPUT"\n');
  writeFileSync(output, '');
  vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', '');
  vi.stubEnv('PAPERCUSP_RETENTION_TEST_OUTPUT', output);
  registry.integrationRoot.mockReturnValue(join(fixture, 'tooling'));
  registry.read.mockReturnValue({ workspaces: [{ id: 'ws-1' }] });
  registry.load.mockResolvedValue({ projects: [{ slug: 'project' }] });
  registry.contentPath.mockReturnValue(integration);
  governed.run.mockImplementation((_input: unknown, start: (context: unknown) => Promise<unknown>) => start({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(fixture, { recursive: true, force: true });
});

function recordStore(store: string): void {
  mkdirSync(join(integration, '.papercusp'), { recursive: true });
  writeFileSync(join(integration, '.papercusp/dependency-generation-root'), `${store}\n`);
}

function pruneArguments(): string[] {
  return readFileSync(output, 'utf8').trim().split('\n').filter(Boolean);
}

describe('hourly dependency-generation retention discovery', () => {
  it('invokes prune-only for a recorded store without a legacy directory', async () => {
    const store = join(fixture, 'recorded-store');
    mkdirSync(store);
    recordStore(store);
    expect(existsSync(join(integration, '.papercusp/dependency-generations'))).toBe(false);

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only']);
  });

  it('discovers an environment-configured store ahead of a missing recorded store', async () => {
    const store = join(fixture, 'configured-store');
    mkdirSync(store);
    recordStore(join(fixture, 'missing-recorded-store'));
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', store);

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only']);
  });

  it('retains discovery of the default tree-local store', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only']);
  });

  it('skips a missing selected store even if an unused legacy directory exists', async () => {
    mkdirSync(join(integration, '.papercusp/dependency-generations'), { recursive: true });
    recordStore(join(fixture, 'missing-recorded-store'));

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
  });

  it('does not create or sweep stores that have never existed', async () => {
    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
    expect(existsSync(join(integration, '.papercusp'))).toBe(false);
    expect(governed.run).not.toHaveBeenCalled();
  });

  it('sweeps a shared integration root once across workspace registrations', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });
    registry.read.mockReturnValue({ workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }] });

    await runDependencyGenerationRetention();

    expect(registry.load).toHaveBeenCalledTimes(2);
    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only']);
    // One admission per swept root, owned by the first workspace that registered it.
    expect(governed.run).toHaveBeenCalledTimes(1);
    expect(governed.run.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      namespace: 'dependency-generation-retention',
      admissionClass: 'process',
      payloadRef: `dependency-generation-retention:${integration}`,
    });
  });

  it('starts no prune when governed admission refuses the root', async () => {
    mkdirSync(join(integration, '.papercusp/dependency-generations'), { recursive: true });
    governed.run.mockRejectedValueOnce(new Error('admission refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[dependency-generation-retention] ${integration}: admission refused`);
  });

  it('continues discovering stores after a workspace registry failure', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });
    registry.read.mockReturnValue({ workspaces: [{ id: 'broken' }, { id: 'ws-1' }] });
    registry.load.mockRejectedValueOnce(new Error('registry unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDependencyGenerationRetention();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace broken: registry unavailable'));
    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only']);
  });

  it('skips registry discovery when the maintained script is absent', async () => {
    rmSync(script);

    await runDependencyGenerationRetention();

    expect(registry.read).not.toHaveBeenCalled();
    expect(pruneArguments()).toEqual([]);
  });
});
