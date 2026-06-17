import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { HIVE_AGENT_TABS: 'papercusp-hive-agent-tabs' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('../../brain-pin', () => ({ getBrainSession: vi.fn() }));
vi.mock('../../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: vi.fn() }));

// Importing the module registers the `wake-brain` system action.
import './wake-brain-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import { getBrainSession } from '../../brain-pin';
import { getOrgPg } from '@papercusp/db-org';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('wake-brain')!(ctx(over) as never);

let sql: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // EI-908: resolveBrainOwner now gates on a fresh coord_presence heartbeat — a
  // genuinely-live brain reports a recent one, so model that for the live-wake path.
  sql = vi.fn(async () => [{ coord_owner_id: 'owner-x', heartbeat_at: new Date() }]);
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(getFlag).mockResolvedValue(true as never);
  vi.mocked(getBrainSession).mockResolvedValue('brain-uuid' as never);
});
afterEach(() => vi.clearAllMocks());

describe('system:wake-brain (hive-agent-tabs P-005 / D-006)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('wake-brain')).toBeTypeOf('function');
  });

  it('flag OFF → no wake (the brain stays a responsive engineer session)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    await run();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('flag ON + pinned + currently-tracked brain → wakes its coord owner via the shipped wake machinery', async () => {
    await run();
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    const [recipients, opts] = vi.mocked(wakeRecipients).mock.calls[0] as [string[], Record<string, unknown>];
    expect(recipients).toEqual(['owner-x']);
    expect(opts).toMatchObject({ source: 'system:wake-brain', workspaceId: 'ws-1' });
  });

  it('flag ON + no brain pinned → no wake', async () => {
    vi.mocked(getBrainSession).mockResolvedValue(null as never);
    await run();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('flag ON + pinned but not currently tracked (no adv_sessions row) → no wake', async () => {
    sql = vi.fn(async () => []);
    vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
    await run();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('uses payloadTemplate.kickoff as the wake summary when provided', async () => {
    await run({ payloadTemplate: { kickoff: 'custom tick' } });
    const [, opts] = vi.mocked(wakeRecipients).mock.calls[0] as [string[], Record<string, unknown>];
    expect(opts.summary).toBe('custom tick');
  });
});
