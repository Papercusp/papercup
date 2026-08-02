import { describe, it, expect, vi } from 'vitest';
import tool from './pipeline_position';
import { gitPipelinePosition, type PipelinePosition } from '../../git-pipeline-position';
import { resolveSeeAlso } from '@papercusp/agent-mcp';

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

/**
 * P-005: the payload must not carry TWO contradictory instructions.
 *
 * `awaitable` says "sleep on the deploy". That is true advice only when the deploy is
 * genuinely what the change waits for. When an EARLIER stage owns the next move — the work
 * is uncommitted, the push leg is faulted, the gate is red or judging a candidate without
 * this change — sleeping on `release:deployed` waits for an event that will land carrying
 * someone else's code, while the thing that would actually help goes undone. Emitting both
 * is worse than emitting either.
 */
describe('dev:pipeline_position awaitable defers to nextAction (P-005)', () => {
  type Out = { data: Record<string, unknown> };

  const base = {
    input: { path: 'apps/operator/app/x.ts', sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
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
    runtime: { host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' },
    runtimes: [{ host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' }],
    summary: 'stub summary',
    notes: [],
  };

  it('SUPPRESSES the deploy-await when an earlier stage owns the next move', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...base,
      positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
      blockedOn: 'committed',
      nextAction: 'git-sync:run (commit the working tree — the gate cannot see it)',
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
    expect(out.data.awaitable).toBeUndefined();
    expect(out.data.nextAction).toMatch(/git-sync:run/);
  });

  it('STILL offers the deploy-await when waiting really is the answer', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...base,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      blockedOn: 'deployed',
      nextAction: null,
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
    expect(out.data.awaitable).toMatchObject({ sugar: 'deploy:await' });
  });

  /**
   * WI-6595 — the case `nextAction` alone could never catch, which cost a live session
   * ~26 minutes of silence on 2026-07-28.
   *
   * A RED gate with a run already in flight has no lever, so `nextAction` is legitimately
   * null — this tool's own documented "blocked, and WAITING IS CORRECT" verdict. The old
   * `deployed || nextAction` guard therefore did NOT suppress the hint, and the agent was
   * told to sleep on `release:deployed`. The gate then went red, so no deploy was ever
   * attempted and neither `release:deployed` nor `release:deploy-failed` could fire. Worse,
   * sleeping on an await suppresses the monitor loop's fires, so the advice silenced the
   * agent's own heartbeat too.
   *
   * The verdict must key on WHERE THE CHANGE SITS, not on whether a lever happens to exist.
   */
  for (const blockedOn of ['committed', 'pushed', 'gate', 'main'] as const) {
    it(`SUPPRESSES the deploy-await when blocked at "${blockedOn}" even with NO nextAction`, async () => {
      vi.mocked(gitPipelinePosition).mockResolvedValue({
        ...base,
        positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
        gate: { stalled: false, consecutiveReds: 1, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
        blockedOn,
        // No lever: a red gate with a run already in flight is a legitimate "just wait".
        nextAction: null,
      } as unknown as PipelinePosition);

      const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
      expect(out.data.awaitable).toBeUndefined();
    });
  }
});

/**
 * state-plane-adoption-2026-08-02 P-002 — this tool is the door agents already use
 * (626 calls/7d), so it is where the state plane gets discovered. The pointer is a
 * result-time `seeAlso` rather than a prompt-time `chaining` line: this tool projects
 * at 1411 against the 1500 prompt-weight budget (dev:restart 1491, release:deploy 1472),
 * so the prompt-time route is effectively closed across the family — and a re-read is
 * advice that only makes sense at the moment the value is in the caller's hand.
 */
describe('dev:pipeline_position routes to the state plane (P-002)', () => {
  const ptrs = (data: unknown) =>
    resolveSeeAlso(
      tool.guidance?.seeAlso,
      { content: [{ type: 'text' as const, text: JSON.stringify(data) }] } as never,
      {},
      {},
    );

  it('always points at state:read for a re-read at the moment of acting', () => {
    const read = ptrs({ blockedOn: null }).find((x) => x.tool === 'state:read');
    expect(read).toBeDefined();
    expect(read?.reason).toMatch(/re-read|transcribe/i);
  });

  /** The pointer must name the ONE cell that re-answers the question the caller has. */
  const cases = [
    ['gate', 'gate.greenCheckpoint.verdict'],
    ['main', 'git.mainBehindStaging'],
    ['deployed', 'deploy.3070.sha'],
    ['serving', 'deploy.3070.sha'],
    ['committed', 'git.pipelinePosition'],
    [null, 'git.pipelinePosition'],
  ] as const;
  for (const [blockedOn, cell] of cases) {
    it(`names ${cell} when blocked at "${blockedOn}"`, () => {
      expect(ptrs({ blockedOn }).find((x) => x.tool === 'state:read')?.selector).toContain(cell);
    });
  }

  /**
   * The gate is the one leg with no lever and no existing await advice (the handler
   * deliberately suppresses `awaitable` there — WI-6595). Everywhere else, offering
   * state:subscribe would be a SECOND door for a wait deploy:await already owns.
   */
  it('offers state:subscribe ONLY on the gate leg, never as a second door for the deploy', () => {
    expect(ptrs({ blockedOn: 'gate' }).some((x) => x.tool === 'state:subscribe')).toBe(true);
    for (const blockedOn of ['deployed', 'serving', 'committed', 'pushed', 'main', null]) {
      expect(ptrs({ blockedOn }).some((x) => x.tool === 'state:subscribe')).toBe(false);
    }
  });

  /**
   * THE REGRESSION THAT WOULD MAKE THIS A SILENT NO-OP. seeAlso runs on the SERIALIZED
   * result, and on the MCP transport the {data} envelope may be TOON — readJsonResult
   * returns undefined and a JSON-only gate never fires, on the exact transport agents
   * actually use. The regex fallback must keep the gating alive.
   */
  it('still gates correctly when the envelope is TOON, not JSON', () => {
    const toon = { content: [{ type: 'text' as const, text: 'blockedOn: gate\ndeployed: false' }] };
    const p = resolveSeeAlso(tool.guidance?.seeAlso, toon as never, {}, {});
    expect(p.find((x) => x.tool === 'state:read')?.selector).toContain('gate.greenCheckpoint.verdict');
    expect(p.some((x) => x.tool === 'state:subscribe')).toBe(true);
  });

  it('keeps the pre-existing activation/deploy pointers', () => {
    const tools = ptrs({ blockedOn: 'deployed' }).map((x) => x.tool);
    expect(tools).toEqual(expect.arrayContaining(['dev:restart', 'dev:build_status', 'release:deploy']));
  });
});
