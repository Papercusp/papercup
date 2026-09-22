/**
 * turn-start-memory.test.ts — the turn-start injection endpoint's admission
 * behavior (context-injection-audit-2026-07-28 P-035 / F-E).
 *
 * The load-bearing case is the FIRST one: a SHORT prompt must reach the memory
 * pipeline. A `MIN_PROMPT_CHARS = 40` gate used to drop every prompt below 40
 * characters, and that gate is the audit's founding symptom — it silently
 * discarded the owner's 23-char question, a specific and entirely on-topic
 * prompt, because length was standing in as a proxy for relevance. F-B
 * (cosine-gated fusion) made the push path able to return zero on its own
 * merits, so the proxy was deleted with no replacement.
 *
 * These tests exist to stop it coming back: if anyone reintroduces a length
 * floor here — as a constant, an env var, or an inline `prompt.length <` — the
 * first two cases fail loudly rather than the regression being discovered
 * months later by an owner wondering why a short question got no memory.
 *
 * This endpoint previously had NO test file at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  buildMemoryContextBlockMock,
  preparePendingControlTransitionMock,
  markControlTransitionPreparedMock,
  failControlTransitionActivationMock,
  convergeActivationToLaunchRecordMock,
  acknowledgeControlTransitionMock,
  renderStackTransitionContextResultMock,
  detectHarnessSlugSyncMock,
  resolveAgentSignalsMock,
  recordInjectionCoverageMock,
  buildPersonalAmbientContextBlockMock,
  getMemoryBlockBoundedResultMock,
  buildTurnStartOrientationBlockMock,
  readSuLaunchSpecByOwnerMock,
} = vi.hoisted(() => ({
  buildMemoryContextBlockMock: vi.fn(),
  preparePendingControlTransitionMock: vi.fn(),
  markControlTransitionPreparedMock: vi.fn(),
  failControlTransitionActivationMock: vi.fn(),
  convergeActivationToLaunchRecordMock: vi.fn(),
  acknowledgeControlTransitionMock: vi.fn(),
  renderStackTransitionContextResultMock: vi.fn(),
  detectHarnessSlugSyncMock: vi.fn(),
  resolveAgentSignalsMock: vi.fn(),
  recordInjectionCoverageMock: vi.fn(),
  buildPersonalAmbientContextBlockMock: vi.fn(),
  getMemoryBlockBoundedResultMock: vi.fn(),
  buildTurnStartOrientationBlockMock: vi.fn(),
  readSuLaunchSpecByOwnerMock: vi.fn(),
}));

// Same relative specifiers the source's dynamic imports use (this test is
// colocated under routes/agent-mcp/).
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: buildMemoryContextBlockMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-1' }) }));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  preparePendingControlTransition: preparePendingControlTransitionMock,
  markControlTransitionPrepared: markControlTransitionPreparedMock,
  failControlTransitionActivation: failControlTransitionActivationMock,
  convergeActivationToLaunchRecord: convergeActivationToLaunchRecordMock,
  acknowledgeControlTransition: acknowledgeControlTransitionMock,
  renderControlTransitionContext: (t: unknown) => `CTRL:${String((t as { kind?: string }).kind)}`,
}));
vi.mock('../../../stack-binding-channel', () => ({
  renderStackTransitionContextResult: renderStackTransitionContextResultMock,
}));
// Spread the real module: `adv-sessions` is PROTECTED because it has 74 exports,
// so a bare factory enumerating only what this test needs today silently strands
// the file the next time an export is added (WI-7187/WI-7185).
vi.mock('../../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../../adv-sessions')>()),
  readSuLaunchSpecByOwner: readSuLaunchSpecByOwnerMock,
}));
vi.mock('../../../memory/detect-harness-slug', () => ({
  detectHarnessSlugSync: detectHarnessSlugSyncMock,
}));
vi.mock('../../../memory/agent-signals', () => ({
  resolveAgentSignalsForOwner: resolveAgentSignalsMock,
}));
vi.mock('../../../memory/injection-delivery-coverage', () => ({
  recordInjectionCoverage: recordInjectionCoverageMock,
}));
vi.mock('../../../personal-vault/ambient', () => ({
  buildPersonalAmbientContextBlock: buildPersonalAmbientContextBlockMock,
}));
vi.mock('../../../memory/injection-block-cache', () => ({
  getMemoryBlockBoundedResult: getMemoryBlockBoundedResultMock,
}));
vi.mock('../../../turn-start-orientation', () => ({
  buildTurnStartOrientationBlock: buildTurnStartOrientationBlockMock,
}));

import routes from './turn-start-memory';

const endpoint = routes[0] as unknown as {
  handler: (req: Request) => Promise<Response>;
};

const post = async (body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/turn-start-memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as { ok: boolean; text: string };
};

beforeEach(() => {
  buildMemoryContextBlockMock.mockReset().mockResolvedValue('MEM-BLOCK');
  preparePendingControlTransitionMock.mockReset().mockResolvedValue(null);
  markControlTransitionPreparedMock.mockReset().mockResolvedValue(true);
  failControlTransitionActivationMock.mockReset().mockResolvedValue(true);
  convergeActivationToLaunchRecordMock.mockReset().mockResolvedValue(false);
  acknowledgeControlTransitionMock.mockReset().mockResolvedValue(true);
  renderStackTransitionContextResultMock.mockReset().mockResolvedValue({ text: '', rendered: true });
  detectHarnessSlugSyncMock.mockReset().mockReturnValue({ slug: null, source: null });
  resolveAgentSignalsMock.mockReset().mockResolvedValue(undefined);
  recordInjectionCoverageMock.mockReset().mockResolvedValue(undefined);
  buildPersonalAmbientContextBlockMock.mockReset().mockResolvedValue(null);
  getMemoryBlockBoundedResultMock.mockReset().mockImplementation(
    async (_workspaceId: string, _scopeKey: string, build: () => Promise<string | null>) => ({
      status: 'ready',
      block: await build(),
    }),
  );
  buildTurnStartOrientationBlockMock.mockReset().mockResolvedValue('');
  readSuLaunchSpecByOwnerMock.mockReset().mockResolvedValue(null);
});

/**
 * The coverage write is fire-and-forget (`void`, never awaited) and reaches its
 * module through a dynamic import, so it lands a few microtasks AFTER the
 * response resolves. Settle the queue before asserting — otherwise these tests
 * would pass or fail on scheduling luck, which is worse than not having them.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('turn-start-memory admission (F-E: no length floor)', () => {
  it('returns orientation when memory misses its bounded deadline, without recording healthy quiet', async () => {
    getMemoryBlockBoundedResultMock.mockResolvedValue({ status: 'deadline', block: null });
    buildTurnStartOrientationBlockMock.mockResolvedValue('## Orientation\n- improvement triage: top EI-1');

    const out = await post({ owner: 'sess-1', prompt: 'continue', harness: 'papercusp' });
    await settle();

    expect(out.text).toContain('improvement triage: top EI-1');
    expect(out.text).not.toContain('MEM-BLOCK');
    expect(getMemoryBlockBoundedResultMock).toHaveBeenCalledWith(
      'ws-test',
      'turn-start:sess-1',
      expect.any(Function),
    );
    expect(recordInjectionCoverageMock).not.toHaveBeenCalled();
  });

  it('a 23-char prompt REACHES the memory pipeline — the audit\'s founding symptom', async () => {
    // Verbatim length of the owner prompt the old 40-char gate dropped.
    const prompt = 'why is recall empty??!';
    expect(prompt.length).toBeLessThan(40);

    const out = await post({ owner: 'sess-1', prompt, harness: 'papercusp' });

    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toContain('MEM-BLOCK');
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      // P-044: the structured form. `userText` is the COSINE leg's query and is
      // still the human's words alone — deliberately, since identifiers were
      // measured diluting that vector (D-041).
      queryContext: { userText: prompt },
      harnessSlugs: ['papercusp'],
      session: { sessionId: 'sess-1', port: 'turn-start' },
    });
  });

  it('even a 1-char prompt reaches it — relevance is the floor\'s job, not the length\'s', async () => {
    await post({ owner: 'sess-1', prompt: 'y' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('a signal-free prompt injects NOTHING when the pipeline finds nothing — the real gate', async () => {
    // The point of F-E: "continue" is filtered by RELEVANCE returning no hits,
    // not by a character count refusing to ask. Same prompt the old gate
    // dropped a priori; now it is asked and answered honestly.
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'continue' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('');
  });

  it('memoryEnabled:false still skips recall — the ONE admission gate that remains', async () => {
    await post({ owner: 'sess-1', prompt: 'a real question about the deploy pipeline', memoryEnabled: false });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
  });

  it('clamps a very long prompt to the query head rather than embedding a pasted document', async () => {
    await post({ owner: 'sess-1', prompt: 'x'.repeat(5_000) });
    const { queryContext } = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: { userText: string };
    };
    expect(queryContext.userText).toHaveLength(1_000);
  });

  it('CTRL is delivered even for a prompt carrying no recall signal at all', async () => {
    // A mode/loop/carry/route transition must take effect at the very next
    // boundary, so it is deliberately NOT subject to any prompt gating.
    preparePendingControlTransitionMock.mockResolvedValue({ kind: 'mode', generation: 1 });
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'ok' });
    expect(out.text).toBe('CTRL:mode');
  });

  it('retries a failed stack render, then acknowledges the generation exactly once after recovery', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const transition = { kind: 'mode', generation: 7 };
    let pending = true;
    preparePendingControlTransitionMock.mockImplementation(async () => (pending ? transition : null));
    renderStackTransitionContextResultMock
      .mockResolvedValueOnce({ text: '', rendered: false })
      .mockResolvedValueOnce({ text: 'STACK-RECOVERED', rendered: true });
    acknowledgeControlTransitionMock.mockImplementation(async () => {
      pending = false;
      return true;
    });

    const failed = await post({ owner: 'sess-1', prompt: 'first attempt' });
    expect(failed.ok).toBe(true);
    expect(failed.text).toBe('CTRL:mode');
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();

    const recovered = await post({ owner: 'sess-1', prompt: 'retry' });
    expect(recovered.text).toBe('CTRL:mode\n\nSTACK-RECOVERED');
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 7);

    const settled = await post({ owner: 'sess-1', prompt: 'after recovery' });
    expect(settled.text).toBe('');
    expect(preparePendingControlTransitionMock).toHaveBeenCalledTimes(3);
    expect(renderStackTransitionContextResultMock).toHaveBeenCalledTimes(2);
  });

  it('fail-soft: a throwing memory pipeline never surfaces an error into the turn', async () => {
    buildMemoryContextBlockMock.mockRejectedValue(new Error('backend down'));
    const out = await post({ owner: 'sess-1', prompt: 'a question about storage policy' });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
  });

  // EI-18893248175645463: an operator/superuser-scope session never sends
  // `harness` (PAPERCUSP_HARNESS_SLUG is only exported for harness-scoped
  // spawns) — measured live, this starved the harness+hive memory pools for
  // that session's ENTIRE lifetime, not just an occasional miss. `cwd`
  // fallback detection closes that gap.
  describe('cwd fallback (EI-18893248175645463)', () => {
    it('no harness in body, but cwd resolves one → harnessSlugs carries it', async () => {
      detectHarnessSlugSyncMock.mockReturnValue({ slug: 'papercusp', source: 'meta-papercup' });
      await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/home/dev/papercupai-workspace/papercup' });
      expect(detectHarnessSlugSyncMock).toHaveBeenCalledWith({ cwd: '/home/dev/papercupai-workspace/papercup' });
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: ['papercusp'] });
    });

    it('an explicit harness in body WINS over cwd detection — never overridden', async () => {
      await post({ owner: 'sess-1', prompt: 'a real question', harness: 'papercusp-public-site', cwd: '/some/other/dir' });
      expect(detectHarnessSlugSyncMock).not.toHaveBeenCalled();
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: ['papercusp-public-site'] });
    });

    it('no harness, no cwd → stays bare (unchanged behavior)', async () => {
      await post({ owner: 'sess-1', prompt: 'a real question' });
      expect(detectHarnessSlugSyncMock).not.toHaveBeenCalled();
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });

    it('no harness, cwd given but detection finds nothing → stays bare, never throws', async () => {
      detectHarnessSlugSyncMock.mockReturnValue({ slug: null, source: null });
      const out = await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/tmp/nowhere' });
      expect(out.ok).toBe(true);
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });

    it('detection throwing degrades to bare rather than failing the turn', async () => {
      detectHarnessSlugSyncMock.mockImplementation(() => {
        throw new Error('fs boom');
      });
      const out = await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/tmp/nowhere' });
      expect(out.ok).toBe(true);
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });
  });

  it('requires an owner', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/turn-start-memory', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'a question' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('agent signals reach the query (context-injection-audit-2026-07-28 P-044 / F-L)', () => {
  const signals = {
    workItem: { id: 'WI-6512' },
    trajectory: { paths: ['apps/operator-vite/src/components/HistoryDropdown.tsx'] },
  };

  it('carries resolved signals into queryContext — the wiring, not just the composition', async () => {
    // Without this the resolver is built, tested and NEVER CALLED in production:
    // `recall-query`'s unit tests would still pass and the feature would be dead
    // code. This asserts the endpoint actually asks for signals and passes them on.
    resolveAgentSignalsMock.mockResolvedValue(signals);
    await post({ owner: 'sess-1', prompt: 'why is session history slow', cwd: '/repo' });
    expect(resolveAgentSignalsMock).toHaveBeenCalledTimes(1);
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      queryContext: { userText: 'why is session history slow', agentSignals: signals },
    });
  });

  it('omits agentSignals entirely when none resolve — not an empty object', async () => {
    // `lexicalQueryText` returns undefined for absent signals, which is what
    // keeps the no-signals turn byte-identical to pre-P-044. An empty object
    // would be indistinguishable at the seam but is a different claim.
    resolveAgentSignalsMock.mockResolvedValue(undefined);
    await post({ owner: 'sess-1', prompt: 'why is session history slow' });
    const { queryContext } = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: Record<string, unknown>;
    };
    expect(queryContext).not.toHaveProperty('agentSignals');
  });

  it('a THROWING resolver degrades to no signals rather than failing the turn', async () => {
    resolveAgentSignalsMock.mockRejectedValue(new Error('pg down'));
    const out = await post({ owner: 'sess-1', prompt: 'why is session history slow' });
    expect(out.text).toContain('MEM-BLOCK');
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      queryContext: { userText: 'why is session history slow' },
    });
  });
});

describe('granted-only Personal Vault ambient leg', () => {
  it('renders granted personal context as a separate block after general memory', async () => {
    buildPersonalAmbientContextBlockMock.mockResolvedValue('VAULT-BLOCK');

    const out = await post({
      owner: 'meeting-prep-run-1',
      prompt: 'prepare me for the Acme review',
      workspace: 'ws-test',
    });

    expect(out.text).toBe('MEM-BLOCK\n\nVAULT-BLOCK');
    expect(buildPersonalAmbientContextBlockMock).toHaveBeenCalledWith({
      ownerId: 'meeting-prep-run-1',
      userId: 'u-1',
      workspaceId: 'ws-test',
      query: 'prepare me for the Acme review',
    });
  });

  it('injects nothing when authorization refuses the caller', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    buildPersonalAmbientContextBlockMock.mockResolvedValue(null);

    const out = await post({ owner: 'coding-agent-1', prompt: 'search the owner vault' });

    expect(out.text).toBe('');
    expect(buildPersonalAmbientContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('does not even invoke personal recall when turn-start memory is disabled', async () => {
    const out = await post({
      owner: 'meeting-prep-run-1',
      prompt: 'prepare me for the Acme review',
      memoryEnabled: false,
    });

    expect(out.text).toBe('');
    expect(buildPersonalAmbientContextBlockMock).not.toHaveBeenCalled();
  });
});

/**
 * Delivery-coverage emission (WI-37597).
 *
 * `recordInjectionCoverage` used to be called from `mid-turn-context.ts` and
 * nowhere else, so `context_injection_coverage` had never held a single
 * `turn-start` row for any client. The detector that answers "is this client
 * being served context?" was therefore structurally blind to a turn-start
 * outage — which is why EI-20001110634702380, a real turn-start injection
 * failure, closed cause-undetermined.
 *
 * ⚠ The near-miss that made this hard to see: this file ALREADY contained
 * `port: 'turn-start'`, on the `session` object feeding memory_recall_stats —
 * a DIFFERENT SINK. A grep for the port literal said "covered" while the
 * counter had never been written. These cases assert the RECORDER was called,
 * never that the string appears.
 */
