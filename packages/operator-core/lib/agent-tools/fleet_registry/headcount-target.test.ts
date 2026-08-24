import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFleet: vi.fn(),
  getFleetHeadcountTarget: vi.fn(),
  setFleetHeadcountTarget: vi.fn(),
  resolveHarnessPlansDir: vi.fn(),
  readPlanBySlug: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
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
});
