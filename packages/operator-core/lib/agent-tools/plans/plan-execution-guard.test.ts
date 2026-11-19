import { describe, expect, it, vi } from 'vitest';
import { checkPlanExecutionGuard, isPlanImplementationCall, isPlanResearchCommand, planExecutionMeaning } from './plan-execution-guard';
import type { ExecutionPlanBinding } from './plan-execution-guard';
import { resolveAgentGoal } from '../../agent-goal-ref';

const call = (toolName = 'apply_patch', args: unknown = { patch: 'implementation' }) =>
  ({ ownerId: 'su-builder', workspaceId: 'ws', toolName, args });
const binding = { planSlug: 'bound-plan', harnessSlug: 'project' };

describe('implementation authority before direct writes (EI-27540173897381380)', () => {
  it.each(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'capability:edit', 'capability:write', 'locks:acquire',
    'locks:acquire_granular', 'code:run', 'capability:bash', 'exec_command', 'shell', 'Bash',
    'mcp__papercusp_su__capability_edit', 'lsp:apply', 'mcp__papercusp_su__lsp_apply',
    'capability:launch-agent', 'fleet:launch-on-plan', 'plans:run-now'])('denies %s for a bound draft despite ad-hoc work/force/AUTO', async tool => {
    const result = await checkPlanExecutionGuard(call(tool, { force: true, purpose: 'repair', plan: 'another', mode: 'auto' }), {
      readBindings: async () => [binding], checkPlan: async () => ['plan_status:draft'],
    });
    expect(result).toMatchObject({ code: 'plan_execution_not_ready', planSlug: binding.planSlug });
    expect(result?.reason).toContain('plans:start');
  });
  it('allows an executable plan and a genuinely unbound single-item fix', async () => {
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [binding], checkPlan: async () => [] })).toBeNull();
    const checkPlan = vi.fn();
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [], checkPlan })).toBeNull();
    expect(checkPlan).not.toHaveBeenCalled();
  });
  it('avoids goal selection for an empty census but reads and enforces newly attached plans', async () => {
    const readBindings = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([binding]);
    const resolveGoal = vi.fn(async () => ({ goal: null, diagnostics: [] }));
    const checkPlan = vi.fn(async () => ['plan_not_started']);
    const deps = { readBindings, resolveGoal, checkPlan };
    const timings: string[] = [];

    expect(await checkPlanExecutionGuard({ ...call(), observeTiming: t => { timings.push(t.stage); } }, deps)).toBeNull();
    expect(resolveGoal).not.toHaveBeenCalled();
    expect(checkPlan).not.toHaveBeenCalled();
    expect(timings).toEqual(['bindings']);

    expect(await checkPlanExecutionGuard(call(), deps)).toMatchObject({
      planSlug: binding.planSlug, blockers: ['plan_not_started'],
    });
    expect(readBindings).toHaveBeenCalledTimes(2);
    expect(resolveGoal).not.toHaveBeenCalled();
    expect(checkPlan).toHaveBeenCalledWith(binding, 'ws', undefined);
  });
  // WI-6554700010049036: a timed-out goal selection used to refuse every
  // multi-plan census outright (plan_goal_resolution_timeout), even when every
  // bound plan was executable. It now keeps the full census, which is at least
  // as strict as any selected subset.
  const abortableGoalRead = (state: { signal?: AbortSignal; aborted: boolean }) =>
    async (_owner: string, _workspace: string, _observe: unknown, signal?: AbortSignal) => {
      state.signal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          state.aborted = true;
          reject(new Error('goal selector aborted'));
        }, { once: true });
      });
    };
  it('cancels a timed-out multi-plan goal read and permits a census whose plans all pass', async () => {
    const other = { planSlug: 'other-plan', harnessSlug: 'other-project' };
    const state: { signal?: AbortSignal; aborted: boolean } = { aborted: false };
    const checkPlan = vi.fn(async (_b: ExecutionPlanBinding) => [] as string[]);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [binding, other],
      resolveGoal: abortableGoalRead(state),
      checkPlan,
      goalResolutionBudgetMs: 5,
    });

    expect(result).toBeNull();
    expect(state.signal?.aborted).toBe(true);
    expect(state.aborted).toBe(true);
    expect(checkPlan.mock.calls.map(([b]) => b.planSlug).sort())
      .toEqual(['bound-plan', 'other-plan']);
  });
  it('still refuses with the unselected plan\'s own blockers when the goal read times out', async () => {
    const custody = { planSlug: 'predecessor-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'predecessor-plan#P-002' };
    const state: { signal?: AbortSignal; aborted: boolean } = { aborted: false };
    const checkPlan = vi.fn(async (b: { planSlug: string }) =>
      b.planSlug === 'predecessor-plan' ? ['activation_audit_stale'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [binding, custody],
      resolveGoal: abortableGoalRead(state),
      checkPlan,
      goalResolutionBudgetMs: 5,
    });

    expect(result).toMatchObject({
      code: 'plan_execution_not_ready',
      planSlug: 'predecessor-plan',
      blockers: ['activation_audit_stale'],
    });
    expect(result?.blockers).not.toContain('plan_goal_resolution_timeout');
    expect(state.aborted).toBe(true);
  });
  it.each(['activation_audit_stale', 'conversation_audit_required', 'acceptance_bar_contract_not_ready'])('retains %s as an actionable blocker', async blocker => {
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [binding], checkPlan: async () => [blocker] }))
      .toMatchObject({ blockers: [blocker] });
  });
  it('fails closed on unavailable authority or readiness instead of treating it as unbound', async () => {
    for (const deps of [
      { readBindings: async () => { throw Error('unavailable'); }, checkPlan: async () => [] },
      { readBindings: async () => [binding], checkPlan: async () => { throw Error('unavailable'); } },
    ]) expect(await checkPlanExecutionGuard(call(), deps)).toMatchObject({ blockers: ['plan_authority_unavailable'] });
  });
  it('checks the canonical selected work-item plan without inheriting an unrelated held plan', async () => {
    const selected = {
      planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item' as const, sourceRef: 'EI-security',
    };
    const unrelated = {
      planSlug: 'unrelated-plan', harnessSlug: 'project',
      source: 'plan-item-claim' as const, sourceRef: 'unrelated-plan#P-008',
    };
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    expect(goal).toMatchObject({ ref: 'EI-security', source: 'work-item', competing: ['unrelated-plan#P-008'] });

    const checkPlan = vi.fn(async (binding: { planSlug: string }) =>
      binding.planSlug === 'unrelated-plan' ? ['plan_status:draft'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [selected, unrelated],
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan,
    });

    expect(result).toBeNull();
    expect(checkPlan.mock.calls.map(([binding]) => binding.planSlug)).toEqual(['security-plan']);
  });
  it('records each checked binding while diagnostic failures cannot change allow or refusal', async () => {
    for (const blockers of [[], ['plan_not_started']]) {
      const timings: Array<{ stage: string; durationMs: number }> = [];
      const result = await checkPlanExecutionGuard({ ...call(), observeTiming: timing => {
        timings.push(timing); throw Error('broken timing sink');
      } }, {
        readBindings: async () => [binding, { planSlug: 'other-plan', harnessSlug: 'other-project' }],
        resolveGoal: async (_owner, _workspace, observe) => {
          expect(observe).toBeTypeOf('function');
          return { goal: null, diagnostics: [] };
        },
        checkPlan: async (_binding, _workspace, observe) => {
          expect(observe).toBeTypeOf('function');
          return blockers;
        },
      });
      expect(timings.map(t => t.stage)).toContain('goal_selector');
      expect(timings.map(t => t.stage).filter(stage => stage === 'binding')).toHaveLength(blockers.length ? 1 : 2);
      expect(timings.every(t => Number.isFinite(t.durationMs) && t.durationMs >= 0)).toBe(true);
      if (blockers.length) expect(result).toMatchObject({ blockers });
      else expect(result).toBeNull();
    }
  });
  it('retains failed-read timing and the original fail-closed verdict', async () => {
    const timings: string[] = [];
    expect(await checkPlanExecutionGuard({ ...call(), observeTiming: t => { timings.push(t.stage); } }, {
      readBindings: async () => { throw Error('unavailable'); }, checkPlan: vi.fn(),
    })).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    expect(timings).toEqual(['bindings']);
  });
  it('still refuses an unstarted plan attached to the selected work-item', async () => {
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [
        { planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item', sourceRef: 'EI-security' },
        { planSlug: 'unrelated-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'unrelated-plan#P-008' },
      ],
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan: async binding => binding.planSlug === 'security-plan' ? ['plan_not_started'] : ['plan_status:draft'],
    });

    expect(result).toMatchObject({
      code: 'plan_execution_not_ready',
      planSlug: 'security-plan',
      blockers: ['plan_not_started'],
    });
  });
  it('skips goal selection when several sources name one plan (WI-6554700010048224)', async () => {
    // Census shape measured on live fleet members: a NULL-harness session row, a
    // harness-scoped claim and a canonical work item, all naming ONE plan.
    const census: ExecutionPlanBinding[] = [
      { planSlug: 'bound-plan', harnessSlug: null, source: 'active-session', sourceRef: 'bound-plan' },
      { planSlug: 'bound-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'bound-plan#P-001' },
      { planSlug: 'bound-plan', harnessSlug: 'project', source: 'work-item', sourceRef: 'WI-1',
        canonical: { itemId: 'WI-1', lineId: 'P-001', ownerId: 'su-builder', nodeVersion: '1', lineVersion: '1',
          planVersion: 1, planHash: 'h' } },
    ];
    const resolveGoal = vi.fn((): Promise<never> => new Promise(() => {}));
    const checkPlan = vi.fn(async () => [] as string[]);
    const timings: string[] = [];
    const result = await checkPlanExecutionGuard({ ...call(), observeTiming: t => { timings.push(t.stage); } },
      { readBindings: async () => census, resolveGoal, checkPlan, goalResolutionBudgetMs: 5 });

    expect(result).toBeNull();
    expect(resolveGoal).not.toHaveBeenCalled();
    expect(timings).toContain('goal_selector_skipped');
    // Skipping selection still enforces the whole same-plan census.
    expect(checkPlan).toHaveBeenCalledTimes(3);
  });
  it('still selects when one slug is bound in two harnesses (WI-6554700010048224)', async () => {
    const resolveGoal = vi.fn((): Promise<never> => new Promise(() => {}));
    const checkPlan = vi.fn(async (b: ExecutionPlanBinding) =>
      b.harnessSlug === 'other-project' ? ['plan_status:draft'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [binding, { planSlug: binding.planSlug, harnessSlug: 'other-project' }],
      resolveGoal, checkPlan, goalResolutionBudgetMs: 5,
    });
    expect(resolveGoal).toHaveBeenCalledTimes(1);
    // The timeout keeps both harness bindings in the census (WI-6554700010049036).
    expect(checkPlan).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ planSlug: binding.planSlug, blockers: ['plan_status:draft'] });
  });
  describe('exact held-item goals with a blocked same-plan sibling (EI-29038937921197099)', () => {
    const census = (): ExecutionPlanBinding[] => [
      { ...binding, source: 'session-brief', sourceRef: binding.planSlug },
      { ...binding, source: 'work-item', sourceRef: 'WI-008', canonicalInvalid: true },
      { ...binding, source: 'work-item', sourceRef: 'WI-007', canonical: {
        itemId: 'WI-007', lineId: 'P-007', ownerId: 'su-builder', nodeVersion: '1', lineVersion: '1',
        planVersion: 1, planHash: 'h',
      } },
    ];
    const goalFor = (ref: string) => resolveAgentGoal({ workItems: [{ id: ref }] })!;

    it('selects the exact item afresh while retaining its parent checks and the sibling refusal', async () => {
      const readBindings = vi.fn(async () => census());
      const resolveGoal = vi.fn()
        .mockResolvedValueOnce({ goal: goalFor('WI-007'), diagnostics: [] })
        .mockResolvedValueOnce({ goal: goalFor('WI-008'), diagnostics: [] });
      const checkPlan = vi.fn(async (_binding: ExecutionPlanBinding) => [] as string[]);
      const deps = { readBindings, resolveGoal, checkPlan };
      expect(await checkPlanExecutionGuard(call(), deps)).toBeNull();
      expect(checkPlan.mock.calls.map(([b]) => b.canonical?.itemId ?? 'parent')).toEqual(['parent', 'WI-007']);
      checkPlan.mockClear();
      expect(await checkPlanExecutionGuard(call(), deps)).toMatchObject({ blockers: ['canonical_plan_binding_invalid'] });
      expect(readBindings).toHaveBeenCalledTimes(2);
      expect(resolveGoal).toHaveBeenCalledTimes(2);
      expect(checkPlan.mock.calls.some(([b]) => b.canonical?.itemId === 'WI-007')).toBe(false);
    });

    it('still refuses an invalid selected mapping and an unstarted parent', async () => {
      const bindings = census();
      bindings[2] = { ...bindings[2], canonical: undefined, canonicalInvalid: true };
      expect(await checkPlanExecutionGuard(call(), {
        readBindings: async () => bindings,
        resolveGoal: async () => ({ goal: goalFor('WI-007'), diagnostics: [] }), checkPlan: async () => [],
      })).toMatchObject({ blockers: ['canonical_plan_binding_invalid'] });
      expect(await checkPlanExecutionGuard(call(), {
        readBindings: async () => census(),
        resolveGoal: async () => ({ goal: goalFor('WI-007'), diagnostics: [] }),
        checkPlan: async () => ['plan_not_started'],
      })).toMatchObject({ blockers: ['plan_not_started'] });
    });

    it.each(['plan-wide', 'missing-goal', 'unbound-selection', 'diagnostics', 'incomplete-metadata'])(
      'keeps the full census for %s rather than trusting caller attribution', async kind => {
        const bindings = census();
        if (kind === 'incomplete-metadata') bindings[0] = { ...bindings[0], source: undefined };
        const goal = kind === 'plan-wide' ? resolveAgentGoal({ override: { ref: binding.planSlug } })
          : kind === 'missing-goal' ? null : goalFor(kind === 'unbound-selection' ? 'WI-not-held' : 'WI-007');
        expect(await checkPlanExecutionGuard(call('code:run', { work_item_id: 'WI-007', code: 'return 1' }), {
          readBindings: async () => bindings,
          resolveGoal: async () => ({ goal, diagnostics: kind === 'diagnostics' ? ['goal_read_unavailable'] : [] }),
          checkPlan: async () => [],
        })).toMatchObject({ blockers: ['canonical_plan_binding_invalid'] });
      });

    it('keeps the blocked sibling when selection is absent or times out', async () => {
      const state: { signal?: AbortSignal; aborted: boolean } = { aborted: false };
      expect(await checkPlanExecutionGuard(call(), {
        readBindings: async () => census(), resolveGoal: abortableGoalRead(state),
        goalResolutionBudgetMs: 5, checkPlan: async () => [],
      })).toMatchObject({ blockers: ['canonical_plan_binding_invalid'] });
      expect(state.aborted).toBe(true);
      expect(await checkPlanExecutionGuard(call(), {
        readBindings: async () => census(), checkPlan: async () => [],
      })).toMatchObject({ blockers: ['canonical_plan_binding_invalid'] });
    });
  });
  it('keeps the full binding census when current goal resolution is incomplete', async () => {
    const checkPlan = vi.fn(async (binding: { planSlug: string }) =>
      binding.planSlug === 'unrelated-plan' ? ['plan_status:draft'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [
        { planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item', sourceRef: 'EI-security' },
        { planSlug: 'unrelated-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'unrelated-plan#P-008' },
      ],
      resolveGoal: async () => ({ goal: null, diagnostics: [{ leg: 'work-items' }] }),
      checkPlan,
    });

    expect(result).toMatchObject({ planSlug: 'unrelated-plan', blockers: ['plan_status:draft'] });
    expect(checkPlan).toHaveBeenCalledTimes(2);
  });
  it.each(['Read', 'Grep', 'Glob', 'plans:edit', 'plans:audit', 'plans:start', 'reports:publish', 'work_items:checkpoint'])('keeps %s available without reading blocked plan authority', async toolName => {
    const readBindings = vi.fn();
    expect(await checkPlanExecutionGuard(call(toolName), { readBindings, checkPlan: vi.fn() })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });
  it('permits bounded read-only shell research but refuses unsafe sed, redirection, interpreters, substitutions and external search hooks', () => {
    for (const command of ['pwd', 'rg -n scope source.ts | head -20', "cat 'source file.ts'", 'ls; wc -l source.ts',
      "sed -n '1,20p' source.ts", "sed -n '$p' source.ts", "sed -n '1,20p' source.ts | head -5"])
      expect(isPlanResearchCommand(command), command).toBe(true);
    for (const command of ['cat x > source.ts', 'python -c "open(\"x\",\"w\")"', 'rg --pre=sh x',
      'rg --hostname-bin sh x', 'ls $(touch x)', 'ls `touch x`', 'cat x\ntouch y', 'ls || touch x', 'ls |',
      'rg -n scope *', 'rg -n scope --*', 'r* -n scope source.ts', './r* -n scope source.ts',
      "sed -n '1*p' source.ts", 'rg --pre=sh scope src/*.ts', 'rg -n scope src/$(touch x)*',
      "sed -i 's/old/new/' source.ts", "sed -n '1w output' source.ts",
      "sed -n '1,20p' source.ts > copy.ts", "sed -n '1,20p' source.ts; touch output",
      "python -c \"print(open('scratch.txt').read())\""])
      expect(isPlanResearchCommand(command), command).toBe(false);
    expect(isPlanImplementationCall('write_stdin', { chars: '' })).toBe(false);
    expect(isPlanImplementationCall('write_stdin', { chars: 'touch x\n' })).toBe(true);
  });
  it.each([
    'git cat-file -t 755838ff5d1',
    "git cat-file -e '755838ff5d1^{commit}'",
    "git rev-parse --verify --end-of-options '755838ff5d1^{commit}'",
    "git -C '/tmp/exact source' rev-parse --verify '755838ff5d1^{commit}'",
    'git branch --show-current',
    'git rev-parse --show-toplevel',
  ])('allows exact read-only Git identity before plan activation: %s', async cmd => {
    const readBindings = vi.fn(async () => [binding]);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
      readBindings, checkPlan: vi.fn(async () => ['plan_not_started']),
    })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });
  it.each([
    'git -c alias.ident=!touch ident',
    'git -c core.fsmonitor=unsafe status', 'git --exec-path=/tmp cat-file -t 755838ff5d1',
    'git cat-file --filters 755838ff5d1', 'git cat-file --batch-command',
    "git rev-parse --verify 'HEAD^{commit}'", 'git branch new-branch', 'git checkout 755838ff5d1',
    "git rev-parse --verify '755838ff5d1^{commit}' > saved-sha",
    'git cat-file -t 755838ff5d1; touch output', 'git cat-file -t $(touch output)',
    'git -C relative rev-parse --show-toplevel',
    'node scripts/source-preview.mjs verifier-prepare --repo /repo --ref 755838ff5d1',
  ])('keeps Git mutation, custom execution and raw source export behind plan authority: %s', cmd => {
    expect(isPlanResearchCommand(cmd)).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd })).toBe(true);
  });
  it.each([
    'pwd\nrg -n scope source.ts\nsed -n \'1,20p\' source.ts\n',
    'cat source.ts\r\nhead -20 other.ts',
    '\n  \ncat source.ts\n',
  ])('allows batches of complete read-only lines without plan authority: %s', async cmd => {
    const readBindings = vi.fn(async () => [binding]);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
      readBindings, checkPlan: vi.fn(async () => ['plan_not_started']),
    })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });
  it.each([
    'cat source.ts\ntouch output',
    'cat source.ts\npython3 -c "print(1)"',
    "cat 'source\nfile.ts'",
    'cat source.ts \\\ntouch output',
    'cat source.ts\n> output',
  ])('keeps mixed, incomplete and mutating line batches behind plan authority: %s', cmd => {
    expect(isPlanResearchCommand(cmd)).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd })).toBe(true);
  });
  it.each([
    "rg -n 'bar-critique|rubric-vetting' packages/operator-core/lib/agent-tools/consult packages/operator-core/lib/consult*",
    "rg -n 'scope*' src/*.ts",
    'rg -n scope ./source*.ts',
    'rg -n scope /tmp/source?.ts',
    "sed -n '1p' src/*.ts",
    'rg -n scope src/[abc]*.ts | head -5',
  ])('permits filename glob research without consulting blocked plan authority: %s', async cmd => {
    const readBindings = vi.fn(async () => [binding]);
    const checkPlan = vi.fn(async () => ['plan_not_started']);
    expect(isPlanResearchCommand(cmd)).toBe(true);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
    expect(checkPlan).not.toHaveBeenCalled();
  });
  it.each([
    'ptool --idempotency-key 9c552a68-e724-4afe-8da1-15eca6a7e32a plans:audit --json -',
    'ptool plans:audit --json - --idempotency-key=9c552a68-e724-4afe-8da1-15eca6a7e32a',
    'ptool --workspace=papercusp --harness papercusp --json - plans:audit',
    'ptool --url http://127.0.0.1:3170 plans:audit --json -',
    'ptool plans:audit --json - 2>/dev/null',
  ])('preserves canonical activation repair through supported CLI flags: %s', async header => {
    const cmd = [header + " <<'JSON'", '{"slug":"review-plan","phase":"activation"}', 'JSON'].join('\n');
    const readBindings = vi.fn(async () => [binding]);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
      readBindings, checkPlan: vi.fn(async () => ['plan_not_started']),
    })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });
  it('checks the wrapped target and rejects malformed replay headers', () => {
    const wrapped = (header: string, name = 'plans:audit') => [
      header + " <<'JSON'", JSON.stringify({ name, args: { slug: 'review-plan' } }), 'JSON',
    ].join('\n');
    const header = 'ptool --idempotency-key replay-1 tools:invoke --json -';
    expect(isPlanImplementationCall('exec_command', { cmd: wrapped(header) })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: wrapped(header, 'capability:bash') })).toBe(true);
    for (const invalid of [
      'ptool --idempotency-key tools:invoke --json -',
      'ptool --idempotency-key=a tools:invoke --idempotency-key=b --json -',
      'ptool --idempotency-key="$(touch output)" tools:invoke --json -',
      'ptool --idempotency-key="" tools:invoke --json -',
      'ptool --token-file=/tmp/token tools:invoke --json -',
      'ptool --url=http://outside.example tools:invoke --json -',
      'ptool tools:invoke --json - > /tmp/output',
      'ptool tools:invoke --json - 2>/tmp/output',
      'ptool tools:invoke --json -; touch output',
    ]) expect(isPlanImplementationCall('exec_command', { cmd: wrapped(invalid) }), invalid).toBe(true);
  });
  it('permits bounded PTool contract reads and consult replies while refusing implementation calls', async () => {
    const readCommand = [
      "ptool plans:get --json - --harness=papercusp <<'JSON'",
      '{"slug":"review-plan"}',
      'JSON',
    ].join('\n');
    const replyCommand = [
      "ptool consult:reply --json - --harness=papercusp <<'JSON'",
      '{"conversation_id":"consult-1","kind":"answer","body":"Reviewed.","evidence":[{"session_id":"session-1","turn_idx":3}]}',
      'JSON',
    ].join('\n');
    const auditArgs = { slug: 'review-plan', harness: 'papercusp', phase: 'activation', dryRun: false };
    const auditCommand = [
      "ptool plans:audit --json - --harness=papercusp <<'JSON'",
      JSON.stringify(auditArgs),
      'JSON',
    ].join('\n');
    const wrappedAuditCommand = [
      "ptool tools:invoke --json - --harness=papercusp <<'JSON'",
      JSON.stringify({ name: 'plans:audit', args: auditArgs }),
      'JSON',
    ].join('\n');
    const writeCommand = [
      "ptool work_items:set_state --json - <<'JSON'",
      '{"id":"WI-123","state":"done"}',
      'JSON',
    ].join('\n');

    expect(isPlanImplementationCall('exec_command', { cmd: readCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: replyCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: auditCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: wrappedAuditCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: writeCommand })).toBe(true);
    expect(isPlanImplementationCall('exec_command', { cmd: "ptool tools:invoke --json - <<'JSON'\n{}\nJSON" })).toBe(true);
    expect(isPlanImplementationCall('exec_command', { cmd: "ptool plans:get --json - <<JSON\n{}\nJSON" })).toBe(true);

    const readBindings = vi.fn(async () => [binding]);
    const checkPlan = vi.fn(async () => ['plan_status:draft']);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: readCommand }), { readBindings, checkPlan })).toBeNull();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: replyCommand }), { readBindings, checkPlan })).toBeNull();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: auditCommand }), { readBindings, checkPlan })).toBeNull();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: wrappedAuditCommand }), { readBindings, checkPlan })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: writeCommand }), { readBindings, checkPlan }))
      .toMatchObject({ code: 'plan_execution_not_ready', blockers: ['plan_status:draft'] });
    expect(readBindings).toHaveBeenCalledTimes(1);
  });
});

