import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectByocReleaseMilestones } from '@papercusp/operator-core/lib/byoc-release-carry';
import type { TaskReleaseJournal } from '@papercusp/operator-core/lib/task-manager/store';
import {
  OPERATION_ID,
  TASK_ID,
  memoryReleaseLedger,
} from '@papercusp/operator-core/lib/workspace-host/release-journal-test-support';
import {
  resolveWorkspaceHostReleaseBinding,
  WORKSPACE_HOST_RELEASE_CHANNEL,
} from '@papercusp/operator-core/lib/workspace-host/release-stage-receipt';

import { assertReleaseTaskIdentity, type ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  WORKSPACE_HOST_BUILD_STAGE,
  WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE,
  WorkspaceHostCutStepError,
  buildWorkspaceHostPublicationInput,
  buildWorkspaceHostReleaseJournalSeed,
  cupboardBaseOverride,
  packDeterministically,
  parseWorkspaceHostReleaseCutArgs,
  runWorkspaceHostReleaseCut,
  sha256OfFile,
  workspaceHostCutStageContext,
  type WorkspaceHostBuildResult,
  type WorkspaceHostReleaseCutDeps,
} from './workspace-host-release-cut-cli';

const SHA = '1'.repeat(40);
const DESKTOP_PIN = '2'.repeat(40);
const GITLINKS = { 'papercusp-desktop': DESKTOP_PIN, 'libs/papercusp': '3'.repeat(40) };
const VERSION = '0.0.21-p318r40';
const BUNDLE = '4'.repeat(64);

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wh-cut-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function buildResult(requestIdentity: string, bundle = BUNDLE): WorkspaceHostBuildResult {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    requestIdentity,
    sourceSha: SHA,
    version: VERSION,
    desktopVersion: '0.0.21',
    sourceEpochSeconds: 1_790_000_000,
    bundle: { sha256: bundle, bytes: 2_000_000_000 },
    signature: { sha256: '5'.repeat(64), bytes: 295 },
    signingKeySha256: '6'.repeat(64),
    evidence: {
      sbomSha256: '7'.repeat(64),
      vulnerabilitiesSha256: '8'.repeat(64),
      summarySha256: '9'.repeat(64),
      secretScanSha256: 'a'.repeat(64),
    },
  };
}

/**
 * The real journal writer behind an in-memory ledger that only exists once the cut registers its
 * task — exactly as in production, where the seed is the first write the operation makes.
 */
function harness(overrides: Partial<WorkspaceHostReleaseCutDeps> = {}) {
  let inner: ReturnType<typeof memoryReleaseLedger> | null = null;
  const ledger: ReleaseTaskLedger = {
    getTask: async (taskId) => (inner ? inner.getTask(taskId) : null),
    taskReleaseJournalFromDetail: (detail) => (inner ? inner.taskReleaseJournalFromDetail(detail) : null),
    appendTaskReleaseReceipt: async (taskId, cursor, input) => {
      if (!inner) throw new Error('no task registered');
      return inner.appendTaskReleaseReceipt(taskId, cursor, input);
    },
  };
  const calls = { builds: 0, manifests: 0, publishes: [] as Array<{ taskId: string; operationId: string; args: readonly string[] }> };
  let stored: WorkspaceHostBuildResult | null = null;
  const deps: WorkspaceHostReleaseCutDeps = {
    ledger,
    registerTask: async (spec) => {
      const seed = (spec.detail as { release: TaskReleaseJournal }).release;
      inner = memoryReleaseLedger(structuredClone(seed));
    },
    newTaskId: () => TASK_ID,
    newOperationId: () => OPERATION_ID,
    readGitlinks: () => ({ ...GITLINKS }),
    readDesktopVersion: () => '0.0.21',
    sourceEpochSeconds: () => 1_790_000_000,
    build: async (plan) => {
      calls.builds += 1;
      stored = buildResult(plan.requestIdentity);
      return stored;
    },
    verifyBuild: async () => {},
    readBuildResult: async () => stored,
    emitManifest: async ({ workDir: dir }) => {
      calls.manifests += 1;
      mkdirSync(join(dir, 'publication'), { recursive: true });
      writeFileSync(join(dir, 'publication', 'manifest.json'), '{}');
      return { trusted: true };
    },
    publish: async ({ taskId, operationId, args }) => {
      calls.publishes.push({ taskId, operationId, args });
    },
    log: () => {},
    ...overrides,
  };
  return {
    deps,
    calls,
    journal: () => inner!.journal,
    setStored: (value: WorkspaceHostBuildResult | null) => {
      stored = value;
    },
  };
}

