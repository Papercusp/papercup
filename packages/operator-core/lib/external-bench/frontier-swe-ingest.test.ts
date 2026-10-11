import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  FrontierSweIngestError,
  frontierSweArtifactsOf,
  frontierSweExternalNeeds,
  parseFrontierSweReadmeCategories,
  imageDigestOf,
  ingestFrontierSweCorpus,
  labelV1History,
  networkAllowsInternet,
  parseFrontierSweJsonl,
  readCheckoutHead,
  type FrontierSweIngestFs,
} from './frontier-swe-ingest';
import type { FrontierSweTaskRow } from './task-sets';

const COMMIT = 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df';
const AGENT_DIGEST = 'sha256:' + 'a'.repeat(64);
const VERIFIER_DIGEST = 'sha256:' + 'b'.repeat(64);
const REGISTRY = 'us-west1-docker.pkg.dev/proximal-core-0/proximal-evals-public';

/** A v2 (Harbor schema 1.3) task.toml in the shape observed upstream at the pinned commit (plan D-002). */
function v2TaskToml(
  name: string,
  opts: { agentImage?: string; verifierImage?: string; verifierNetworkMode?: string } = {},
): string {
  return [
    'schema_version = "1.3"',
    '[task]',
    `name = "proximal-evals/${name}"`,
    'keywords = ["astrometry", "wcs"]',
    '[metadata]',
    'difficulty = "frontier"',
    'category = "scientific-software-engineering"',
    '[agent]',
    'timeout_sec = 72000.0',
    '[verifier]',
    'timeout_sec = 10800.0',
    'environment_mode = "separate"',
    '[verifier.environment]',
    `docker_image = "${opts.verifierImage ?? `${REGISTRY}/${name}@${VERIFIER_DIGEST}`}"`,
    ...(opts.verifierNetworkMode ? [`network_mode = "${opts.verifierNetworkMode}"`] : []),
    'cpus = 16',
    '[environment]',
    `docker_image = "${opts.agentImage ?? `${REGISTRY}/${name}@${AGENT_DIGEST}`}"`,
    'network_mode = "allowlist"',
    'cpus = 16',
    'memory_mb = 131072',
    'storage_mb = 524288',
    'gpus = 0',
  ].join('\n');
}

/** In-memory checkout: path → file contents. Directories are implied by file paths. */
function memFs(files: Record<string, string>): FrontierSweIngestFs {
  const children = (dir: string, wantDirs: boolean) => {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const out = new Set<string>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length).split('/');
      if (wantDirs && rest.length > 1) out.add(rest[0]!);
      if (!wantDirs && rest.length === 1) out.add(rest[0]!);
    }
    return [...out];
  };
  return {
    listDirs: async (dir) => children(dir, true),
    listFiles: async (dir) => children(dir, false),
    readText: async (path) => files[path] ?? null,
    exists: async (path) => path in files || Object.keys(files).some((p) => p.startsWith(path + '/')),
  };
}

const ROOT = '/vendor/frontier-swe-v2';
const t = (task: string, file: string) => join(ROOT, 'tasks', task, file);

