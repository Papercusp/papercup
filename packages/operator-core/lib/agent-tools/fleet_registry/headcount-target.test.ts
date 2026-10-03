import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFleet: vi.fn(),
  getFleetHeadcountTarget: vi.fn(),
  setFleetHeadcountTarget: vi.fn(),
  resolveHarnessPlansDir: vi.fn(),
  readPlanBySlug: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...args: unknown[]) => mocks.getFleet(...args),
  getFleetHeadcountTarget: (...args: unknown[]) => mocks.getFleetHeadcountTarget(...args),
  setFleetHeadcountTarget: (...args: unknown[]) => mocks.setFleetHeadcountTarget(...args),
}));
vi.mock('../plans/source', () => ({
  resolveHarnessPlansDir: (...args: unknown[]) => mocks.resolveHarnessPlansDir(...args),
  readPlanBySlug: (...args: unknown[]) => mocks.readPlanBySlug(...args),
}));
vi.mock('./_shared', () => ({
  resolveFleetCaller: () => ({ workspaceId: 'ws-test', ownerId: 'su-leader' }),
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
}));
// P-007 / R-17: silent-member partition IO legs.
const silenceMocks = vi.hoisted(() => ({
  executingOwnersSince: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('../../fleet/assignments', () => ({
  executingOwnersSince: (...args: unknown[]) => silenceMocks.executingOwnersSince(...args),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: (...args: unknown[]) => silenceMocks.sql(...args) }),
}));

import tool from './headcount-target';
import {
  FLEET_MEMBER_SILENCE_THRESHOLD_MS,
  partitionSilentFleetMembers,
  readFleetMemberSilence,
} from './silent-member';

describe('silent fleet members (P-007 / R-17)', () => {
  beforeEach(() => {
    silenceMocks.executingOwnersSince.mockReset();
    silenceMocks.sql.mockReset();
  });

  it('uses the 20-minute D-007 threshold', () => {
    expect(FLEET_MEMBER_SILENCE_THRESHOLD_MS).toBe(20 * 60_000);
  });

  it('does not count a heartbeat-only member in an unpaused fleet, and names it silent', () => {
    // `quiet` is live (heartbeating) but made no call inside the threshold and only
    // holds the inbox-wake keepalive await — that is silence.
    const partition = partitionSilentFleetMembers({
      liveMemberIds: ['busy', 'quiet', 'waiting'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: new Map([
        ['quiet', ['coord:inbox-wake:quiet']],
        ['waiting', ['work-item:done:WI-1']],
      ]),
      fleetPaused: false,
    });
    expect(partition).not.toBeNull();
    expect(partition!.counted).toEqual(['busy', 'waiting']);
    expect(partition!.silent).toEqual(['quiet']);
    expect(partition!.counted).not.toContain('quiet');
  });

  it('still counts a silent member while the fleet is paused', () => {
    const partition = partitionSilentFleetMembers({
      liveMemberIds: ['busy', 'quiet'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: new Map(),
      fleetPaused: true,
    });
    expect(partition!.counted).toEqual(['busy', 'quiet']);
    expect(partition!.silent).toEqual([]);
    expect(partition!.paused).toBe(true);
  });

  it('answers unknown, not "everyone silent", when a leg is unreadable', () => {
    expect(partitionSilentFleetMembers({
      liveMemberIds: ['busy'],
      recentCallerIds: null,
      awaitingKeysByOwner: new Map(),
      fleetPaused: false,
    })).toBeNull();
    expect(partitionSilentFleetMembers({
      liveMemberIds: ['busy'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: null,
      fleetPaused: false,
    })).toBeNull();
  });

  it('reads calls over the threshold window and pending awaits for the live set', async () => {
    silenceMocks.executingOwnersSince.mockResolvedValue(new Set(['busy']));
    silenceMocks.sql.mockResolvedValue([
      { subscriber_id: 'quiet', event_key: 'coord:inbox-wake:quiet' },
    ]);
    const partition = await readFleetMemberSilence(['busy', 'quiet'], { fleetPaused: false });
    expect(silenceMocks.executingOwnersSince).toHaveBeenCalledWith(
      ['busy', 'quiet'],
      FLEET_MEMBER_SILENCE_THRESHOLD_MS,
    );
    expect(partition!.counted).toEqual(['busy']);
    expect(partition!.silent).toEqual(['quiet']);
  });

  it('skips the IO legs for a paused fleet', async () => {
    const partition = await readFleetMemberSilence(['quiet'], { fleetPaused: true });
    expect(silenceMocks.executingOwnersSince).not.toHaveBeenCalled();
    expect(partition!.counted).toEqual(['quiet']);
  });
});

const savedProfile = {
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  target: 1,
  config: {
    plan: 'byoc-plan',
    harness: 'papercusp',
    agent: 'codex' as const,
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    account: 'default',
    headless: true,
    carry: 'warm' as const,
    contextSize: 'trimmed' as const,
  },
  nextAttemptAt: null,
  backoffMs: 0,
  lastError: null,
};

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFleet.mockResolvedValue({ fleetSlug: 'byoc' });
  mocks.getFleetHeadcountTarget.mockResolvedValue(savedProfile);
  mocks.setFleetHeadcountTarget.mockResolvedValue(undefined);
  mocks.resolveHarnessPlansDir.mockResolvedValue({ workspaceId: 'ws-test', harnessSlug: 'papercusp' });
  mocks.readPlanBySlug.mockResolvedValue({ slug: 'byoc-plan' });
});

describe('fleet:headcount-target canonical launch profile', () => {
  it('accepts a planless claim-spec target while still requiring its harness', async () => {
    const planlessArgs = {
      fleet: 'byoc',
      target: 50,
      productiveCapacityFloor: 1,
      harness: 'papercusp',
      agent: 'codex',
      model: 'gpt-6-luna',
      effort: 'max',
      account: 'auto',
      headless: true,
      carry: 'warm',
      supervise: true,
    } as const;
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);

    expect(tool.args.safeParse({ fleet: 'byoc', target: 50, harness: 'papercusp' }).success).toBe(true);
    expect(tool.args.safeParse({ fleet: 'byoc', target: 50 }).success).toBe(false);

    const result = await tool.handler(planlessArgs as never, {} as never);

    expect(parse(result)).toMatchObject({
      ok: true,
      target: 50,
      config: {
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-6-luna',
        effort: 'max',
        account: 'auto',
        headless: true,
        carry: 'warm',
        supervise: true,
      },
    });
    expect(parse(result).config).not.toHaveProperty('plan');
    expect(mocks.resolveHarnessPlansDir).toHaveBeenCalledWith('papercusp', { workspaceId: 'ws-test' });
    expect(mocks.readPlanBySlug).not.toHaveBeenCalled();
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 50,
      config: expect.objectContaining({ harness: 'papercusp', agent: 'codex', account: 'auto' }),
    });
  });

  it('preserves and revalidates an existing plan when an update omits plan', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp' } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({ ok: true, config: savedProfile.config });
    expect(mocks.readPlanBySlug).toHaveBeenCalledWith('byoc-plan', {
      harnessSlug: 'papercusp',
      workspaceId: 'ws-test',
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: savedProfile.config,
    });
  });

  it('disables the governor without deleting or even rereading the saved profile', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: null, harness: 'papercusp', plan: 'byoc-plan', replaceExisting: false } as never,
      {} as never,
    );
    expect(parse(result)).toMatchObject({ ok: true, disabled: true, launchProfilePreserved: true });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test', fleetSlug: 'byoc', target: null,
    });
    expect(mocks.getFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('refuses target:null recipe fields instead of silently dropping them', async () => {
    const result = await tool.handler(
      {
        fleet: 'byoc',
        target: null,
        harness: 'papercusp',
        plan: 'byoc-plan',
        agent: 'claude',
        model: 'fable[1m]',
        effort: 'high',
        account: 'default',
        replaceExisting: true,
        reason: 'repair the saved launch profile while disabled',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: false,
      error: 'invalid_args',
      offending: ['agent', 'model', 'effort', 'account', 'replaceExisting', 'reason'],
    });
    expect(parse(result).message).toContain('would be ignored');
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
    expect(mocks.getFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('preserves every omitted boot-baked setting when the target is re-enabled', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      launchProfile: { existed: true, replaced: false },
      config: savedProfile.config,
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test', fleetSlug: 'byoc', target: 4, config: savedProfile.config,
    });
  });

  it('does not persist the legacy fleet membership label as a psu persona', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce({
      ...savedProfile,
      config: { ...savedProfile.config, role: 'member' },
    });

    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    const payload = parse(result);

    expect(payload.config).not.toHaveProperty('role');
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: savedProfile.config,
    });
  });

  it('fails closed on a silent boot-setting change and allows only an explicitly reasoned replacement', async () => {
    const refused = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan', headless: false } as never,
      {} as never,
    );
    expect(parse(refused)).toMatchObject({
      ok: false,
      error: 'saved_launch_spec_conflict',
      conflicts: [expect.objectContaining({ field: 'headless', saved: true, requested: false })],
    });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();

    const replaced = await tool.handler(
      {
        fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan',
        headless: false, replaceExisting: true, reason: 'move fleet to visible terminals',
      } as never,
      {} as never,
    );
    expect(parse(replaced)).toMatchObject({
      ok: true,
      config: { ...savedProfile.config, headless: false },
      launchProfile: {
        existed: true,
        replaced: true,
        conflicts: [expect.objectContaining({ field: 'headless' })],
        reason: 'move fleet to visible terminals',
      },
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: { ...savedProfile.config, headless: false },
    });
  });

  it('persists the productive-capacity floor on the existing canonical recipe', async () => {
    const result = await tool.handler(
      {
        fleet: 'byoc', target: 4, productiveCapacityFloor: 2,
        harness: 'papercusp', plan: 'byoc-plan',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: true,
      target: 4,
      config: { ...savedProfile.config, productiveCapacityFloor: 2 },
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: { ...savedProfile.config, productiveCapacityFloor: 2 },
    });
  });

  it('refuses prose launchContext before persisting a recipe that respawn would consume as a path', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);
    const result = await tool.handler(
      {
        fleet: 'byoc',
        target: 4,
        harness: 'papercusp',
        plan: 'byoc-plan',
        launchContext: 'Read the assigned work item and complete it with evidence.',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: false,
      error: 'invalid_launch_context',
      launchContext: 'Read the assigned work item and complete it with evidence.',
    });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('also refuses an inherited invalid launchContext instead of perpetuating a broken profile', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce({
      ...savedProfile,
      config: {
        ...savedProfile.config,
        launchContext: 'resume the assigned task from the previous member',
      },
    });

    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({ ok: false, error: 'invalid_launch_context' });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('accepts and trims a readable launchContext path before persisting it', async () => {
    const contextDir = mkdtempSync(join(tmpdir(), 'papercusp-headcount-context-'));
    const contextPath = join(contextDir, 'brief.md');
    writeFileSync(contextPath, '# Fleet brief\n', 'utf8');
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);

    try {
      const result = await tool.handler(
        {
          fleet: 'byoc',
          target: 1,
          harness: 'papercusp',
          plan: 'byoc-plan',
          launchContext: ` ${contextPath} `,
        } as never,
        {} as never,
      );

      expect(parse(result)).toMatchObject({ ok: true, config: { launchContext: contextPath } });
      expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
        workspaceId: 'ws-test',
        fleetSlug: 'byoc',
        target: 1,
        config: expect.objectContaining({ launchContext: contextPath }),
      });
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  // R5 (interrupted-member-recovery-hardening-2026-09-01): the supervise grant is a
  // governance knob, not a boot setting — it never trips the saved-spec conflict gate
  // (no replaceExisting needed), omission preserves the stored value, and false revokes.
  it('grants, preserves, and revokes the supervise flag without replaceExisting', async () => {
    const granted = await tool.handler(
      { fleet: 'byoc', target: 1, supervise: true, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(granted)).toMatchObject({ ok: true, config: { ...savedProfile.config, supervise: true } });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenLastCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 1,
      config: { ...savedProfile.config, supervise: true },
    });

    mocks.getFleetHeadcountTarget.mockResolvedValue({
      ...savedProfile,
      config: { ...savedProfile.config, supervise: true },
    });
    const preserved = await tool.handler(
      { fleet: 'byoc', target: 2, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(preserved)).toMatchObject({ ok: true, target: 2, config: { ...savedProfile.config, supervise: true } });

    const revoked = await tool.handler(
      { fleet: 'byoc', target: 2, supervise: false, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(revoked)).toMatchObject({ ok: true, config: { ...savedProfile.config, supervise: false } });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: { ...savedProfile.config, supervise: false } }),
    );
  });
});