const options = () => ({
  repoRoot: '/repo',
  workDir,
  sourceSha: SHA,
  version: VERSION,
  publish: true,
  publisherArgs: ['--plan-only'],
});

describe('managed workspace-host cut journal (D-394)', () => {
  it('seeds a label identity that the maintained writer accepts, and that a digest-bound caller refuses', () => {
    const identity = { sourceSha: SHA, gitlinks: GITLINKS, version: VERSION };
    const seed = buildWorkspaceHostReleaseJournalSeed(OPERATION_ID, identity) as unknown as TaskReleaseJournal;
    const ctx = workspaceHostCutStageContext(TASK_ID, OPERATION_ID, identity, memoryReleaseLedger(seed));
    expect(() => assertReleaseTaskIdentity(seed, ctx.identity)).not.toThrow();
    expect(seed.artifactIdentity).toMatchObject({ channel: WORKSPACE_HOST_RELEASE_CHANNEL, platform: 'linux-x86_64' });
    expect(() => assertReleaseTaskIdentity(seed, { ...ctx.identity, bundleSha256: BUNDLE })).toThrow(/digest/);
  });

  it('opens one task, commits the build with its digest, and the build milestone reads verified', async () => {
    const h = harness();
    const result = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(result).toMatchObject({ taskId: TASK_ID, operationId: OPERATION_ID, bundleSha256: BUNDLE, build: 'built', published: true });
    const build = h.journal().receipts.filter((entry) => entry.stage === WORKSPACE_HOST_BUILD_STAGE);
    expect(build.map((entry) => entry.state)).toEqual(['intent', 'committed']);
    expect(build[1]!.evidenceRefs).toContain(`bundle:sha256:${BUNDLE}`);

    const projection = projectByocReleaseMilestones(h.journal());
    expect(projection.milestones.find((entry) => entry.key === 'build')?.status).toBe('verified');
    // Every later stage binds to this task through the digest the build receipt names.
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: 'acceptance.soak-24h',
      hostRuntimeRelease: { bundleSha256: BUNDLE },
      ledger: h.deps.ledger,
    });
    expect(binding).toMatchObject({ bundleSha256: BUNDLE, version: VERSION, artifactLabel: { channel: WORKSPACE_HOST_RELEASE_CHANNEL } });
    // Publication rides the SAME task and operation.
    expect(h.calls.publishes).toEqual([{ taskId: TASK_ID, operationId: OPERATION_ID, args: ['--plan-only'] }]);
  });

  it('resumes from the work directory without rebuilding or re-emitting the manifest', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    const again = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(again.build).toBe('reused');
    expect(h.calls.builds).toBe(1);
    expect(h.calls.manifests).toBe(1);
    expect(h.journal().receipts.filter((entry) => entry.stage === WORKSPACE_HOST_BUILD_STAGE)).toHaveLength(2);
  });

  it('refuses to reuse a committed build whose bytes are gone', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    h.setStored(null);
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/cannot be re-produced/);
  });

  it('commits an interrupted build from its finished result instead of building again', async () => {
    let crash = true;
    const h = harness({
      build: async (plan) => {
        h.calls.builds += 1;
        h.setStored(buildResult(plan.requestIdentity));
        if (crash) throw new Error('process died after the result was written');
        return buildResult(plan.requestIdentity);
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/process died/);
    expect(h.journal().receipts.at(-1)?.state).toBe('intent');

    crash = false;
    const resumed = await runWorkspaceHostReleaseCut(options(), h.deps);
    expect(resumed.build).toBe('reconciled');
    expect(h.calls.builds).toBe(1);
    expect(h.journal().receipts.map((entry) => entry.state)).toEqual(['intent', 'committed']);
  });

  it('confirms an interrupted build absent when it left no result, then builds on a fresh request', async () => {
    let crash = true;
    const h = harness({
      build: async (plan) => {
        h.calls.builds += 1;
        if (crash) throw new Error('killed mid-sidecar');
        const result = buildResult(plan.requestIdentity);
        h.setStored(result);
        return result;
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/killed/);
    crash = false;
    const resumed = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(resumed.build).toBe('built');
    const states = h.journal().receipts.map((entry) => [entry.state, entry.evidenceRefs.includes('reconcile:confirmed-absent')]);
    expect(states).toEqual([['intent', false], ['refused', true], ['intent', false], ['committed', false]]);
    const identities = new Set(h.journal().receipts.map((entry) => entry.requestIdentity));
    expect(identities.size).toBe(2);
  });

  it('a leg that could not run is retryable; a refused verdict is final for this input', async () => {
    let failure: WorkspaceHostCutStepError | null = new WorkspaceHostCutStepError('sidecar-build', false, 'exited 1');
    const h = harness({
      build: async (plan) => {
        if (failure) throw failure;
        return buildResult(plan.requestIdentity);
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/sidecar-build/);
    failure = null;
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).resolves.toMatchObject({ build: 'built' });

    const gated = harness({
      build: async () => {
        throw new WorkspaceHostCutStepError('vulnerability-audit', true, 'High match');
      },
    });
    const other = mkdtempSync(join(tmpdir(), 'wh-cut-'));
    try {
      const opts = { ...options(), workDir: other };
      await expect(runWorkspaceHostReleaseCut(opts, gated.deps)).rejects.toThrow(/vulnerability-audit/);
      expect(gated.journal().receipts.at(-1)?.evidenceRefs).toEqual(['build:gated:vulnerability-audit']);
      await expect(runWorkspaceHostReleaseCut(opts, gated.deps)).rejects.toThrow(/refused for this input/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses to reuse a work directory for a different source or version', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    await expect(runWorkspaceHostReleaseCut({ ...options(), version: '0.0.21-p318r41' }, h.deps)).rejects.toThrow(/new --work-dir/);
  });

  it('refuses a manifest whose trust report is not trusted, and never publishes it', async () => {
    const h = harness({ emitManifest: async () => ({ trusted: false }) });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/not trusted/);
    expect(h.calls.publishes).toEqual([]);
  });
});

describe('deterministic pack', () => {
  function tree(root: string, mtime: number) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'apps/operator'), { recursive: true });
    writeFileSync(join(root, 'bin/node'), 'node');
    writeFileSync(join(root, 'apps/operator/serve.mjs'), 'serve');
    writeFileSync(join(root, 'zeta.json'), '{}');
    for (const path of ['bin/node', 'apps/operator/serve.mjs', 'zeta.json', 'bin', 'apps/operator', 'apps', '.']) {
      utimesSync(join(root, path), mtime, mtime);
    }
  }

  it('produces identical bytes for the same tree regardless of file times, with no build-box identity', async () => {
    const first = join(workDir, 'first');
    const second = join(workDir, 'second');
    tree(first, 1_700_000_000);
    tree(second, 1_750_000_000);
    await packDeterministically(first, 1_790_000_000, join(workDir, 'a.tgz'));
    await packDeterministically(second, 1_790_000_000, join(workDir, 'b.tgz'));

    const [a, b] = await Promise.all([sha256OfFile(join(workDir, 'a.tgz')), sha256OfFile(join(workDir, 'b.tgz'))]);
    expect(a.sha256).toBe(b.sha256);
    // Positive control: a different source time is a different pack, so equality above is not vacuous.
    await packDeterministically(first, 1_790_000_001, join(workDir, 'c.tgz'));
    expect((await sha256OfFile(join(workDir, 'c.tgz'))).sha256).not.toBe(a.sha256);

    const listing = execFileSync('tar', ['--list', '--verbose', '--numeric-owner', '--gzip', '--file', join(workDir, 'a.tgz')], {
      encoding: 'utf8',
    }).trim().split('\n');
    expect(listing.every((line) => line.split(/\s+/)[1] === '0/0')).toBe(true);
    const names = listing.map((line) => line.split(/\s+/).at(-1)!);
    expect(names).toEqual([...names].sort());
    // gzip -n: no embedded name and a zero header mtime (bytes 4..7).
    expect(readFileSync(join(workDir, 'a.tgz')).subarray(4, 8).readUInt32LE(0)).toBe(0);
  });
});

describe('publication input', () => {
  const facts = {
    version: VERSION,
    sourceSha: SHA,
    desktopVersion: '0.0.21',
    desktopRevision: DESKTOP_PIN,
    sourceRoot: '/work/source',
    bundleRoot: '/work/extracted',
  };

  it('fills the tracked template from measured facts and passes the manifest CLI parser', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    const input = buildWorkspaceHostPublicationInput(template, facts);
    expect(input.image.version).toBe(VERSION);
    expect(input.source.revision).toBe(SHA);
    expect(input.builder.version).toBe('0.0.21');
    expect(input.parameters).toContainEqual({ name: 'desktop_revision', value: DESKTOP_PIN });
    expect(input.materials).toContainEqual(
      expect.objectContaining({ path: 'bin/node', sourcePath: '/work/extracted/bin/node' }),
    );
    expect(input.materials).toContainEqual(
      expect.objectContaining({
        path: 'papercusp-desktop/bin/audit-release-bundle.py',
        sourcePath: '/work/source/papercusp-desktop/bin/audit-release-bundle.py',
      }),
    );
  });

  it('refuses a material with no origin, and a template that pins the measured desktop revision', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    expect(() =>
      buildWorkspaceHostPublicationInput({ ...template, materials: [{ path: 'bin/node' }] }, facts),
    ).toThrow(/'source' or 'bundle'/);
    expect(() =>
      buildWorkspaceHostPublicationInput(
        { ...template, parameters: [...template.parameters, { name: 'desktop_revision', value: 'x' }] },
        facts,
      ),
    ).toThrow(/desktop_revision/);
  });
});

