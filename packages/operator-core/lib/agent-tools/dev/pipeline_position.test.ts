import { describe, it, expect, vi } from 'vitest';
import tool, { PIPELINE_POSITION_RESPONSE_BUDGET_CHARS } from './pipeline_position';
import { gitPipelinePosition, type PipelinePosition } from '../../git-pipeline-position';
import { resolveSeeAlso } from '@papercusp/agent-mcp';
/**
 * P-010: the handler reads the LIVE cell registry, which the tool barrel populates via
 * this wiring module (agent-tools/index.ts). A test importing only the tool would see an
 * EMPTY registry — and an empty registry stamps nothing, silently, which would make the
 * P-010 assertions below pass-by-vacuity in the one direction that matters.
 */
import '../cell-registrations-wiring';

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

describe('dev:pipeline_position transaction boundary', () => {
  it('does not hold an ambient workspace transaction across subprocess probes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('dev:pipeline_position bounded response wiring (EI-20245527109472763)', () => {
  type Out = { data: Record<string, unknown> };

  const PATH = 'packages/operator-core/lib/agent-tools/dev/pipeline_position.ts';
  const marker = 'shape-pipeline-position-regression-marker';
  const singleRelease = {
    host: 'operator-release',
    releasePipelineApplies: true,
    restartTarget: 'staging',
    activation: 'deploy',
  };
  const singleStaging = {
    host: 'bg-host',
    releasePipelineApplies: false,
    restartTarget: 'bg-host',
    activation: 'restart bg-host',
  };
  const oversized = {
    input: { path: PATH, sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    deployedSha: 'sha0000001',
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      ownership: { claimState: 'unheld', thread: 'x'.repeat(12_000) },
    },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    summary: 'stub summary',
    notes: [],
  } as unknown as PipelinePosition;

  const expectBounded = (out: Out) => {
    const projection = out.data.projection as Record<string, unknown>;
    expect(projection).toMatchObject({ kind: 'bounded', truncated: true });
    expect(projection.fullRead).toEqual({
      tool: 'dev:pipeline_position',
      args: { path: PATH, marker },
    });
    expect(projection.omittedFields).toContain('gate.ownership.thread');
    expect(JSON.stringify(out.data).length).toBeLessThanOrEqual(PIPELINE_POSITION_RESPONSE_BUDGET_CHARS);
  };

  it('bounds the multi-consumer exit without dropping activations', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      runtime: singleStaging,
      runtimes: [singleStaging, singleRelease],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.activations).toHaveLength(2);
  });

  it('bounds the non-release exit without dropping activation guidance', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      runtime: singleStaging,
      runtimes: [singleStaging],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.activation).toMatchObject({ host: 'bg-host', releasePipelineApplies: false });
  });

  it('bounds the default exit without dropping the deploy awaitable', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      blockedOn: 'deployed',
      nextAction: null,
      runtime: singleRelease,
      runtimes: [singleRelease],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.awaitable).toMatchObject({ sugar: 'deploy:await' });
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
    expect(activations[0].args).toMatchObject({
      target: 'bg-host',
      confirm: true,
      authorize: true,
      reason: 'load the edit',
    });
    expect(activations[1].args).toMatchObject({
      target: 'staging',
      confirm: true,
      authorize: true,
      reason: 'load the edit',
    });
    // Never the single-consumer shape — that's exactly the misroute this fixes.
    expect(out.data.activation).toBeUndefined();
    // At least one consumer needs the deploy pipeline, so the note must not
    // blanket-tell the caller to skip deploy:await.
    expect(out.data.note).not.toMatch(/^Do NOT deploy:await/);
    expect(out.data.note).toMatch(/operator-release/);
  });
});