describe('canonical readiness evidence and coordination remain available before activation (WI-6554700010047155)', () => {
  const ptool = (name: string, args: unknown, wrapped = false) => [
    `ptool ${wrapped ? 'tools:invoke' : name} --url=http://127.0.0.1:3170 --json - --harness=papercusp <<'JSON'`,
    JSON.stringify(wrapped ? { name, args } : args),
    'JSON',
  ].join('\n');

  it.each([
    ['sessions:read', { ref: 'session_turn:codex:source:0' }],
    ['sessions:search', { session: 'self', mode: 'verbatim', query: 'original requirement' }],
    ['tools:find', { query: 'work_items:complete' }],
    ['conversations:get', { id: 'consult-1' }],
    ['plans:revisions', { slug: 'review-plan' }],
    ['plans:revision-transcript', { revisionId: 1 }],
    ['journal:push-utilization', { sinceHours: 24 }],
    ['facts:list', { scope: 'workspace', key: 'required-guard', full: true }],
    ['capability:read', { file_path: 'source.ts' }],
    ['plans:get-specs', { slug: 'review-plan', planItemIds: ['P-008'] }],
    ['plans:get-spec-evidence', { slug: 'review-plan' }],
    ['plans:get-item', { slug: 'review-plan', id: 'P-008' }],
    ['recipes:search', { query: 'canonical acceptance preparation' }],
    ['rubrics:get', { rubricRef: 'spec-quality' }],
    ['rubrics:list', { subjectPlan: 'review-plan', limit: 1 }],
    ['rubrics:search', { query: 'acceptance-review-plan', kind: 'acceptance' }],
    ['rubrics:propose', { kind: 'acceptance', rubricRef: 'acceptance-review-plan', subjectPlan: 'review-plan',
      classRef: 'plan-class-investigation', characteristic: 'quality', title: 'Acceptance', criteria: [] }],
    ['rubrics:amend-status', { amendmentId: 'amend-1' }],
    ['scorecards:get', { issueId: 'EI-123' }],
    ['processes:list', { taskId: 'readiness-review-task', live: true, limit: 1 }],
    ['scorecards:evaluate', { rubricRef: 'spec-quality', eligibilityOnly: true }],
    ['scorecards:emit', { rubricRef: 'spec-quality', ratings: {} }],
    ['scorecards:repair', { targetIds: ['EI-123'], harness: 'papercusp' }],
    ['plans:edit', { slug: 'review-plan', action: 'update', itemId: 'P-008', text: 'Reconciled outcome' }],
    ['plans:set-specs', { slug: 'review-plan', specs: [] }],
    ['plans:migrate-acceptance-bars', { planSlug: 'review-plan', dryRun: true, batchSize: 1 }],
    ['rubrics:amend', { rubricRef: 'acceptance-review-plan', expectedRevision: 1, dryRun: true }],
    ['coord:send', { to: ['peer'], summary: 'Readiness evidence', expects: 'none' }],
    ['coord:declare-intent', { intent: 'Reconcile draft discovery' }],
    ['work_items:checkpoint', { id: 'WI-123', next: 'Read original source' }],
    ['work_items:comment', { id: 'WI-123', body: 'Source evidence retained' }],
    ['work_items:release', { id: 'WI-123', reason: 'Hand back preserved evidence' }],
    ['work_items:link', { id: 'WI-provider', rel: 'blocks', target_id: 'WI-123', satisfaction: 'success' }],
    ['work_items:hold_open', { id: 'WI-123', clear: true, ownerOverride: true,
      reconcile: { reasonCode: 'operator-directed', evidence: 'Reviewed readiness disposition D-044', dryRun: true } }],
    ['work_items:hold_open', { id: 'WI-123', clear: true, ownerOverride: true,
      reconcile: { reasonCode: 'operator-directed', evidence: 'Reviewed readiness disposition D-044', expectedParkFingerprint: 'a'.repeat(64) } }],
    ['loop:checkpoint', { next: 'Continue discovery' }],
    ['plans:set-content', { slug: 'review-plan', content: 'Reconciled discovery' }],
  ])('permits exact %s calls without consulting an unstarted plan', async (name, args) => {
    for (const wrapped of [false, true]) {
      const cmd = ptool(name as string, args, wrapped);
      const readBindings = vi.fn(async () => [binding]);
      const checkPlan = vi.fn(async () => ['plan_not_started']);
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan }), cmd).toBeNull();
      expect(readBindings).not.toHaveBeenCalled();
      expect(checkPlan).not.toHaveBeenCalled();
    }
  });

  it('keeps implementation, autonomy changes and altered shell envelopes behind readiness', async () => {
    const valid = ptool('sessions:read', { session: 'self' });
    for (const cmd of [
      valid + '\ntouch source.ts',
      valid.replace("<<'JSON'", '<<JSON'),
      valid.replace(" <<'JSON'", " > output <<'JSON'"),
      ptool('capability:write', { file_path: 'source.ts', content: 'changed' }, true),
      ptool('code:run', { script: 'return 1' }, true),
      ptool('work_items:set_state', { id: 'WI-123', state: 'done' }),
      ptool('work_items:hold_open', { id: 'WI-123', reason: 'Create a new hold' }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: true }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: 'true', reconcile: {} }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: true, reconcile: null }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: true, reconcile: [] }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: true, reconcile: 'reviewed' }),
      ptool('work_items:hold_open', { id: 'WI-123', clear: true, force: true,
        reconcile: { reasonCode: 'operator-directed', evidence: 'Reviewed readiness disposition D-044', dryRun: true } }),
      ptool('loop:arm', { intervalSec: 60, goal: 'New autonomous mission' }),
      ptool('tools:invoke', { name: 'sessions:read', args: { session: 'self' } }, true),
      ptool('sessions:unknown', {}),
    ]) {
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
        readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
      }), cmd).toMatchObject({ blockers: ['plan_not_started'] });
    }
  });

  it.each([
    ['rubrics:list', { subjectPlan: 'review-plan', limit: 1 }],
    ['rubrics:search', { query: 'acceptance-review-plan', kind: 'acceptance' }],
    ['rubrics:propose', { kind: 'acceptance', rubricRef: 'acceptance-review-plan', subjectPlan: 'review-plan' }],
  ])('keeps altered %s bootstrap envelopes behind plan readiness', async (name, args) => {
    for (const wrapped of [false, true]) {
      const valid = ptool(name as string, args, wrapped);
      for (const cmd of [
        valid + '\ntouch source.ts',
        valid.replace("<<'JSON'", '<<JSON'),
        valid.replace(" <<'JSON'", " > output <<'JSON'"),
      ]) {
        expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
          readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
        }), cmd).toMatchObject({ blockers: ['plan_not_started'] });
      }
    }
  });

  it('keeps general grading and scorecard persistence behind implementation readiness', async () => {
    const cases = [
      ['rubrics:propose', { rubricRef: 'standard-quality' }],
      ['rubrics:propose', { kind: 'standard', rubricRef: 'standard-quality' }],
      ['rubrics:propose', { kind: true, rubricRef: 'acceptance-review-plan' }],
      ['rubrics:ratify', { rubricRef: 'acceptance-review-plan' }],
      ['scorecards:evaluate', { rubricRef: 'spec-quality' }],
      ['scorecards:evaluate', { rubricRef: 'spec-quality', eligibilityOnly: false }],
      ['scorecards:evaluate', { rubricRef: 'spec-quality', eligibilityOnly: 'true' }],
      ['scorecards:emit', { rubricRef: 'acceptance-review-plan', ratings: {} }],
      ['scorecards:emit', { rubricRef: 'grading-integrity', ratings: {} }],
      ['processes:kill', { taskId: 'readiness-review-task' }],
      ['processes:freeze', { taskId: 'readiness-review-task' }],
    ] as const;
    for (const [name, args] of cases) {
      for (const wrapped of [false, true]) {
        expect(await checkPlanExecutionGuard(call('exec_command', { cmd: ptool(name, args, wrapped) }), {
          readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
        })).toMatchObject({ code: 'plan_execution_not_ready', blockers: ['plan_not_started'] });
      }
    }
  });
});