describe('ingestFrontierSweCorpus (P-002 / FSWE-P002-MANIFEST)', () => {
  it('records the pinned commit and both image digests on every task entry and row', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: '# v2',
      [t('astronomy-toolkit', 'task.toml')]: v2TaskToml('astronomy-toolkit'),
      [t('astronomy-toolkit', 'instruction.md')]: 'Build an astrometry toolkit.',
      [t('astronomy-toolkit', 'solution/solve.sh')]: '#!/bin/bash',
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig', { verifierNetworkMode: 'no-network' }),
      [t('git-to-zig', 'instruction.md')]: 'Port git to Zig.',
      // The job.yaml runtime profile shape observed upstream (reconnaissance-blind-chess-recovery, D-002 §5).
      [t('git-to-zig', 'job.yaml')]: [
        'environment:',
        '  type: modal',
        '  kwargs:',
        '    modal_vm_runtime: true',
        '    registry_secret: px-evals-gcr-secret',
      ].join('\n'),
    });
    const { rows, manifest } = await ingestFrontierSweCorpus(
      { root: ROOT, commitSha: COMMIT, now: new Date('2026-10-10T00:00:00Z') },
      fs,
    );

    expect(manifest.commitSha).toBe(COMMIT);
    expect(manifest.upstreamRepo).toBe('Proximal-Labs/frontier-swe-v2');
    expect(manifest.taskCount).toBe(2);
    expect(manifest.tasks.map((x) => x.instanceId)).toEqual(['astronomy-toolkit', 'git-to-zig']);
    for (const task of manifest.tasks) {
      expect(task.commitSha).toBe(COMMIT);
      expect(task.agentImageDigest).toBe(AGENT_DIGEST);
      expect(task.verifierImageDigest).toBe(VERIFIER_DIGEST);
    }
    expect(manifest.licenseStatus).toBe('none');
    for (const row of rows) {
      expect(row.corpusVersion).toBe('v2');
      expect(row.upstreamCommit).toBe(COMMIT);
      expect(row.retiredInV2).toBe(false);
    }

    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect(zig.verifierNetworkMode).toBe('no-network');
    expect(zig.externalNeeds).toEqual(['runtime:modal', 'modal-vm-runtime', 'registry-secret:px-evals-gcr-secret']);
    expect(rows.find((r) => r.instanceId === 'astronomy-toolkit')!.externalNeeds).toEqual([]);

    const astro = rows.find((r) => r.instanceId === 'astronomy-toolkit')!;
    expect(astro.prompt).toBe('Build an astrometry toolkit.');
    expect(astro.dockerImage).toBe(`${REGISTRY}/astronomy-toolkit@${AGENT_DIGEST}`);
    expect(astro.verifierDockerImage).toBe(`${REGISTRY}/astronomy-toolkit@${VERIFIER_DIGEST}`);
    expect(astro.agentTimeoutSec).toBe(72000);
    expect(astro.verifierTimeoutSec).toBe(10800);
    expect(astro.networkMode).toBe('allowlist');
    expect(astro.allowInternet).toBe(true);
    expect(astro.tags).toEqual(['astrometry', 'wcs']);
    expect(astro.solutionCmd).toBe('bash /solution/solve.sh');
    expect(rows.find((r) => r.instanceId === 'git-to-zig')!.solutionCmd).toBeNull();
  });

  it('refuses the corpus when a task image can float, naming every offending task', async () => {
    const fs = memFs({
      [t('floating-agent', 'task.toml')]: v2TaskToml('floating-agent', { agentImage: `${REGISTRY}/floating-agent:v2` }),
      [t('floating-verifier', 'task.toml')]: v2TaskToml('floating-verifier', {
        verifierImage: `${REGISTRY}/floating-verifier:latest`,
      }),
      [t('pinned', 'task.toml')]: v2TaskToml('pinned'),
    });
    const err = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrontierSweIngestError);
    const problems = (err as FrontierSweIngestError).problems;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^floating-agent: agent image is not digest-pinned/);
    expect(problems[1]).toMatch(/^floating-verifier: verifier image is not digest-pinned/);
  });

  it('refuses a commit that is not a full 40-hex SHA', async () => {
    const fs = memFs({ [t('pinned', 'task.toml')]: v2TaskToml('pinned') });
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: 'main' }, fs)).rejects.toThrow(
      FrontierSweIngestError,
    );
  });

  it('refuses an empty checkout rather than writing an empty corpus', async () => {
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, memFs({}))).rejects.toThrow(
      /problem/,
    );
  });

  it('refuses a task whose job.yaml runtime profile does not parse', async () => {
    const fs = memFs({
      [t('pinned', 'task.toml')]: v2TaskToml('pinned'),
      [t('pinned', 'job.yaml')]: 'environment:\n  kwargs: [unclosed',
    });
    const err = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs).catch((e: unknown) => e);
    expect((err as FrontierSweIngestError).problems).toEqual([expect.stringMatching(/^pinned: job\.yaml does not parse/)]);
  });

  it('reports a LICENSE file at the checkout root', async () => {
    const fs = memFs({ [join(ROOT, 'LICENSE')]: 'MIT', [t('pinned', 'task.toml')]: v2TaskToml('pinned') });
    const { manifest } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    expect(manifest.licenseStatus).toBe('present');
    expect(manifest.licenseFile).toBe('LICENSE');
  });
});

