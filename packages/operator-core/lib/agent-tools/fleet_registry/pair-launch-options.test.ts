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
  PER_ROLE_KNOBS,
  resolveLaunchOptions,
  type ResolvedPairedLaunch,
  type ResolvedSingleLaunch,
} from './pair-launch-options';

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
