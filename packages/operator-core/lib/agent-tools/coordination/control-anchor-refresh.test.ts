import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  boundedOrgTxn: vi.fn(),
  getModes: vi.fn(),
  getLoopStatus: vi.fn(),
  latestFleetMembership: vi.fn(),
  getSessionBrief: vi.fn(),
  fetchSelfWake: vi.fn(),
  readGoalHolderAuthority: vi.fn(),
  projectGoalHolderAuthority: vi.fn(),
  stackRefsForSession: vi.fn(),
}));

vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
vi.mock('../../modes/store', () => ({ getModes: h.getModes }));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: h.getLoopStatus }));
vi.mock('../../fleet-membership-store', () => ({ latestFleetMembership: h.latestFleetMembership }));
vi.mock('../../session-brief', () => ({ getSessionBrief: h.getSessionBrief }));
vi.mock('./presence-selfwake', () => ({ fetchSelfWake: h.fetchSelfWake }));
vi.mock('../../goals/holder-authority', () => ({
  readGoalHolderAuthority: h.readGoalHolderAuthority,
  projectGoalHolderAuthority: h.projectGoalHolderAuthority,
}));
vi.mock('../../stack-binding-channel', () => ({ stackRefsForSession: h.stackRefsForSession }));

import { refreshControlAnchorAfterMutation } from './control-anchor';