describe('dev:pipeline_position single runtime activation (EI-20242154394397741)', () => {
  it('includes the audited enablement gate in the concrete restart args', async () => {
    const fakeResult = {
      input: { path: 'packages/operator-core/lib/dbos/routines-tick.ts', sha: null },
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
      summary: 'stub summary',
      notes: [],
    } as unknown as PipelinePosition;
    vi.mocked(gitPipelinePosition).mockResolvedValue(fakeResult);

    const out = (await tool.handler(
      { path: 'packages/operator-core/lib/dbos/routines-tick.ts' } as never,
      {} as never,
    )) as { data: Record<string, unknown> };

    expect(out.data.activation).toMatchObject({
      tool: 'dev:restart',
      args: { target: 'bg-host', confirm: true, authorize: true, reason: 'load the edit' },
    });
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

  /**
   * The three pre-existing pointers are BARE STRINGS, so normalizeEntry puts the whole
   * sentence (prose and all) in `tool` — match on prefix, not equality. Adding the state
   * plane must not drop them.
   */
  it('keeps the pre-existing activation/deploy pointers', () => {
    const tools = ptrs({ blockedOn: 'deployed' }).map((x) => x.tool);
    for (const name of ['dev:restart', 'dev:build_status', 'release:deploy']) {
      expect(tools.some((t) => t.startsWith(name))).toBe(true);
    }
  });
});

/**
 * state-plane-adoption-2026-08-02 P-010 — the door EMITS the plane.
 *
 * P-002 above points at the plane and names one cell; that is promotion, and promotion
 * asymptotes (ACT/QUOTE 1.7%, D-030). This block asserts the door hands back every
 * volatile value already stamped with the cell that re-answers it.
 *
 * The stamping logic itself is unit-tested hermetically in state-plane-stamp.test.ts.
 * What can ONLY be caught here is the wiring: which exits carry the block, and whether
 * the caller's own subject reaches the handle.
 */
describe('dev:pipeline_position EMITS the state plane (P-010)', () => {
  type Out = { data: Record<string, unknown> };
  type Plane = { note: string; cells: Array<{ path: string; cell: string; reread?: { args: { cell: string; as?: string } }; unreadable?: { needs: string } }> };

  const PATH = 'apps/operator/app/x.ts';
  const full = {
    input: { path: PATH, sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    deployedSha: 'sha0000001',
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      ownership: { claimState: 'unheld' },
    },
    changeInCandidate: { judgingSha: 'cand0001' },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    summary: 'stub summary',
    notes: [],
  };

  const single = { host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' };
  const bgHost = { host: 'bg-host', releasePipelineApplies: false, restartTarget: 'bg-host', activation: 'restart bg-host' };

  const planeOf = (out: Out) => out.data.plane as Plane | undefined;

  /**
   * THE WIRING REGRESSION. The handler has THREE exits — multi-consumer, non-release
   * runtime, and the default — and stamping only the default would drop the plane for
   * exactly the paths with unusual activation routes, whose readers are the most likely
   * to be reasoning about what is and is not live.
   */
  const exits = [
    ['default (release-carried, single consumer)', { ...full, runtime: single, runtimes: [single] }],
    ['non-release runtime (bg-host — activation, not deploy)', { ...full, runtime: bgHost, runtimes: [bgHost] }],
    ['multi-consumer (activations, plural)', { ...full, runtime: bgHost, runtimes: [bgHost, single] }],
  ] as const;

  for (const [label, result] of exits) {
    it(`stamps the plane on the "${label}" exit`, async () => {
      vi.mocked(gitPipelinePosition).mockResolvedValue(result as unknown as PipelinePosition);
      const out = (await tool.handler({ path: PATH } as never, {} as never)) as Out;
      const plane = planeOf(out);
      expect(plane, 'this exit must carry the plane block').toBeDefined();
      expect(plane!.cells.length).toBeGreaterThan(0);
      expect(plane!.note).toMatch(/re-read|transcribe/i);
    });
  }

  it('names the cell for each volatile value, addressed to the CALLER\'S path', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({ ...full, runtime: single, runtimes: [single] } as unknown as PipelinePosition);
    const plane = planeOf((await tool.handler({ path: PATH } as never, {} as never)) as Out)!;
    const byCell = new Map(plane.cells.map((c) => [c.cell, c]));

    // The global cells: a complete handle, no subject needed.
    expect(byCell.get('deploy.3070.sha')?.reread?.args).toEqual({ cell: 'deploy.3070.sha' });
    expect(byCell.get('gate.greenCheckpoint.verdict')?.reread?.args).toEqual({ cell: 'gate.greenCheckpoint.verdict' });

    // The caller-relative ones MUST carry the caller's own path, or they re-read a
    // different subject than the value sitting in this very payload.
    expect(byCell.get('gate.greenCheckpoint.candidate')?.reread?.args).toEqual({
      cell: 'gate.greenCheckpoint.candidate',
      as: PATH,
    });
    expect(byCell.get('git.pipelinePosition')?.reread?.args).toEqual({ cell: 'git.pipelinePosition', as: PATH });

    // Each stamp points at where the value actually sits in THIS payload.
    expect(byCell.get('deploy.3070.sha')?.path).toBe('deployedSha');
    expect(byCell.get('gate.greenCheckpoint.candidate')?.path).toBe('changeInCandidate.judgingSha');
  });

  /**
   * A no-arg call is legal (P-007/D-067: the three global cells resolve through it). The
   * per-path legs are then unmeasured, so their stamps must not hand back an unqualified
   * handle that would answer about a different subject.
   */
  it('on a no-arg call, stamps the globals and refuses to fake a caller-relative handle', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...full,
      input: { path: null, sha: null },
      runtime: undefined,
      runtimes: undefined,
    } as unknown as PipelinePosition);

    const plane = planeOf((await tool.handler({} as never, {} as never)) as Out)!;
    const byCell = new Map(plane.cells.map((c) => [c.cell, c]));

    expect(byCell.get('deploy.3070.sha')?.reread?.args).toEqual({ cell: 'deploy.3070.sha' });

    const relative = byCell.get('gate.greenCheckpoint.candidate');
    expect(relative?.reread, 'must NOT emit an unqualified handle for a per-path cell').toBeUndefined();
    expect(relative?.unreadable?.needs).toBe('path');
  });

  /** A null reading is the one a caller must least transcribe — the stamp must survive it. */
  it('still stamps a value that is present-and-NULL', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...full,
      deployedSha: null,
      runtime: single,
      runtimes: [single],
    } as unknown as PipelinePosition);
    const plane = planeOf((await tool.handler({ path: PATH } as never, {} as never)) as Out)!;
    expect(plane.cells.some((c) => c.cell === 'deploy.3070.sha')).toBe(true);
  });

  /** The enrichment must never break the door it decorates. */
  it('degrades to no block rather than throwing when the payload carries nothing stampable', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      input: { path: null, sha: null },
      summary: 'nothing measured',
      notes: [],
    } as unknown as PipelinePosition);
    const out = (await tool.handler({} as never, {} as never)) as Out;
    expect(out.data.plane).toBeUndefined();
    expect(out.data.summary).toBe('nothing measured');
  });
});
