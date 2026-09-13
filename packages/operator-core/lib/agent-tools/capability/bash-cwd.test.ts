/**
 * capability:bash's implicit cwd recovery (EI-21348591616256409).
 *
 * The shared base-dir resolver must keep returning a missing projectDir for the
 * other capability tools. Bash alone may recover its implicit child cwd to an
 * existing integration root, because node's child_process spawn rejects a
 * missing cwd before the command can run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({
  startBackground: vi.fn((opts: { command: string; cwd: string }) => ({
    id: 'bash-cwd-test',
    taskId: 'task-cwd-test',
    command: opts.command,
    cwd: opts.cwd,
    status: 'completed' as const,
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    totalBytes: 0,
    logPath: '/tmp/capability-bash-cwd-test.log',
    timeoutMs: 10_000,
    deadlineAt: 10_001,
  })),
  waitForJobResponse: vi.fn(async () => 'terminal' as const),
  snapshotJobResult: vi.fn(() => ({
    status: 'completed' as const,
    exitCode: 0,
    durationMs: 1,
    output: '',
    truncated: false,
    totalBytes: 0,
    logPath: '/tmp/capability-bash-cwd-test.log',
  })),
}));

vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: jobs.startBackground,
  waitForJobResponse: jobs.waitForJobResponse,
  snapshotJobResult: jobs.snapshotJobResult,
}));

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool, { missingBashCwdError, resolveBashDefaultCwd, suggestExistingCwd } from './bash';
import { startBackground } from './bash-jobs';

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
    vi.mocked(startBackground).mockClear();
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

    expect(vi.mocked(startBackground).mock.calls[0]?.[0]).toMatchObject({
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

    expect(vi.mocked(startBackground).mock.calls[0]?.[0]).toMatchObject({ cwd: realpathSync(projectDir) });
  });

  it('leaves explicit absolute and relative cwd arguments untouched', async () => {
    const staleProjectDir = join(root, 'stale-project');
    const explicitDir = join(root, 'explicit');
    mkdirSync(explicitDir);
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(root, 'integration-root');
    mkdirSync(process.env.PAPERCUSP_INTEGRATION_ROOT);

    await bash.handler({ command: 'true', cwd: explicitDir }, makeCtx(staleProjectDir));
    expect(vi.mocked(startBackground).mock.calls[0]?.[0]).toMatchObject({ cwd: explicitDir });

    vi.mocked(startBackground).mockClear();
    // The relative form resolves against the base dir with no recovery rerouting;
    // the resolved target must exist to clear the missing-cwd preflight.
    mkdirSync(resolve(staleProjectDir, 'relative-child'), { recursive: true });
    await bash.handler({ command: 'true', cwd: 'relative-child' }, makeCtx(staleProjectDir));
    expect(vi.mocked(startBackground).mock.calls[0]?.[0]).toMatchObject({
      cwd: resolve(staleProjectDir, 'relative-child'),
    });
  });

  it('preserves the stale base dir when no existing integration root is available', () => {
    const staleProjectDir = join(root, 'stale-project');
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(root, 'missing-integration-root');

    expect(resolveBashDefaultCwd(staleProjectDir)).toBe(staleProjectDir);
  });
});

/**
 * The missing-cwd preflight (EI-21357058090189702): a nonexistent final cwd
 * must fail with its real cause BEFORE any spawn — Node's own failure for it
 * is a misleading ENOENT naming the BINARY (`spawn /usr/bin/bash ENOENT`),
 * which reads as "bash is missing" and was misdiagnosed exactly that way.
 */
