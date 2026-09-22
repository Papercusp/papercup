/**
 * psu-pty-turn-boundary-generalization-2026-09-22, P-008 -> P-010.
 *
 * The properties that make this durable record worth having rather than another alarm:
 * it must not mint a duplicate per sweep, it must not spam one item every 20 minutes, it
 * must still speak up when the picture genuinely changes, and it must never take the
 * detector down with it.
 */
import { describe, expect, it } from 'vitest';
import type { EngineerIssue } from '../../issues-engineer';
import type { WedgeIssueDeps } from './pty-host-wedge-issue';
import { recordWedgeEpisode, wedgeDigest, wedgeIssueMarker } from './pty-host-wedge-issue';

function issue(over: Partial<EngineerIssue> = {}): EngineerIssue {
  return {
    id: 'EI-1',
    state: 'open',
    body: wedgeIssueMarker('composer'),
    payload: null,
    title: 't',
    ...over,
  } as EngineerIssue;
}

function deps(over: Partial<WedgeIssueDeps> = {}) {
  const calls = {
    created: [] as unknown[],
    commented: [] as Array<{ id: string; body: string }>,
    merged: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  };
  const base: WedgeIssueDeps = {
    listIssues: async () => [],
    createIssue: async (input) => {
      calls.created.push(input);
      return issue({ id: 'EI-NEW', body: input.body });
    },
    commentIssue: async (id, body) => {
      calls.commented.push({ id, body });
      return null;
    },
    mergeIssuePayload: async (id, patch) => {
      calls.merged.push({ id, patch });
      return null;
    },
    ...over,
  };
  return { deps: base, calls };
}

const input = {
  wedgeClass: 'composer',
  ownerIds: ['su-a', 'su-b'],
  detail: ['- su-a: stuck', '- su-b: stuck'],
  nowIso: '2026-09-22T08:00:00.000Z',
};

describe('recordWedgeEpisode', () => {
  it('creates the item when no live one carries the marker', async () => {
    const { deps: d, calls } = deps();
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('created');
    expect(calls.created).toHaveLength(1);
    // The digest must be stored at creation, or the very next sweep re-comments on an
    // item it just made — the throttle would be dead on arrival.
    expect(calls.merged[0]?.patch).toMatchObject({
      ptyHostWedge: { digest: wedgeDigest(input.ownerIds) },
    });
  });

  it('does NOT re-file when a live item already carries the marker', async () => {
    // The duplicate-per-sweep failure: at 20-minute cadence this would be ~72 rows/day.
    const { deps: d, calls } = deps({ listIssues: async () => [issue()] });
    const r = await recordWedgeEpisode(input, d);
    expect(calls.created).toHaveLength(0);
    expect(r.action).not.toBe('created');
  });

  it('stays SILENT while the owner set is unchanged (the throttle)', async () => {
    const { deps: d, calls } = deps({
      listIssues: async () => [
        issue({ payload: { ptyHostWedge: { digest: wedgeDigest(input.ownerIds) } } }),
      ],
    });
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('unchanged');
    expect(r.reason).toBe('same-owner-set');
    expect(calls.commented).toHaveLength(0);
  });

  it('COMMENTS when the owner set changes — the throttle must not silence real news', async () => {
    // The calibration case for the test above: if the throttle silenced everything, the
    // "stays silent" test would still pass while the record went stale forever.
    const { deps: d, calls } = deps({
      listIssues: async () => [issue({ payload: { ptyHostWedge: { digest: 'su-zzz' } } })],
    });
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('commented');
    expect(calls.commented).toHaveLength(1);
    expect(calls.commented[0]?.body).toContain('su-a');
  });

  it('ignores TERMINAL items and opens a fresh one for a new episode', async () => {
    // A closed item is a historical record. Re-opening the conversation on it would hide a
    // new outage inside a row already marked resolved.
    const { deps: d, calls } = deps({
      listIssues: async () => [issue({ state: 'done' }), issue({ state: 'closed' })],
    });
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('created');
    expect(calls.created).toHaveLength(1);
  });

  it('ignores a loose `q` hit whose body does not actually carry the marker', async () => {
    // `q` is a substring match over title+body; trusting a loose hit would let an unrelated
    // item silently absorb every wedge episode.
    const { deps: d, calls } = deps({
      listIssues: async () => [issue({ body: 'mentions pty host wedges in passing' })],
    });
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('created');
    expect(calls.created).toHaveLength(1);
  });

  it('is fail-soft: a store failure is reported, never thrown at the detector', async () => {
    const { deps: d } = deps({
      listIssues: async () => {
        throw new Error('pg down');
      },
    });
    const r = await recordWedgeEpisode(input, d);
    expect(r.action).toBe('failed');
    expect(r.reason).toContain('pg down');
  });

  it('does nothing when there are no wedged hosts', async () => {
    const { deps: d, calls } = deps();
    const r = await recordWedgeEpisode({ ...input, ownerIds: [] }, d);
    expect(r.action).toBe('unchanged');
    expect(calls.created).toHaveLength(0);
  });

  it('keys the digest by SET, not by order or duplication', async () => {
    expect(wedgeDigest(['b', 'a'])).toBe(wedgeDigest(['a', 'b']));
    expect(wedgeDigest(['a', 'a', 'b'])).toBe(wedgeDigest(['a', 'b']));
    // ...but a genuinely different population must differ, or the throttle silences news.
    expect(wedgeDigest(['a', 'b'])).not.toBe(wedgeDigest(['a', 'c']));
  });

  it('renders an UNMEASURED delivery rate in words rather than a percentage', async () => {
    const { deps: d, calls } = deps();
    await recordWedgeEpisode(
      {
        ...input,
        health: {
          measured: false,
          reason: 'no-rows-in-window',
          windowHours: 6,
          delivered: 0,
          lost: 0,
          recovered: 0,
          ratePct: null,
          byKind: {},
        },
      },
      d,
    );
    const body = String((calls.created[0] as { body: string }).body);
    expect(body).toContain('NOT MEASURED');
    expect(body).not.toMatch(/\d%/);
  });
});