describe('readCheckoutHead', () => {
  it('reads a detached HEAD, a loose ref, and a packed ref without a git subprocess', async () => {
    expect(await readCheckoutHead(ROOT, memFs({ [join(ROOT, '.git/HEAD')]: COMMIT + '\n' }))).toBe(COMMIT);
    const loose = memFs({
      [join(ROOT, '.git/HEAD')]: 'ref: refs/heads/main\n',
      [join(ROOT, '.git/refs/heads/main')]: COMMIT + '\n',
    });
    expect(await readCheckoutHead(ROOT, loose)).toBe(COMMIT);
    const packed = memFs({
      [join(ROOT, '.git/HEAD')]: 'ref: refs/heads/main\n',
      [join(ROOT, '.git/packed-refs')]: `# pack-refs with: peeled\n${COMMIT} refs/heads/main\n`,
    });
    expect(await readCheckoutHead(ROOT, packed)).toBe(COMMIT);
    expect(await readCheckoutHead(ROOT, memFs({}))).toBeNull();
  });
});

describe('networkAllowsInternet', () => {
  it("treats v2's 'no-network' and v1's 'none' as offline and 'allowlist' as online", () => {
    expect(networkAllowsInternet('no-network')).toBe(false);
    expect(networkAllowsInternet('none')).toBe(false);
    expect(networkAllowsInternet(undefined)).toBe(false);
    expect(networkAllowsInternet('allowlist')).toBe(true);
  });
});

describe('frontierSweExternalNeeds', () => {
  it('reads the Modal VM runtime flag alone (the cranelift-codegen-opt shape) and returns [] without a profile', () => {
    expect(frontierSweExternalNeeds('environment:\n  kwargs:\n    modal_vm_runtime: true\n')).toEqual(['modal-vm-runtime']);
    expect(frontierSweExternalNeeds(null)).toEqual([]);
  });
});

describe('labelV1History', () => {
  const row = (instanceId: string): FrontierSweTaskRow => ({
    instanceId,
    prompt: '',
    dockerImage: `ghcr.io/proximal-labs/frontier-swe/${instanceId}:v1`,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
  });

  it('labels every v1 row v1 and flags exact ids missing from v2 as retired, renames included', () => {
    const v1 = [row('git-to-zig'), row('dart-style-haskell')];
    const v2 = [row('git-to-zig'), row('dart-style-in-haskell')];
    const history = labelV1History(v1, v2);
    expect(history.map((r) => [r.instanceId, r.corpusVersion, r.retiredInV2])).toEqual([
      ['git-to-zig', 'v1', false],
      ['dart-style-haskell', 'v1', true],
    ]);
  });

  it('round-trips through the JSONL parser', () => {
    const text = [row('a'), row('b')].map((r) => JSON.stringify(r)).join('\n') + '\n\n';
    expect(parseFrontierSweJsonl(text).map((r) => r.instanceId)).toEqual(['a', 'b']);
  });
});

describe('imageDigestOf', () => {
  it('extracts a sha256 digest and rejects tag-only references', () => {
    expect(imageDigestOf(`${REGISTRY}/x@${AGENT_DIGEST}`)).toBe(AGENT_DIGEST);
    expect(imageDigestOf('ghcr.io/proximal-labs/frontier-swe/x:v1')).toBeNull();
    expect(imageDigestOf(undefined)).toBeNull();
  });
});

