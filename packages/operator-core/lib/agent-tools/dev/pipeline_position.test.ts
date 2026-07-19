import { describe, it, expect, vi } from 'vitest';
import tool from './pipeline_position';
import { gitPipelinePosition, type PipelinePosition } from '../../git-pipeline-position';

vi.mock('../../git-pipeline-position', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git-pipeline-position')>();
  return { ...actual, gitPipelinePosition: vi.fn() };
});

/**
 * deploy-pipeline-legibility-2026-06-18 P-005: the shared DEPLOY_PIPELINE_NOTE (in every spawned
 * role's prompt) tells EVERY execution/judgment role to reach for `dev:pipeline_position` instead
 * of polling :3070. So the tool's allowlist MUST cover them all — this guards against a silent
 * re-narrowing that would re-break the note's promise. The tool is read-only (intel:read), so a
 * wide allowlist is safe.
 */
describe('dev:pipeline_position role allowlist', () => {
  it('is available to every execution/judgment role the cross-role note points at', () => {
    const roles = new Set(tool.agentRoles ?? []);
    const expected = [
      'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
      'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
      'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
    ];
    for (const r of expected) {
      expect(roles.has(r), `pipeline_position must be allowed for role '${r}'`).toBe(true);
    }
  });
});

/**
 * WI-5440: a path can have MORE THAN ONE consumer on different activation
 * routes (git-pipeline-position.ts's `runtimes`, plural). Collapsing to a
 * single `activation` block routed a live activation decision the wrong
 * way during the 0.0.11-alpha release watch — this asserts the handler
 * surfaces `activations` (one per consumer) instead of picking one.
 */
describe('dev:pipeline_position multi-consumer paths (WI-5440)', () => {
  type Out = { data: Record<string, unknown> };

  it('returns `activations` (plural), not a single misleading `activation`, when `runtimes` has more than one entry', async () => {
    const fakeResult = {
      input: { path: 'packages/operator-core/lib/scout/success-metrics.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      targetSha: 'sha0000001',
      targetShortSha: 'sha000000',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      deployedSha: 'sha0000001',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'sha0000001',
        lastGreenShortSha: 'sha000000',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      runtime: { host: 'bg-host', releasePipelineApplies: false, restartTarget: 'bg-host', activation: 'bg-host activation text' },
      runtimes: [
        { host: 'bg-host', releasePipelineApplies: false, restartTarget: 'bg-host', activation: 'bg-host activation text' },
        { host: 'operator-release', releasePipelineApplies: true, restartTarget: 'staging', activation: 'release activation text' },
      ],
      summary: 'stub summary',
      notes: [],
    } as unknown as PipelinePosition;
    vi.mocked(gitPipelinePosition).mockResolvedValue(fakeResult);

    const out = (await tool.handler(
      { path: 'packages/operator-core/lib/scout/success-metrics.ts' } as never,
      {} as never,
    )) as Out;

    const activations = out.data.activations as Array<Record<string, unknown>>;
    expect(activations).toHaveLength(2);
    expect(activations[0]).toMatchObject({ host: 'bg-host', releasePipelineApplies: false });
    expect(activations[1]).toMatchObject({ host: 'operator-release', releasePipelineApplies: true });
    // Never the single-consumer shape — that's exactly the misroute this fixes.
    expect(out.data.activation).toBeUndefined();
    // At least one consumer needs the deploy pipeline, so the note must not
    // blanket-tell the caller to skip deploy:await.
    expect(out.data.note).not.toMatch(/^Do NOT deploy:await/);
    expect(out.data.note).toMatch(/operator-release/);
  });
});