describe('spec-quality evaluation is available before activation (EI-28269500162831951)', () => {
  const ptool = (detail: 'full' | 'summary', wrapped = false, scope = '--harness=papercusp') => {
    const args = { slug: 'review-plan', harness: 'papercusp', detail };
    return [
      `ptool ${wrapped ? 'tools:invoke' : 'plans:evaluate-spec-quality'} --json - ${scope} <<'JSON'`,
      JSON.stringify(wrapped ? { name: 'plans:evaluate-spec-quality', args } : args),
      'JSON',
    ].join('\n');
  };

  it.each(['full', 'summary'] as const)('permits %s evaluation without consulting an unstarted plan', async detail => {
    for (const wrapped of [false, true]) {
      for (const scope of ['--harness=papercusp', '--workspace="$PAPERCUSP_WORKSPACE" --harness=papercusp',
        '--workspace="${PAPERCUSP_WORKSPACE}" --harness="${PAPERCUSP_HARNESS_SLUG}"']) {
        const cmd = ptool(detail, wrapped, scope);
        const readBindings = vi.fn(async () => [binding]);
        const checkPlan = vi.fn(async () => ['plan_not_started']);
        expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan }), cmd).toBeNull();
        expect(readBindings).not.toHaveBeenCalled();
        expect(checkPlan).not.toHaveBeenCalled();
      }
    }
  });

  it('retains activation enforcement for shell side effects and non-canonical evaluator calls', async () => {
    const valid = ptool('full');
    const unsafe = [
      valid + '\ntouch output',
      valid.replace(" <<'JSON'", " > output <<'JSON'"),
      valid.replace('plans:evaluate-spec-quality', 'work_items:set_state'),
      ptool('full', false, '--workspace="$OTHER_WORKSPACE"'),
      ptool('full', false, '--workspace="$(touch output)"'),
      ptool('full', false, '--workspace="$PAPERCUSP_HARNESS_SLUG"'),
      ptool('full', false, '--harness=papercusp --harness=other'),
    ];
    for (const cmd of unsafe) {
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
        readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
      }), cmd).toMatchObject({ code: 'plan_execution_not_ready', blockers: ['plan_not_started'] });
    }
  });
});

