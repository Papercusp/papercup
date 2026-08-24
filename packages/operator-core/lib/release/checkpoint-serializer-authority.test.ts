import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import {
  armPausedCheckpointTransition,
  CHECKPOINT_SERIALIZER_TRANSITION_METADATA_KEY,
} from './checkpoint-serializer-authority';

type QueryResult = Record<string, unknown>[];

function transactionHarness(opts: {
  active?: boolean;
  metadata?: Record<string, unknown>;
  gateOwner?: string | null;
  prerequisiteStatus?: string;
}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('SELECT active, metadata')) {
      return [{
        active: opts.active ?? false,
        metadata: opts.metadata ?? {
          pause: { reason: 'repair in flight', pausedBy: 'su-owner', pausedAtMs: 1 },
        },
      }];
    }
    if (text.includes('SELECT feature_id, taken_by, status')) {
      return [
        { feature_id: 'WI-40086', taken_by: opts.gateOwner ?? 'su-owner', status: 'open' },
        { feature_id: 'WI-41117', taken_by: 'su-owner', status: opts.prerequisiteStatus ?? 'done' },
      ];
    }
    if (text.includes('UPDATE harness_shared.routines')) return [{ active: true }];
    throw new Error(`unexpected query: ${text}`);
  }) as never;
  h.boundedOrgTxn.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { statements };
}

beforeEach(() => h.boundedOrgTxn.mockReset());

describe('armPausedCheckpointTransition', () => {
  it('locks prerequisites and atomically makes the existing routine due exactly once', async () => {
    const { statements } = transactionHarness({});
    const result = await armPausedCheckpointTransition({
      callerOwnerId: 'su-owner',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      nowMs: 1234,
    });

    expect(result).toEqual({
      status: 'armed',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      armedAtMs: 1234,
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'));
    expect(update?.text).toContain('active = true');
    expect(update?.text).toContain('next_fire_at = now()');
    const metadata = JSON.parse(String(update?.values.find((value) => typeof value === 'string' && value.includes('lastPause'))));
    expect(metadata.pause).toBeUndefined();
    expect(metadata.lastPause).toMatchObject({ reason: 'repair in flight', resumedBy: 'su-owner', resumedAtMs: 1234 });
    expect(metadata[CHECKPOINT_SERIALIZER_TRANSITION_METADATA_KEY]).toEqual({
      callerOwnerId: 'su-owner',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      armedAtMs: 1234,
    });
  });

  it('refuses while any named prerequisite is non-terminal and never arms the routine', async () => {
    const { statements } = transactionHarness({ prerequisiteStatus: 'open' });
    const result = await armPausedCheckpointTransition({
      callerOwnerId: 'su-owner',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      nowMs: 1234,
    });

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'prerequisite-not-terminal',
    });
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('is idempotent after the same transition has already armed the routine', async () => {
    const transition = {
      callerOwnerId: 'su-owner',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      armedAtMs: 999,
    };
    const { statements } = transactionHarness({
      active: true,
      metadata: { [CHECKPOINT_SERIALIZER_TRANSITION_METADATA_KEY]: transition },
    });
    const result = await armPausedCheckpointTransition({
      callerOwnerId: 'su-owner',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      nowMs: 1234,
    });

    expect(result).toEqual({
      status: 'already-armed',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      armedAtMs: 999,
    });
    expect(statements).toHaveLength(1);
  });
});