describe('capability:bash — missing-cwd preflight', () => {
  let root: string;
  let originalIntegrationRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capability-bash-cwd-preflight-'));
    originalIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    vi.mocked(startBackground).mockClear();
  });

  afterEach(() => {
    if (originalIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = originalIntegrationRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an unrecoverable implicit cwd with the real cause, before any spawn', async () => {
    const phantomProjectDir = join(root, 'phantom-repo-root');
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(root, 'also-missing');

    await expect(bash.handler({ command: 'printf ok' }, makeCtx(phantomProjectDir))).rejects.toThrow(
      /implicit cwd '.*phantom-repo-root' \(this context's project dir\) does not exist/,
    );
    await expect(bash.handler({ command: 'printf ok' }, makeCtx(phantomProjectDir))).rejects.toThrow(
      /spawn \/usr\/bin\/bash ENOENT/,
    );
    expect(vi.mocked(startBackground)).not.toHaveBeenCalled();
  });

  it('rejects an explicit missing cwd with the real cause, in background mode too', async () => {
    const goodProjectDir = join(root, 'project');
    mkdirSync(goodProjectDir);
    const missingExplicit = join(root, 'no-such-dir');

    await expect(bash.handler({ command: 'printf ok', cwd: missingExplicit }, makeCtx(goodProjectDir))).rejects.toThrow(
      /cwd '.*no-such-dir' does not exist/,
    );
    await expect(
      bash.handler({ command: 'printf ok', cwd: missingExplicit, run_in_background: true }, makeCtx(goodProjectDir)),
    ).rejects.toThrow(/does not exist/);
    expect(vi.mocked(startBackground)).not.toHaveBeenCalled();
  });

  it('rejects a cwd that exists but is not a directory', async () => {
    const goodProjectDir = join(root, 'project');
    mkdirSync(goodProjectDir);
    const filePath = join(root, 'a-file');
    writeFileSync(filePath, 'not a dir\n');

    await expect(bash.handler({ command: 'printf ok', cwd: filePath }, makeCtx(goodProjectDir))).rejects.toThrow(
      /exists but is not a directory/,
    );
  });

  it('missingBashCwdError returns null for an existing directory', () => {
    expect(missingBashCwdError(root, false)).toBeNull();
    expect(missingBashCwdError(root, true)).toBeNull();
  });
});

/**
 * The "did you mean" repair (EI-21859036061097062): the measured incident shape is a
 * near-miss transposition deep in an explicit cwd, e.g. `papercuspai-workspace` for the
 * real `papercupai-workspace`. The bare preflight above named the failure with nothing
 * to correct FROM; this reconstructs and verifies a corrected path before suggesting it.
 */
describe('capability:bash — cwd "did you mean" repair', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capability-bash-cwd-suggest-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('suggests the real sibling for a one-letter-off ancestor segment, with the tail preserved', () => {
    mkdirSync(join(root, 'papercupai-workspace', 'papercusp'), { recursive: true });
    const typoed = join(root, 'papercuspai-workspace', 'papercusp');
    expect(suggestExistingCwd(typoed)).toBe(join(root, 'papercupai-workspace', 'papercusp'));
  });

  it('surfaces the suggestion inside missingBashCwdError for an explicit cwd', () => {
    mkdirSync(join(root, 'papercupai-workspace', 'papercusp'), { recursive: true });
    const typoed = join(root, 'papercuspai-workspace', 'papercusp');
    expect(missingBashCwdError(typoed, true)).toMatch(
      new RegExp(`Did you mean '${join(root, 'papercupai-workspace', 'papercusp').replace(/[/\\]/g, '.')}'`),
    );
  });

  it('says nothing when no sibling is a close match — never guesses', () => {
    mkdirSync(join(root, 'completely-unrelated-name'));
    expect(suggestExistingCwd(join(root, 'nonexistent-thing', 'sub'))).toBeUndefined();
  });

  it('says nothing when TWO siblings are equally close — ambiguity is not a guess', () => {
    mkdirSync(join(root, 'papercupai-workspace'));
    mkdirSync(join(root, 'papercuspai-workspacf')); // also one edit away from the typo below
    expect(suggestExistingCwd(join(root, 'papercuspal-workspace', 'x'))).toBeUndefined();
  });

  it('says nothing when the reconstructed path still does not exist', () => {
    // The ancestor segment matches, but the tail below it was never created — the
    // rebuilt full path must be verified, not merely the matched segment.
    mkdirSync(join(root, 'papercupai-workspace'));
    expect(suggestExistingCwd(join(root, 'papercuspai-workspace', 'papercusp', 'nope'))).toBeUndefined();
  });
});