describe('reviewer read and decline are independent of plan activation (EI-27697470834897410)', () => {
  const ptool = (name: string, args: unknown) =>
    [`ptool ${name} --json - <<'JSON'`, JSON.stringify(args), 'JSON'].join('\n');

  it.each([false, true])('allows exact reviewer targets when plan authority is unavailable; wrapped=%s', async wrapped => {
    const readBindings = vi.fn(async () => { throw Error('authority unavailable'); });
    for (const [name, args] of [
      ['conversations:get', { id: 'consult-1' }],
      ['consult:decline', { conversation_id: 'consult-1', reason: 'Cannot read evidence' }],
    ] as const) {
      const cmd = wrapped ? ptool('tools:invoke', { name, args }) : ptool(name, args);
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan: vi.fn() })).toBeNull();
    }
    expect(readBindings).not.toHaveBeenCalled();
  });

  it('keeps nested mutation targets, shell execution and altered wrappers fail-closed', async () => {
    const read = ptool('conversations:get', { id: 'consult-1' });
    const write = ptool('tools:invoke', { name: 'capability:write', args: { file_path: 'source.ts', content: 'changed' } });
    const nested = ptool('tools:invoke', { name: 'tools:invoke', args: { name: 'conversations:get', args: { id: 'consult-1' } } });
    const override = ptool('tools:invoke', { name: 'conversations:get', args: { id: 'consult-1' }, authenticatedPrincipal: 'someone-else' });
    for (const cmd of [write, nested, override, read + '\ntouch source.ts', read.replace("<<'JSON'", '<<JSON'),
      read.replace('ptool ', 'FAKE=1 ptool '), read.replace(' --json', ' --url=http://elsewhere --json')]) {
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
        readBindings: async () => { throw Error('authority unavailable'); }, checkPlan: vi.fn(),
      }), cmd).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    }
  });
});