describe('CLI args', () => {
  it('passes publisher flags through and rejects unknown flags', () => {
    expect(
      parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x', '--base', 'https://b', '--plan-only'], {}),
    ).toMatchObject({ sourceSha: SHA, publish: true, publisherArgs: ['--base', 'https://b', '--plan-only'] });
    expect(() => parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--nope', 'x'], {})).toThrow(/unknown flag/);
    expect(() => parseWorkspaceHostReleaseCutArgs(['--version', VERSION, '--work-dir', '/tmp/x'], {})).toThrow(/--source-sha/);
  });

  // WI-10003172: from a box that SNI-blackholes the branded Cupboard (EI-16742) the cut
  // died at publish.multipart.initiate because the sourced PAPERCUSP_CUPBOARD_URL override
  // was never forwarded to the publisher.
  describe('Cupboard base when --base is absent', () => {
    const REQUIRED = ['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x'];

    it('forwards the PAPERCUSP_CUPBOARD_URL override, normalized like resolveCupboardBaseUrl', () => {
      expect(
        parseWorkspaceHostReleaseCutArgs(REQUIRED, { PAPERCUSP_CUPBOARD_URL: '  https://worker.example.dev//  ' }).publisherArgs,
      ).toEqual(['--base', 'https://worker.example.dev']);
    });

    it('lets an explicit --base win over the override', () => {
      expect(
        parseWorkspaceHostReleaseCutArgs([...REQUIRED, '--base', 'https://explicit'], { PAPERCUSP_CUPBOARD_URL: 'https://worker.example.dev' })
          .publisherArgs,
      ).toEqual(['--base', 'https://explicit']);
    });

    it('passes no --base when the override is unset or blank, so the publisher keeps its branded default', () => {
      expect(parseWorkspaceHostReleaseCutArgs(REQUIRED, {}).publisherArgs).toEqual([]);
      expect(parseWorkspaceHostReleaseCutArgs(REQUIRED, { PAPERCUSP_CUPBOARD_URL: '   ' }).publisherArgs).toEqual([]);
      expect(cupboardBaseOverride({ PAPERCUSP_CUPBOARD_URL: '/' })).toBeUndefined();
    });
  });
});