describe('v2 grading contract fields (plan D-003, P-003)', () => {
  /** A task.toml carrying the artifacts + [verifier.env] tables observed upstream (astronomy-toolkit). */
  const contractToml = (name: string) =>
    [
      'schema_version = "1.3"',
      'artifacts = [',
      '  { source = "/app/", exclude = ["**/__pycache__/**", "**/.venv/**"] },',
      ']',
      v2TaskToml(name).replace('schema_version = "1.3"\n', '').replace(
        '[verifier.environment]',
        '[verifier.env]\nASTROMETRY_NUM_THREADS = "16"\nSEED = 20260811\n[verifier.environment]',
      ),
    ].join('\n');
  const readme = (rows: string[]) =>
    ['# FrontierSWE v2', '', '| # | Task | Category |', '|---|---|---|', ...rows].join('\n');

  it('records separate-verifier mode, verifier env, artifacts and README suite categories', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: readme([
        '| 01 | [Astronomy Toolkit](tasks/astronomy-toolkit/) | Visual Reasoning, Implementation |',
        '| 02 | [Git to Zig](tasks/git-to-zig/) | Implementation |',
      ]),
      [t('astronomy-toolkit', 'task.toml')]: contractToml('astronomy-toolkit'),
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
    });
    const { rows } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    const astro = rows.find((r) => r.instanceId === 'astronomy-toolkit')!;
    expect(astro.verifierEnvironmentMode).toBe('separate');
    expect(astro.verifierEnv).toEqual({ ASTROMETRY_NUM_THREADS: '16', SEED: '20260811' });
    expect(astro.artifacts).toEqual([{ source: '/app/', exclude: ['**/__pycache__/**', '**/.venv/**'] }]);
    expect(astro.suiteCategories).toEqual(['Visual Reasoning', 'Implementation']);
    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect(zig.artifacts).toEqual([]);
    expect(zig.suiteCategories).toEqual(['Implementation']);
  });

  it("records the separate verifier's OWN gpus/gpu_types from [verifier.environment], independent of the agent's", async () => {
    // The multi-gpu-efficient-finetuning shape at the pinned commit: agent 2×T4, verifier 4×H100.
    const multi = v2TaskToml('multi-gpu-efficient-finetuning')
      .replace('[verifier.environment]', '[verifier.environment]\ngpus = 4\ngpu_types = ["H100"]')
      .replace('gpus = 0', 'gpus = 2\ngpu_types = ["T4"]');
    const fs = memFs({
      [t('multi-gpu-efficient-finetuning', 'task.toml')]: multi,
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
    });
    const { rows } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    const m = rows.find((r) => r.instanceId === 'multi-gpu-efficient-finetuning')!;
    expect({ gpus: m.gpus, gpuTypes: m.gpuTypes }).toEqual({ gpus: 2, gpuTypes: ['T4'] });
    expect({ verifierGpus: m.verifierGpus, verifierGpuTypes: m.verifierGpuTypes }).toEqual({ verifierGpus: 4, verifierGpuTypes: ['H100'] });
    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect({ verifierGpus: zig.verifierGpus, verifierGpuTypes: zig.verifierGpuTypes }).toEqual({ verifierGpus: 0, verifierGpuTypes: [] });
  });

  it('refuses a task missing from a README that has a task table', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: readme(['| 01 | [Git to Zig](tasks/git-to-zig/) | Implementation |']),
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
      [t('orphan', 'task.toml')]: v2TaskToml('orphan'),
    });
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs)).rejects.toMatchObject({
      problems: ['orphan: missing from the README task table (no suite category)'],
    });
  });

  it('parses README categories and refuses an unknown category', () => {
    expect(
      parseFrontierSweReadmeCategories(readme(['| 07 | [X](tasks/x/) | Scientific Computing, AI Research |'])),
    ).toEqual(new Map([['x', ['Scientific Computing', 'AI Research']]]));
    expect(parseFrontierSweReadmeCategories('# no table')).toEqual(new Map());
    expect(() => parseFrontierSweReadmeCategories(readme(['| 01 | [X](tasks/x/) | Robotics |']))).toThrow(
      /unknown suite category: Robotics/,
    );
  });

  it('normalizes string and table artifacts and rejects a sourceless entry', () => {
    expect(frontierSweArtifactsOf(['/out/', { source: '/app/', exclude: ['*.tmp'] }])).toEqual([
      { source: '/out/', exclude: [] },
      { source: '/app/', exclude: ['*.tmp'] },
    ]);
    expect(frontierSweArtifactsOf(undefined)).toEqual([]);
    expect(() => frontierSweArtifactsOf([{ exclude: [] }])).toThrow(/artifacts\[0\] has no string source/);
  });
});