describe('documented pinned MCP helper recovery (EI-28910250918419088)', () => {
  const command = (header: string, args: unknown = { issueId: 'EI-audit', rerunRecipeOffset: 1153 }) =>
    [header + " <<'JSON'", JSON.stringify(args), 'JSON'].join('\n');

  it.each([
    'node scripts/mcp-call.mjs --port 33629 scorecards:get --json -',
    'node scripts/mcp-call.mjs scorecards:get --port=33629 --json=-',
    'node scripts/mcp-call.mjs --port 1 scorecards:get --json -',
    'node scripts/mcp-call.mjs --port 65535 scorecards:get --json -',
    'node scripts/mcp-call.mjs scorecards:get --json - --harness=papercusp',
  ])('recovers an exact evidence page without querying unavailable plan authority: %s', async header => {
    const readBindings = vi.fn(async () => { throw Error('pinned authority endpoint unreachable'); });
    const checkPlan = vi.fn();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: command(header) }), {
      readBindings, checkPlan,
    })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
    expect(checkPlan).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps canonical repair available while a bound plan is unstarted (wrapped=%s)', async wrapped => {
    const args = { targetIds: ['EI-audit'], harness: 'papercusp', sourcePreparation: {
      sourceRoot: '/frozen/exact-source', receiptPath: '/original.json',
      receiptSha256: 'a'.repeat(64), outputDir: '/new-audit-output',
    } };
    const cmd = command('node scripts/mcp-call.mjs --port 33629 '
      + (wrapped ? 'tools:invoke' : 'scorecards:repair') + ' --json -',
    wrapped ? { name: 'scorecards:repair', args } : args);
    const readBindings = vi.fn(async () => [binding]);
    const checkPlan = vi.fn(async () => ['plan_not_started']);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
    expect(checkPlan).not.toHaveBeenCalled();
  });

  it.each([
    'node --eval scripts/mcp-call.mjs scorecards:get --json -',
    'node scripts/other.mjs scorecards:get --json -',
    'node ./scripts/mcp-call.mjs scorecards:get --json -',
    'node scripts/mcp-call.mjs --port 0 scorecards:get --json -',
    'node scripts/mcp-call.mjs --port -1 scorecards:get --json -',
    'node scripts/mcp-call.mjs --port 65536 scorecards:get --json -',
    'node scripts/mcp-call.mjs --port 1e2 scorecards:get --json -',
    'node scripts/mcp-call.mjs --port 33629 --port 33630 scorecards:get --json -',
    'node scripts/mcp-call.mjs --client=someone-else scorecards:get --json -',
    'node scripts/mcp-call.mjs --url=http://outside.example scorecards:get --json -',
    'node scripts/mcp-call.mjs scorecards:get --json-file /tmp/args.json',
    'node scripts/mcp-call.mjs scorecards:get --json - > /tmp/output',
    'node scripts/mcp-call.mjs scorecards:get --json - 2>/tmp/output',
    'node scripts/mcp-call.mjs scorecards:get --json -; touch output',
  ])('keeps noncanonical helper invocations behind execution authority: %s', async header => {
    const cmd = command(header);
    expect(isPlanImplementationCall('exec_command', { cmd })).toBe(true);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
      readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
    })).toMatchObject({ code: 'plan_execution_not_ready', planSlug: binding.planSlug });
  });

  it.each([false, true])('continues to guard implementation writes through the helper (wrapped=%s)', async wrapped => {
    const args = { file_path: 'source.ts', content: 'changed' };
    const cmd = command('node scripts/mcp-call.mjs --port 33629 '
      + (wrapped ? 'tools:invoke' : 'capability:write') + ' --json -',
    wrapped ? { name: 'capability:write', args } : args);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
      readBindings: async () => [binding], checkPlan: async () => ['plan_not_started'],
    })).toMatchObject({ code: 'plan_execution_not_ready', planSlug: binding.planSlug });
  });
});