describe('turn-start delivery coverage (WI-37597)', () => {
  it('records a recalled event, attributed to the calling client', async () => {
    await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();

    expect(recordInjectionCoverageMock).toHaveBeenCalledTimes(1);
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'recalled', client: 'omp' }),
    ]);
  });

  it('records no-recall when the pipeline returns nothing — healthy quiet is still a reading', async () => {
    // The whole point: a silent turn is DISTINGUISHABLE from a dead hook only
    // because the silent one still writes a row.
    buildMemoryContextBlockMock.mockResolvedValue(null);
    await post({ owner: 'sess-1', prompt: 'a prompt that matches nothing', client: 'claude' });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'no-recall' }),
    ]);
  });

  it('records no-signal when the caller opted out of memory', async () => {
    // Not an outage. Recording nothing here would make a client that always
    // disables memory indistinguishable from one whose hook is dead.
    await post({ owner: 'sess-1', prompt: 'anything', client: 'codex', memoryEnabled: false });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'no-signal', client: 'codex' }),
    ]);
  });

  it('records an UNATTRIBUTED client rather than inventing one', async () => {
    // A caller without the P-005 threading records '' — a real reading. Guessing
    // a client name here would manufacture coverage for a client that may not
    // have sent the request.
    await post({ owner: 'sess-1', prompt: 'no client field here' });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', client: '' }),
    ]);
  });

  it('records NOTHING when the pipeline throws — a fault must not read as healthy quiet', async () => {
    // The outcome vocabulary has no failure value, and 'no-recall' means healthy
    // quiet, so recording it would actively hide the fault. Writing nothing
    // leaves the turn absent from the numerator, which the outage detector
    // already reads as broken.
    buildMemoryContextBlockMock.mockRejectedValue(new Error('pg down'));
    const out = await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();
    expect(out.ok).toBe(true); // still fail-soft — the turn is never harmed
    expect(recordInjectionCoverageMock).not.toHaveBeenCalled();
  });

  it('never lets a failing coverage write harm the turn', async () => {
    // The recorder swallows its own errors, but the call site must survive one
    // regardless — this endpoint's whole contract is that it cannot cost a turn.
    recordInjectionCoverageMock.mockRejectedValue(new Error('coverage table gone'));
    const out = await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();
    expect(out.ok).toBe(true);
    expect(out.text).toContain('MEM-BLOCK');
  });
});