const input = {
  ownerId: 'owner-1',
  workspaceId: 'workspace-1',
  origin: 'agent' as const,
  actorId: 'actor-1',
  source: 'loop:arm' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getModes.mockResolvedValue([]);
  h.getLoopStatus.mockResolvedValue(null);
  h.latestFleetMembership.mockResolvedValue(null);
  h.getSessionBrief.mockResolvedValue(null);
  h.fetchSelfWake.mockResolvedValue(new Map());
  h.readGoalHolderAuthority.mockResolvedValue({
    status: 'none',
    goalId: null,
    electedOwnerId: null,
    electedEpoch: null,
    handoffExpiresAt: null,
  });
  h.projectGoalHolderAuthority.mockReturnValue(undefined);
  h.stackRefsForSession.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshControlAnchorAfterMutation', () => {
  it('fails soft within a bounded refresh budget when the transaction never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.boundedOrgTxn.mockImplementation(() => new Promise(() => undefined));

    const result = refreshControlAnchorAfterMutation(input);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('control-anchor:refresh exceeded 20000ms'));
    warn.mockRestore();
    expect(h.boundedOrgTxn).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        statementTimeoutMs: 8_000,
        lockTimeoutMs: 4_000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reuses an existing transaction instead of opening a nested unbounded one', async () => {
    const state = {
      modes: [],
      loop: { active: false, intervalSec: null },
      carry: 'warm' as const,
      route: { kind: 'self' as const },
      scope: { workspace: input.workspaceId, harness: null, plan: null, items: [] },
    };
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('INSERT INTO harness_shared.session_briefs')) {
        return [{
          control_generation: 1,
          control_state: state,
          control_updated_at: new Date('2026-09-13T00:00:00.000Z'),
          control_transition: null,
        }];
      }
      return [];
    }) as unknown as Sql;

    const result = await refreshControlAnchorAfterMutation({ ...input, sql: tx });

    expect(result).toMatchObject({ generation: 1 });
    expect(h.boundedOrgTxn).not.toHaveBeenCalled();
    expect(h.getSessionBrief).toHaveBeenCalledWith({ ownerId: input.ownerId }, tx);
    expect(h.fetchSelfWake).toHaveBeenCalledWith([input.ownerId], tx);
  });

  // P-009 (EI-23431478594488191). This binds the SEAM, not the predicate: a
  // correct carry helper that nothing calls leaves the denial exactly in place.
  describe('control-source identity receipt', () => {
    // `assertRevision` requires a lowercase sha256 specificationRevision, so a
    // readable placeholder here is rejected before the seam is ever reached.
    const SPEC = 'a'.repeat(64);
    const OTHER_SPEC = 'b'.repeat(64);
    const APPLIED = { specificationRevision: SPEC, stateRevision: 'state-1' };

    function launchRecord(overrides: Record<string, unknown> = {}) {
      return {
        v: 1,
        agent: 'su-1',
        workspaceId: input.workspaceId,
        harnessSlug: 'papercusp',
        profile: 'engineer',
        contextSize: 'trimmed',
        personaTier: 'full',
        model: null,
        planSlug: null,
        launchedBy: null,
        autoMode: true,
        drainMode: false,
        loopArmed: true,
        fleet: null,
        stack: ['autonomy:su.mode-auto'],
        ...APPLIED,
        specificationArtifact: { specificationRevision: SPEC },
        ...overrides,
      };
    }

    /** Drives one refresh and returns every statement the transaction issued. */
    // `input.source` narrows to the literal 'loop:arm', so name the union these
    // cases actually span: one identity-moving source and one that is not.
    async function refresh(opts: { source: 'mode:set' | 'loop:arm'; launchSpec: unknown }) {
      const statements: Array<{ text: string; values: unknown[] }> = [];
      const activation = {
        schemaVersion: 1,
        attribution: { actorId: input.ownerId, principalId: input.ownerId, sessionId: input.ownerId },
        desired: APPLIED,
        prepared: null,
        applied: APPLIED,
        status: 'applied',
      };
      h.getSessionBrief.mockResolvedValue({ controlState: { activation } });
      const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join(' ');
        statements.push({ text, values });
        if (text.includes('INSERT INTO harness_shared.session_briefs')) {
          return [{
            control_generation: 2,
            control_state: {
              modes: [],
              activation: { ...activation, desired: { ...APPLIED, stateRevision: 'state-2' }, status: 'desired' },
              loop: { active: false, intervalSec: null },
              carry: 'warm' as const,
              route: { kind: 'self' as const },
              scope: { workspace: input.workspaceId, harness: null, plan: null, items: [] },
            },
            control_updated_at: new Date('2026-09-16T00:00:00.000Z'),
            control_transition: null,
          }];
        }
        if (text.includes('FROM harness_shared.adv_sessions')) {
          return [{ id: 7, launch_spec: opts.launchSpec }];
        }
        if (text.includes('UPDATE harness_shared.adv_sessions')) return [{ id: 7 }];
        return [{ id: 1 }];
      }) as unknown as Sql;

      await refreshControlAnchorAfterMutation({ ...input, source: opts.source, sql: tx });
      return statements;
    }

    const launchSpecUpdate = (statements: Array<{ text: string; values: unknown[] }>) =>
      statements.find((statement) => statement.text.includes('UPDATE harness_shared.adv_sessions')
        && statement.text.includes('SET launch_spec'));

    it('writes a launch receipt for the state revision a mode:set activation advances to', async () => {
      const statements = await refresh({ source: 'mode:set', launchSpec: launchRecord() });

      const update = launchSpecUpdate(statements);
      expect(update).toBeDefined();
      const written = JSON.parse(update?.values.find((v) => typeof v === 'string'
        && v.includes('identityHistory')) as string);
      expect(written.identityHistory[0]).toMatchObject({
        specificationRevision: SPEC,
        stateRevision: 'state-2',
        specificationArtifact: { specificationRevision: SPEC },
      });
      // The launch pointer is a receipt too; carrying one must not overwrite it.
      expect(written).toMatchObject(APPLIED);
    });

    it('writes nothing for a non-identity mutation', async () => {
      const statements = await refresh({ source: 'loop:arm', launchSpec: launchRecord() });
      expect(launchSpecUpdate(statements)).toBeUndefined();
    });

    it('writes nothing when the session carries no launch record', async () => {
      const statements = await refresh({ source: 'mode:set', launchSpec: null });
      expect(launchSpecUpdate(statements)).toBeUndefined();
    });

    it('refuses to carry an artifact the activation specification does not match', async () => {
      const statements = await refresh({
        source: 'mode:set',
        launchSpec: launchRecord({ specificationRevision: OTHER_SPEC }),
      });
      expect(launchSpecUpdate(statements)).toBeUndefined();
    });
  });
});