describe('canonical PTool start recovery (WI-6554700010046260)', () => {
  const command = (header: string, payload: unknown = { slug: 'review-plan', harness: 'papercusp' }) =>
    [header + " <<'JSON'", JSON.stringify(payload), 'JSON'].join('\n');

  it.each([
    'ptool plans:start --json -',
    'ptool plans:start --url=http://127.0.0.1:3170 --workspace=papercusp-workspace --harness=papercusp --json -',
    'ptool plans:start --json - --url http://localhost:3170 --workspace papercusp-workspace --harness papercusp',
    'ptool plans:start --json=- --harness="papercusp" --url="http://[::1]:3170"',
  ])('keeps the canonical start available before authority exists: %s', async header => {
    const readBindings = vi.fn(async () => { throw Error('authority unavailable'); });
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: command(header) }), {
      readBindings, checkPlan: vi.fn(),
    })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });

  it.each(['plans:get', 'plans:get-input-schema', 'plans:start', 'consult:decline'])(
    'preserves direct/wrapped target parity for %s with local URL and either scope syntax', async name => {
      const readBindings = vi.fn(async () => { throw Error('authority unavailable'); });
      for (const wrapped of [false, true]) {
        const header = 'ptool ' + (wrapped ? 'tools:invoke' : name)
          + ' --harness papercusp --json - --url=http://127.0.0.1:3170 --workspace="papercusp-workspace"';
        const args = { slug: 'review-plan', note: 'Inert $(touch source.ts) and C:\\source\\file' };
        const cmd = command(header, wrapped ? { name, args } : args);
        expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
          readBindings, checkPlan: vi.fn(),
        }), cmd).toBeNull();
      }
      expect(readBindings).not.toHaveBeenCalled();
    },
  );

  it('bounds validation of long malformed header words and quotes', () => {
    const started = performance.now();
    for (const suffix of ['@', "'", '"']) {
      const cmd = command('ptool plans:start --json - --harness=' + 'x'.repeat(16_000) + suffix);
      expect(isPlanImplementationCall('exec_command', { cmd })).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('keeps malformed headers, remote routing and implementation targets behind authority', async () => {
    const base = 'ptool plans:start --json -';
    const rejected = [
      command(base + ' --url=https://127.0.0.1:3170'),
      command(base + ' --url=http://example.com:3170'),
      command(base + ' --url=http://user:password@127.0.0.1:3170'),
      command(base + ' --url=http://127.0.0.1:3170/other'),
      command(base + ' --url=http://127.0.0.1:3170?workspace=other'),
      command(base + ' --workspace=papercusp --workspace=other'),
      command(base + ' --unknown=argument'),
      command(base + ' --harness=$(touch source.ts)'),
      command(base + " --harness='papercusp"),
      command('FAKE=1 ' + base),
      command(base + ' # comment'),
      command(base + ' > source.ts'),
      command(base + '; touch source.ts'),
      command(base + ' && touch source.ts'),
      command(base).replace("<<'JSON'", '<<JSON'),
      command(base) + '\ntouch source.ts',
      command('ptool capability:write --url=http://127.0.0.1:3170 --json -'),
      command('ptool tools:invoke --json -', { name: 'tools:invoke', args: { name: 'plans:start', args: {} } }),
      command('ptool tools:invoke --json -', { name: 'plans:start', args: {}, authenticatedPrincipal: 'someone-else' }),
    ];
    for (const cmd of rejected) {
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
        readBindings: async () => { throw Error('authority unavailable'); }, checkPlan: vi.fn(),
      }), cmd).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    }
  });
});

