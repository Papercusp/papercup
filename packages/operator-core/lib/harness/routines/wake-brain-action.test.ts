import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { POT_AGENT_TABS: 'papercusp-hive-agent-tabs' } }));
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
  // EI-908: resolveBrainOwner resolves the pinned session to its coord owner and
  // does NOT gate on a heartbeat (the wake-executor is the liveness authority).
  // A tracked pin yields the owner regardless of liveness.
  sql = vi.fn(async () => [{ coord_owner_id: 'owner-x' }]);
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(getFlag).mockResolvedValue(true as never);
  vi.mocked(getBrainSession).mockResolvedValue('brain-uuid' as never);
});
afterEach(() => vi.clearAllMocks());

describe('system:wake-brain (hive-agent-tabs P-005 / D-006)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('wake-brain')).toBeTypeOf('function');
  });

  it('is a no-op tombstone now that psu --brain is retired', async () => {
    await run();
    expect(getFlag).not.toHaveBeenCalled();
    expect(getBrainSession).not.toHaveBeenCalled();
    expect(getOrgPg).not.toHaveBeenCalled();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });
});
