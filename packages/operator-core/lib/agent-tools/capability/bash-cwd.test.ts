/**
 * capability:bash's implicit cwd recovery (EI-21348591616256409).
 *
 * The shared base-dir resolver must keep returning a missing projectDir for the
 * other capability tools. Bash alone may recover its implicit child cwd to an
 * existing integration root, because node's child_process spawn rejects a
 * missing cwd before the command can run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  runForeground: vi.fn(async () => ({
    status: 'completed' as const,
    exitCode: 0,
    durationMs: 1,
    output: '',
    truncated: false,
    totalBytes: 0,
    logPath: '/tmp/capability-bash-cwd-test.log',
  })),
}));

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool, { resolveBashDefaultCwd } from './bash';
import { runForeground } from './bash-jobs';

type Tool = {
  handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

const bash = bashTool as unknown as Tool;

function makeCtx(projectDir: string) {
  return {
    projectDir,
    stateDir: projectDir,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

describe('capability:bash — stale implicit cwd recovery', () => {
  let root: string;
  let originalIntegrationRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capability-bash-cwd-'));
    originalIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    vi.mocked(runForeground).mockClear();
  });

  afterEach(() => {
    if (originalIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = originalIntegrationRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('recovers a missing base dir to an existing integration root', async () => {
    const staleProjectDir = join(root, 'stale-project');
    const integrationRoot = join(root, 'integration-root');
    mkdirSync(integrationRoot);
    process.env.PAPERCUSP_INTEGRATION_ROOT = integrationRoot;

    await bash.handler({ command: 'true' }, makeCtx(staleProjectDir));

    expect(vi.mocked(runForeground).mock.calls[0]?.[0]).toMatchObject({
      cwd: realpathSync(integrationRoot),
    });
  });

  it('keeps a valid projectDir ahead of the integration-root fallback', async () => {
    const projectDir = join(root, 'project');
    const integrationRoot = join(root, 'integration-root');
    mkdirSync(projectDir);
    mkdirSync(integrationRoot);
    process.env.PAPERCUSP_INTEGRATION_ROOT = integrationRoot;

    await bash.handler({ command: 'true' }, makeCtx(projectDir));

    expect(vi.mocked(runForeground).mock.calls[0]?.[0]).toMatchObject({ cwd: realpathSync(projectDir) });
  });

  it('leaves explicit absolute and relative cwd arguments untouched', async () => {
    const staleProjectDir = join(root, 'stale-project');
    const explicitDir = join(root, 'explicit');
    mkdirSync(explicitDir);
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(root, 'integration-root');
    mkdirSync(process.env.PAPERCUSP_INTEGRATION_ROOT);

    await bash.handler({ command: 'true', cwd: explicitDir }, makeCtx(staleProjectDir));
    expect(vi.mocked(runForeground).mock.calls[0]?.[0]).toMatchObject({ cwd: explicitDir });

    vi.mocked(runForeground).mockClear();
    await bash.handler({ command: 'true', cwd: 'relative-child' }, makeCtx(staleProjectDir));
    expect(vi.mocked(runForeground).mock.calls[0]?.[0]).toMatchObject({
      cwd: resolve(staleProjectDir, 'relative-child'),
    });
  });

  it('preserves the stale base dir when no existing integration root is available', () => {
    const staleProjectDir = join(root, 'stale-project');
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(root, 'missing-integration-root');

    expect(resolveBashDefaultCwd(staleProjectDir)).toBe(staleProjectDir);
  });
});