describe('activation freshness', () => {
  const original = '---\ntitle: Scope\nstatus: ready\nupdated: 2026-10-31\n---\n# Scope\n## Now\n**State:** Ready\n**Next:** Build\n## Requirements\nPersist all pending work.\n## Phase 1\n- **P-001** `todo` Persist the queue blocked-by: P-002\n';
  it('does not invalidate activation for progress, Now, or whitespace alone', () => {
    const after = original.replace('status: ready', 'status: active').replace('updated: 2026-10-31', 'updated: 2026-11-01')
      .replace('**State:** Ready', '**State:** Implementing').replace('**Next:** Build', '**Next:** Verify').replace('`todo`', '`wip`');
    expect(planExecutionMeaning(after)).toBe(planExecutionMeaning(original));
  });
  it.each(['WI-6554700010045594', 'EI-123', 'F-456'])('keeps generated claim progress current for %s', ref => {
    const claimed = original.replace('`todo`', '`wip`').replace('blocked-by: P-002', `blocked-by: P-002 — note: → ${ref}`);
    expect(planExecutionMeaning(claimed)).toBe(planExecutionMeaning(original));
    expect(planExecutionMeaning(claimed.replace(ref, 'WI-789'))).toBe(planExecutionMeaning(original));
  });
  it.each([' — needs a security review', ' extra scope', '\nAdditional requirement.'])('retains author scope after a generated claim receipt: %s', suffix => {
    const claimed = original.replace('blocked-by: P-002', `blocked-by: P-002 — note: → WI-123${suffix}`);
    expect(planExecutionMeaning(claimed)).not.toBe(planExecutionMeaning(original));
  });
  const promoted = '\n## Promoted\n\n<!-- plan-pipeline: do not edit this block manually -->\n- [ ] WI-123 — Persist the queue <!-- P-001 -->\n';
  it('keeps activation current after first promotion and later receipt-only updates', () => {
    expect(planExecutionMeaning(original + promoted)).toBe(planExecutionMeaning(original));
    expect(planExecutionMeaning(original + promoted.replace('WI-123', 'WI-456').replace('[ ]', '[x]')))
      .toBe(planExecutionMeaning(original));
  });
  it.each([
    ['unmarked prose', promoted.replace('<!-- plan-pipeline: do not edit this block manually -->', '')],
    ['author prose within a marked block', promoted + 'The task must retain all failures.\n'],
    ['similar marker', promoted.replace('plan-pipeline:', 'plan-pipeline-copy:')],
    ['different heading', promoted.replace('## Promoted', '## Requirements')],
    ['fenced example', '\n```markdown\n' + promoted + '```\n'],
    ['following decision', promoted + '\n## Decisions\n### D-001 Preserve evidence\nNever delete failed attempts.\n'],
  ])('preserves activation authority for %s', (_kind, addition) => {
    expect(planExecutionMeaning(original + addition)).not.toBe(planExecutionMeaning(original));
  });
  it.each([['pending', 'completed'], ['P-002', 'P-003'], ['`todo`', '`dropped`']])('invalidates changed scope/dependencies: %s', (before, after) => {
    expect(planExecutionMeaning(original.replace(before, after))).not.toBe(planExecutionMeaning(original));
  });
});
