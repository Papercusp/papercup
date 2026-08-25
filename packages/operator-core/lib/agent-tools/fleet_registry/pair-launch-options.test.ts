/**
 * The type-CONDITIONAL launch option contract (D-008 / D-009 / D-012, P-011).
 *
 * What these cases exist to prevent, stated once: the schema BRANCHES on the
 * fleet type and must never quietly merge into one superset. The expensive
 * failure is not a rejected call — it is an ACCEPTED one that coerced a flat
 * knob onto both roles, because nothing in the result says it happened and the
 * bill arrives later.
 */
import { describe, expect, it } from 'vitest';
import {
  describeLaunchRoles,
  expandPairedMembers,
  PAIR_ROLE_DIRECTOR,
  PAIR_ROLE_IMPLEMENTER,
  pairIndexOfSeat,
  pairSeatRole,
  PER_ROLE_KNOBS,
  resolveLaunchOptions,
  wholePairSeats,
  type ResolvedPairedLaunch,
  type ResolvedSingleLaunch,
} from './pair-launch-options';

/** A resolved paired launch with deliberately DIFFERENT knobs per role. */
function pairedFixture(): ResolvedPairedLaunch {
  const resolved = resolveLaunchOptions({
    type: 'paired',
    count: 2,
    directors: { model: 'opus', effort: 'high', headless: false },
    implementers: { model: 'sonnet', account: 'auto', headless: true, carry: 'cold' },
  });
  if (!resolved.ok || resolved.type !== 'paired') throw new Error('fixture is not a paired launch');
  return resolved;
}

describe('resolveLaunchOptions — the single arm stays exactly as it was', () => {
  it('treats an omitted type as single, so no existing caller learns the field exists', () => {
    const r = resolveLaunchOptions({ model: 'sonnet', count: 3, headless: true });
    expect(r).toMatchObject({ ok: true, type: 'single' });
    expect((r as ResolvedSingleLaunch).flat).toEqual({ model: 'sonnet', headless: true });
  });

  it('passes the flat knobs through untouched', () => {
    const flat = {
      agent: 'claude' as const,
      model: 'opus',
      effort: 'high',
      headless: false,
      account: 'auto',
      carry: 'cold' as const,
    };
    const r = resolveLaunchOptions({ type: 'single', ...flat });
    expect((r as ResolvedSingleLaunch).flat).toEqual(flat);
  });

  it('reports no pair count for a single fleet', () => {
    const r = resolveLaunchOptions({ type: 'single', count: 4 });
    expect((r as ResolvedSingleLaunch).pairs).toBeNull();
  });

  it('REJECTS per-role groups on a single fleet rather than ignoring them', () => {
    const r = resolveLaunchOptions({ type: 'single', directors: { model: 'opus' } });
    expect(r).toMatchObject({
      ok: false,
      error: 'invalid_args',
      reason: 'per_role_groups_on_single_fleet',
      offending: ['directors'],
    });
  });

  it('names the default explicitly when the caller never passed a type at all', () => {
    // The confusing case: the caller wrote directors:{…}, so they clearly MEANT
    // a paired fleet — the message has to say why they did not get one.
    const r = resolveLaunchOptions({ implementers: { model: 'haiku' } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('you did not pass `type`');
    expect(r.message).toContain("type:'paired'");
  });
});

describe('resolveLaunchOptions — the paired arm', () => {
  it('accepts independent per-role configuration (the D-006 shape)', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      count: 3,
      directors: { model: 'opus', effort: 'high', headless: false },
      implementers: { model: 'sonnet', headless: true, account: 'auto' },
    });
    expect(r.ok).toBe(true);
    const p = r as ResolvedPairedLaunch;
    expect(p.type).toBe('paired');
    expect(p.pairs).toBe(3);
    expect(p.directors).toEqual({ model: 'opus', effort: 'high', headless: false });
    expect(p.implementers).toEqual({ model: 'sonnet', headless: true, account: 'auto' });
  });

  it('keeps the roles separate — a director knob never leaks onto the implementers', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      directors: { model: 'opus', account: 'pinned-pool' },
      implementers: { model: 'haiku' },
    }) as ResolvedPairedLaunch;
    expect(r.implementers.account).toBeUndefined();
    expect(r.implementers.model).toBe('haiku');
    expect(r.directors.model).toBe('opus');
  });

  it('REJECTS every flat per-role knob rather than broadcasting it to both roles', () => {
    // One case per knob: a coercion bug typically escapes on the knob nobody
    // wrote a case for.
    for (const knob of PER_ROLE_KNOBS) {
      const r = resolveLaunchOptions({
        type: 'paired',
        directors: { model: 'opus' },
        [knob]: knob === 'headless' ? true : knob === 'carry' ? 'warm' : 'x',
      });
      expect(r.ok, `flat ${knob} must be refused on a paired fleet`).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toBe('flat_knobs_on_paired_fleet');
      expect(r.offending).toContain(knob);
    }
  });

  it('lists every offending flat knob at once, not just the first', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      model: 'opus',
      carry: 'cold',
      headless: true,
      directors: { effort: 'high' },
    });
    if (r.ok) throw new Error('unreachable');
    expect(r.offending).toEqual(expect.arrayContaining(['model', 'carry', 'headless']));
  });

  it('does NOT treat top-level count as a flat knob — it is the pair count (D-012)', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      count: 2,
      directors: { model: 'opus' },
      implementers: { model: 'sonnet' },
    });
    expect(r.ok).toBe(true);
    expect((r as ResolvedPairedLaunch).pairs).toBe(2);
  });

  it('REJECTS a per-role count instead of silently ignoring it (D-012)', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      directors: { model: 'opus', count: 1 },
      implementers: { model: 'sonnet', count: 3 },
    });
    expect(r).toMatchObject({ ok: false, reason: 'count_inside_role_group' });
    if (r.ok) throw new Error('unreachable');
    // Both are named — a caller who set two counts fixed only one would other-
    // wise bounce twice.
    expect(r.offending).toEqual(['directors.count', 'implementers.count']);
    expect(r.message).toContain('1:1');
  });

  it('refuses a paired launch that configures neither role', () => {
    const r = resolveLaunchOptions({ type: 'paired', count: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'no_roles_configured' });
  });

  it('accepts an EXPLICIT both-roles-on-defaults launch', () => {
    // The deliberate form the refusal above points at.
    const r = resolveLaunchOptions({
      type: 'paired',
      count: 2,
      directors: {},
      implementers: { model: 'sonnet' },
    });
    expect(r.ok).toBe(true);
  });

  it('reports a null pair count when the caller omitted it, rather than defaulting to 1 silently', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      directors: { model: 'opus' },
    }) as ResolvedPairedLaunch;
    expect(r.pairs).toBeNull();
  });
});

