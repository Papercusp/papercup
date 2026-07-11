/**
 * H5a seam-invariant tests (coord-authority-hardening-2026-07-11 P-002):
 * audience⊆authority enforced INSIDE sendMessage — the one persist seam every
 * message writer passes — not only in tools/send.ts.
 *
 * The regression this pins: EI-9501 (2026-07-11) — a fleet leader shipped a
 * hive-wide `to:['*']` message whose own cueAuthority stamp said
 * fleet-members(p2p-blocker-crack-sonnet5). The landed tools/send guard only
 * covers coord:send's allHive path; these tests prove the seam refuses the
 * SAME contradiction arriving via ANY caller (emit, dispatch, system emitters,
 * a future verb calling sendMessage directly).
 *
 * In-memory CoordEventLog double (same harness as messages.test.ts) — no PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

vi.mock('../audience-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audience-host')>();
  return {
    ...actual,
    hostAudienceResolvers: {
      listTargetSubscribers: async () => [],
      listActivePresence: async () => [],
      listTaggedTopics: async () => [],
      listFleetMembers: async () => [],
      listFleetLeader: async () => [],
    },
    audienceMode: () => 'scoped' as const,
  };
});

vi.mock('../federation-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../federation-scope')>();
  return {
    ...actual,
    resolveWorkspaceHiveScope: async () => ({ kind: 'none' }),
  };
});

// Hermetic recipient resolution: the real resolveBestEffortAgainstRoster reads
// the LIVE presence roster (a concrete id prefix can match a real live agent on
// the dev box and get expanded, breaking equality asserts). Pass-through here —
// recipient resolution has its own suite.
vi.mock('../recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (ids: string[]) => ids,
}));

// Controllable sender-authority resolver — the seam consults it ONLY when the
// caller did not pass `cueAuthorityResolved` (the emit/dispatch/system path).
const resolvedStamp = vi.hoisted(() => ({
  value: null as import('../cue-authority').CueAuthorityStamp | null,
  calls: 0,
  throws: false,
}));
vi.mock('../cue-authority-resolve', () => ({
  resolveSenderCueAuthority: async () => {
    resolvedStamp.calls++;
    if (resolvedStamp.throws) throw new Error('presence outage');
    return resolvedStamp.value;
  },
}));

import { configureCoordLog, resetCoordLog } from '../log';
import { FleetScopedBroadcastRefusedError, sendMessage } from '../messages';
import { CUE_AUTHORITY_FIELD, type CueAuthorityStamp } from '../cue-authority';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'test' as never, workspaceId: null, userId: null };
}

const FLEET_STAMP: CueAuthorityStamp = {
  authority: 'fleet-leader',
  authorityRef: 'p2p-blocker-crack-sonnet5',
  scope: 'fleet-members',
  scopeRef: 'p2p-blocker-crack-sonnet5',
};
const QUEEN_STAMP: CueAuthorityStamp = {
  authority: 'hive-queen',
  authorityRef: 'papercusp',
  scope: 'hive-wide',
};

describe('H5a: sendMessage audience⊆authority invariant', () => {
  beforeEach(() => {
    configureCoordLog(new InMemoryCoordLog());
    resolvedStamp.value = null;
    resolvedStamp.calls = 0;
  });
  afterEach(() => {
    resetCoordLog();
  });

  it('EI-9501 reconstruction: refuses a fleet-scoped hive-wide message (pre-resolved stamp)', async () => {
    await expect(
      sendMessage(fakeIdentity('su-07320b7c'), {
        to: ['*'],
        summary: 'OWNER DIRECTIVE: pause all work',
        cueAuthorityResolved: FLEET_STAMP,
      }),
    ).rejects.toMatchObject({
      name: 'FleetScopedBroadcastRefusedError',
      code: 'fleet_scoped_cue_allhive_contradiction',
    });
  });

  it('refuses the same contradiction arriving via a caller that never resolved a stamp (emit/dispatch path)', async () => {
    resolvedStamp.value = FLEET_STAMP;
    await expect(
      sendMessage(fakeIdentity('su-07320b7c'), { to: ['*'], summary: 'drain now' }),
    ).rejects.toBeInstanceOf(FleetScopedBroadcastRefusedError);
    expect(resolvedStamp.calls).toBe(1);
  });

  it('refuses a PRE-STAMPED fleet-scoped contradiction supplied via extra', async () => {
    await expect(
      sendMessage(fakeIdentity('su-07320b7c'), {
        to: ['*'],
        summary: 'relay',
        extra: { [CUE_AUTHORITY_FIELD]: FLEET_STAMP },
      }),
    ).rejects.toBeInstanceOf(FleetScopedBroadcastRefusedError);
    expect(resolvedStamp.calls).toBe(0); // pre-stamped: no re-resolution
  });

  it('lifecycle kinds are exempt: a fleet leader still broadcasts plan_event to *', async () => {
    resolvedStamp.value = FLEET_STAMP;
    const env = await sendMessage(fakeIdentity('su-07320b7c'), {
      to: ['*'],
      kind: 'plan_event',
      summary: 'P-001 done',
    });
    expect(env.to).toEqual(['*']);
    expect(resolvedStamp.calls).toBe(0); // kind gate first — resolver never consulted
  });

  it('hive-wide authority may broadcast, and the seam stamps the envelope for the receive side (H1 input)', async () => {
    resolvedStamp.value = QUEEN_STAMP;
    const env = await sendMessage(fakeIdentity('mug-1'), { to: ['*'], summary: 'hive pause' });
    expect(env.to).toEqual(['*']);
    expect((env as Record<string, unknown>)[CUE_AUTHORITY_FIELD]).toEqual(QUEEN_STAMP);
  });

  it('an unstamped ordinary sender still broadcasts * (informational), unstamped', async () => {
    resolvedStamp.value = null;
    const env = await sendMessage(fakeIdentity('su-ordinary'), { to: ['*'], summary: 'FYI' });
    expect(env.to).toEqual(['*']);
    expect(CUE_AUTHORITY_FIELD in env).toBe(false);
  });

  it('directed sends from a fleet leader pass untouched (authority constrains broadcasts, not conversation)', async () => {
    resolvedStamp.value = FLEET_STAMP;
    const env = await sendMessage(fakeIdentity('su-07320b7c'), {
      to: ['su-4c85f9d7'],
      summary: 'leader to peer',
    });
    expect(env.to).toEqual(['su-4c85f9d7']);
    expect(resolvedStamp.calls).toBe(0); // no wildcard — invariant never engages
  });

  it('presence-outage fail-soft: a throwing resolver never blocks the send (degrades to unstamped)', async () => {
    resolvedStamp.throws = true;
    try {
      const env = await sendMessage(fakeIdentity('su-any'), { to: ['*'], summary: 'ok' });
      expect(env.to).toEqual(['*']);
      expect(CUE_AUTHORITY_FIELD in env).toBe(false);
      expect(resolvedStamp.calls).toBe(1);
    } finally {
      resolvedStamp.throws = false;
    }
  });
});
