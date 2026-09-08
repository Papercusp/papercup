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

import tool from './headcount-target';

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
  it('disables the governor without deleting or even rereading the saved profile', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: null, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(result)).toMatchObject({ ok: true, disabled: true, launchProfilePreserved: true });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test', fleetSlug: 'byoc', target: null,
    });
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