describe('every refusal carries a usable repair', () => {
  const refusals = [
    resolveLaunchOptions({ type: 'single', directors: { model: 'o' } }),
    resolveLaunchOptions({ type: 'paired', model: 'o', directors: { model: 'o' } }),
    resolveLaunchOptions({ type: 'paired', directors: { model: 'o', count: 2 } }),
    resolveLaunchOptions({ type: 'paired' }),
  ];

  it('names the expected shape and the offending fields on each', () => {
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toBe('invalid_args');
      expect(r.offending.length).toBeGreaterThan(0);
      expect(r.expectedShape).toMatch(/type:'(single|paired)'/);
      // The message must be actionable on its own — an agent reading only the
      // error should know what to send next.
      expect(r.message.length).toBeGreaterThan(80);
    }
  });

  it('uses a distinct reason code per failure class', () => {
    const reasons = refusals.map((r) => (r.ok ? null : r.reason));
    expect(new Set(reasons).size).toBe(refusals.length);
  });
});

describe('describeLaunchRoles — the spawn announcement covers BOTH roles', () => {
  it('emits one line for a single fleet', () => {
    const r = resolveLaunchOptions({ model: 'sonnet' }) as ResolvedSingleLaunch;
    expect(describeLaunchRoles(r)).toHaveLength(1);
  });

  it('emits a pair summary plus one line per role, never a merged one', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      count: 3,
      directors: { model: 'opus', account: 'auto' },
      implementers: { model: 'sonnet', headless: true },
    }) as ResolvedPairedLaunch;
    const lines = describeLaunchRoles(r);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('3 pair(s)');
    expect(lines[0]).toContain('6 members total');
    expect(lines[1]).toContain('directors');
    expect(lines[1]).toContain('opus');
    expect(lines[2]).toContain('implementers');
    expect(lines[2]).toContain('sonnet');
    expect(lines[2]).toContain('headless');
    // The director's model must not appear on the implementer line.
    expect(lines[2]).not.toContain('opus');
  });

  it('spells out the defaults rather than leaving them blank', () => {
    const r = resolveLaunchOptions({
      type: 'paired',
      count: 1,
      directors: {},
      implementers: {},
    }) as ResolvedPairedLaunch;
    const [, directorLine] = describeLaunchRoles(r);
    expect(directorLine).toContain('(default)');
    expect(directorLine).toContain('default (system)');
    expect(directorLine).toContain('carry warm');
    expect(directorLine).toContain('visible');
  });
});