/**
 * WI-10002021 — `requiresFreshContext` means "a successor host must carry this before
 * it is acknowledged". That is a WAIT, but nothing ended it on its own: `stackBefore`
 * is rewritten ONLY when the control STATE next changes (control-anchor's ON CONFLICT
 * clause), never by acknowledgement. So the successor recomputed the identical
 * stackBefore→state.stack diff, got `relaunch-with-carry` again, skipped prepare+ack
 * again, and `applied` never converged to the specification it was actually running —
 * after which identity-grants-port reads current !== applied and denies
 * 'stale-artifact' on EVERY tool for the life of the session, including the
 * coord:orient recovery door. A wait with no terminating condition is a veto.
 *
 * The wait genuinely ends when THIS session's own launch record carries the desired
 * specification: the relaunch already happened and we are the successor.
 */
describe('relaunch-with-carry convergence (WI-10002021)', () => {
  const desired = { specificationRevision: 'spec-new', stateRevision: 'state-new' };
  const transitionWithActivation = {
    kind: 'stack',
    generation: 11,
    state: { activation: { desired } },
  };

  const armRelaunchWithCarry = () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue(transitionWithActivation);
    renderStackTransitionContextResultMock.mockResolvedValue({
      text: 'STACK-LAYER',
      rendered: true,
      requiresFreshContext: true,
    });
  };

  it('withholds acknowledgement while the launch record still predates the desired spec', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-old' });

    const out = await post({ owner: 'sess-1', prompt: 'before the relaunch' });

    expect(out.text).toBe('CTRL:stack\n\nSTACK-LAYER');
    expect(markControlTransitionPreparedMock).not.toHaveBeenCalled();
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('converges once the launch record carries the desired spec — the successor IS the fresh context', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-new' });

    const out = await post({ owner: 'sess-1', prompt: 'after the relaunch' });

    expect(out.text).toBe('CTRL:stack\n\nSTACK-LAYER');
    expect(markControlTransitionPreparedMock).toHaveBeenCalledWith('sess-1', 'ws-test', 11, desired);
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 11, undefined, desired);
  });

  it('a never-advancing launch record still never converges — the permanent-skip loop, pinned', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-old' });

    for (const prompt of ['turn one', 'turn two', 'turn three']) {
      await post({ owner: 'sess-1', prompt });
    }

    // Identical diff on every turn: this is exactly the loop that used to run for the
    // life of the session. The test above is what makes it terminate on a real relaunch.
    expect(renderStackTransitionContextResultMock).toHaveBeenCalledTimes(3);
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('keeps waiting when the launch record is unreadable — never acknowledges on a fault', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockRejectedValue(new Error('adv_sessions unreachable'));

    const out = await post({ owner: 'sess-1', prompt: 'launch record down' });

    expect(out.ok).toBe(true); // fail-soft: a read fault never costs the turn
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('keeps waiting when the launch record carries no specificationRevision at all', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ harnessSlug: 'papercusp' });

    await post({ owner: 'sess-1', prompt: 'legacy launch record' });

    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('does not consult the launch record at all for an ordinary in-place transition', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue(transitionWithActivation);
    renderStackTransitionContextResultMock.mockResolvedValue({
      text: 'STACK-LAYER',
      rendered: true,
      requiresFreshContext: false,
    });

    await post({ owner: 'sess-1', prompt: 'in-place mode flip' });

    expect(readSuLaunchSpecByOwnerMock).not.toHaveBeenCalled();
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
  });
});