describe('seat ordering is interleaved so a CLAMPED wave degrades to whole pairs (D-014)', () => {
  it('puts the director on even seats and its implementer on the next one', () => {
    expect(pairSeatRole(0)).toBe('director');
    expect(pairSeatRole(1)).toBe('implementer');
    expect(pairSeatRole(2)).toBe('director');
    expect(pairSeatRole(3)).toBe('implementer');
  });

  it('derives pair identity from the seat index alone, with no side table', () => {
    expect(pairIndexOfSeat(0)).toBe(0);
    expect(pairIndexOfSeat(1)).toBe(0);
    expect(pairIndexOfSeat(2)).toBe(1);
    expect(pairIndexOfSeat(3)).toBe(1);
  });

  it('THE POINT: truncating a wave leaves whole pairs, never orphaned directors', () => {
    // This is the case blocked ordering gets wrong. Take the first 2 of 6 seats
    // — what a capacity clamp actually does — and count each role.
    const members = expandPairedMembers(pairedFixture(), 6).slice(0, 2);
    const roles = members.map((m) => m.role);
    expect(roles.filter((r) => r === PAIR_ROLE_DIRECTOR)).toHaveLength(1);
    expect(roles.filter((r) => r === PAIR_ROLE_IMPLEMENTER)).toHaveLength(1);
  });
});

describe('wholePairSeats refuses to open a half pair', () => {
  it('rounds an odd allowance DOWN rather than opening a lone director', () => {
    expect(wholePairSeats(5)).toBe(4);
    expect(wholePairSeats(3)).toBe(2);
  });

  it('opens nothing at all when there is not room for one whole pair', () => {
    expect(wholePairSeats(1)).toBe(0);
    expect(wholePairSeats(0)).toBe(0);
  });

  it('passes an even allowance through untouched', () => {
    expect(wholePairSeats(2)).toBe(2);
    expect(wholePairSeats(6)).toBe(6);
  });

  it('treats a non-finite allowance as zero rather than producing NaN seats', () => {
    expect(wholePairSeats(Number.NaN)).toBe(0);
    expect(wholePairSeats(Number.POSITIVE_INFINITY)).toBe(0);
    expect(wholePairSeats(-4)).toBe(0);
  });
});

describe('expandPairedMembers routes each role through the EXISTING per-member override path', () => {
  it('emits one member spec per seat, in seat order', () => {
    const members = expandPairedMembers(pairedFixture(), 4);
    expect(members).toHaveLength(4);
    expect(members.map((m) => m.role)).toEqual([
      PAIR_ROLE_DIRECTOR,
      PAIR_ROLE_IMPLEMENTER,
      PAIR_ROLE_DIRECTOR,
      PAIR_ROLE_IMPLEMENTER,
    ]);
  });

  it('gives each role ITS OWN knobs — the whole reason the type branches', () => {
    const [director, implementer] = expandPairedMembers(pairedFixture(), 2);
    expect(director.model).toBe('opus');
    expect(director.effort).toBe('high');
    expect(director.headless).toBe(false);
    expect(implementer.model).toBe('sonnet');
    expect(implementer.account).toBe('auto');
    expect(implementer.headless).toBe(true);
    expect(implementer.carry).toBe('cold');
  });

  it('never leaks a knob across roles', () => {
    const [director, implementer] = expandPairedMembers(pairedFixture(), 2);
    expect(director.account).toBeUndefined();
    expect(director.carry).toBeUndefined();
    expect(implementer.effort).toBeUndefined();
  });

  it('emits NO undefined keys, so an unset role knob falls through to the fleet default', () => {
    // The fold treats `undefined` as fallthrough, but only because the key is
    // absent. An explicit `{ model: undefined }` would still be a present key on
    // some future spread-based fold, so assert absence rather than undefined-ness.
    const [director] = expandPairedMembers(pairedFixture(), 2);
    expect(Object.keys(director).sort()).toEqual(['effort', 'headless', 'model', 'role']);
  });

  it('repeats the same role config across every pair', () => {
    const members = expandPairedMembers(pairedFixture(), 4);
    expect(members[0]).toEqual(members[2]);
    expect(members[1]).toEqual(members[3]);
  });

  it('clamps an odd seat allowance to whole pairs', () => {
    expect(expandPairedMembers(pairedFixture(), 5)).toHaveLength(4);
    expect(expandPairedMembers(pairedFixture(), 1)).toHaveLength(0);
  });

  it('produces specs whose every knob is a real MemberSpec field', () => {
    // Guards the reuse claim: these objects are fed to foldMemberSpec, whose zod
    // schema is .strict(). A knob this module invents that MemberSpec lacks would
    // be a loud runtime refusal at launch, far from here.
    const memberSpecFields = new Set([...PER_ROLE_KNOBS, 'role']);
    for (const m of expandPairedMembers(pairedFixture(), 4)) {
      for (const key of Object.keys(m)) expect(memberSpecFields.has(key as never)).toBe(true);
    }
  });
});
