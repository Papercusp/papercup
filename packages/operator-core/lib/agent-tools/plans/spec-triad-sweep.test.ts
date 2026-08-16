import { describe, it, expect } from 'vitest';
import {
  selectSpecTriadFilings,
  planRef,
  SPEC_TRIAD_MAX_FILINGS_PER_RUN,
  LIVE_PLAN_STATUSES,
  type PlanContentRow,
} from './spec-triad-sweep';

const EPOCH = new Date('2026-08-09T00:00:00.000Z');
const REQ = 'Recall must surface anchor staleness to the agent, not only to the settings UI.';
const DESIGN = 'Fold the nightly sweep verdict into memory:search as a prepended banner.';

function row(o: {
  slug: string;
  created?: string | null;
  triad?: boolean;
  declare?: 'required' | 'exempt';
  ws?: string;
  harness?: string;
  items?: number;
}): PlanContentRow {
  const fm = ['---', `slug: ${o.slug}`, 'status: active'];
  if (o.declare) fm.push(`specTriad: ${o.declare}`);
  fm.push('---', '');
  const body = ['# T', ''];
  if (o.triad) body.push('## Requirements', '', REQ, '', '## Design', '', DESIGN, '');
  const n = o.items ?? 1;
  body.push('## Items', '');
  for (let i = 1; i <= n; i++) body.push(`- **P-${String(i).padStart(3, '0')}** todo — t${i}`);
  return {
    workspace_id: o.ws ?? 'ws',
    harness_slug: o.harness ?? 'h',
    plan_slug: o.slug,
    created: o.created === undefined ? '2026-08-10' : o.created,
    content: [...fm, ...body, ''].join('\n'),
    items: Array.from({ length: n }, (_, i) => ({ id: `P-${String(i + 1).padStart(3, '0')}` })),
  };
}

function select(rows: PlanContentRow[], over: Partial<Parameters<typeof selectSpecTriadFilings>[0]> = {}) {
  return selectSpecTriadFilings({
    rows,
    alreadyOpen: new Set<string>(),
    epoch: EPOCH,
    maxFilings: SPEC_TRIAD_MAX_FILINGS_PER_RUN,
    ...over,
  });
}

describe('selectSpecTriadFilings', () => {
  it('files for an in-scope plan missing the triad', () => {
    const s = select([row({ slug: 'a' })]);
    expect(s.inScope).toBe(1);
    expect(s.owing).toHaveLength(1);
    expect(s.batch).toHaveLength(1);
    expect(s.owing[0].missing).toEqual(['requirements', 'design']);
    expect(s.owing[0].gap).toMatch(/Requirements/);
  });

  it('does not file for an in-scope plan that carries the triad', () => {
    const s = select([row({ slug: 'a', triad: true })]);
    expect(s.inScope).toBe(1);
    expect(s.owing).toHaveLength(0);
    expect(s.batch).toHaveLength(0);
  });

  it('files NOTHING for the pre-epoch corpus — no plan is retro-gated', () => {
    // The counterpart to the policy test's freeze guard: if the sweep filed for
    // pre-epoch plans it would file hundreds of work items on first run, which is
    // the same design error wearing a different hat.
    const s = select([
      row({ slug: 'old-1', created: '2026-05-01' }),
      row({ slug: 'old-2', created: '2026-07-31' }),
      row({ slug: 'no-date', created: null }),
      row({ slug: 'bad-date', created: 'sometime' }),
    ]);
    expect(s.inScope).toBe(0);
    expect(s.owing).toHaveLength(0);
    expect(s.batch).toHaveLength(0);
  });

  it('honours an explicit `required` opt-in on an old plan', () => {
    const s = select([row({ slug: 'legacy', created: '2020-01-01', declare: 'required' })]);
    expect(s.owing).toHaveLength(1);
  });

  it('honours `exempt` on a new plan — never files against the escape hatch', () => {
    const s = select([row({ slug: 'new', created: '2026-09-01', declare: 'exempt' })]);
    expect(s.inScope).toBe(0);
    expect(s.owing).toHaveLength(0);
  });

  it('skips a plan whose filing is already open (idempotence)', () => {
    const r = row({ slug: 'a' });
    const s = select([r], { alreadyOpen: new Set([planRef(r)]) });
    expect(s.owing).toHaveLength(1);
    expect(s.alreadyFiled).toBe(1);
    expect(s.batch).toHaveLength(0);
    expect(s.deferred).toBe(0);
  });

  it('dedupes on the FULL tenant-qualified ref, not the bare slug', () => {
    // Two tenants can hold a plan of the same slug; an open filing for one must
    // not suppress the other's.
    const mine = row({ slug: 'shared', ws: 'ws-a' });
    const theirs = row({ slug: 'shared', ws: 'ws-b' });
    const s = select([mine, theirs], { alreadyOpen: new Set([planRef(mine)]) });
    expect(s.batch.map((b) => b.row.workspace_id)).toEqual(['ws-b']);
  });

  it('caps the batch and reports the remainder as deferred, never dropping it silently', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ slug: `p-${i}` }));
    const s = select(rows, { maxFilings: 25 });
    expect(s.owing).toHaveLength(30);
    expect(s.batch).toHaveLength(25);
    expect(s.deferred).toBe(5);
  });

  it('a maxFilings of 0 files nothing and defers everything', () => {
    const s = select([row({ slug: 'a' }), row({ slug: 'b' })], { maxFilings: 0 });
    expect(s.batch).toHaveLength(0);
    expect(s.deferred).toBe(2);
  });

  it('re-narrows on candidateKeys — the ANY(slugs) phase-2 read can cross tenants', () => {
    const mine = row({ slug: 'p', ws: 'ws-a' });
    const otherTenant = row({ slug: 'p', ws: 'ws-b' });
    const s = select([mine, otherTenant], { candidateKeys: new Set([planRef(mine)]) });
    expect(s.batch).toHaveLength(1);
    expect(s.batch[0].row.workspace_id).toBe('ws-a');
  });

  it('counts a plan with no items as owing the tasks leg', () => {
    const r: PlanContentRow = { ...row({ slug: 'a', triad: true }), items: [] };
    const s = select([r]);
    expect(s.owing[0].missing).toEqual(['tasks']);
  });

  it('is a no-op on an empty input rather than throwing', () => {
    const s = select([]);
    expect(s).toMatchObject({ inScope: 0, owing: [], batch: [], deferred: 0, alreadyFiled: 0 });
  });
});

describe('LIVE_PLAN_STATUSES — the sweep never files against an UNAPPROVED plan', () => {
  // EI-20607174902714110. The triad is an INTERLOCK, not paperwork: `plans:items`
  // holds a plan's items out of `actionable` while a leg is missing, and does so
  // WITHOUT marking anything blocked — so for an unapproved draft that absence is
  // the only thing keeping its work unclaimable. A filing that says "write the
  // missing triad" is therefore, for a draft, an instruction to make un-ruled work
  // pickable, and it is indistinguishable from a legitimate filing. Six were open
  // at once on 2026-08-16, one against a plan gated on the owner for auth/security.
  //
  // These assertions are deliberately opposed, because the failure has two
  // directions and fixing one by hand can silently cause the other.

  /** Statuses that mean "exists, but nobody has cleared it to be worked". */
  const NOT_YET_APPROVED = ['draft', 'proposed', 'needs-human', 'superseded', 'shipped'];

  it('EXCLUDES draft — a plan nobody has approved must not get a filing', () => {
    expect(LIVE_PLAN_STATUSES).not.toContain('draft');
  });

  it('still INCLUDES the approved statuses — narrowing must not disable the sweep', () => {
    // The opposite failure: emptying or over-narrowing this list turns the daily
    // backstop into a silent no-op, which looks identical to "nothing owes a triad".
    expect(LIVE_PLAN_STATUSES).toContain('ready');
    expect(LIVE_PLAN_STATUSES).toContain('active');
    expect(LIVE_PLAN_STATUSES.length).toBeGreaterThan(0);
  });

  it('contains only statuses that mean APPROVED-TO-BE-WORKED', () => {
    // Guards the general rule rather than the two literals above, so a future
    // status meaning "proposed but not ruled on" cannot be added without failing.
    for (const s of LIVE_PLAN_STATUSES) expect(NOT_YET_APPROVED).not.toContain(s);
  });

  it('CONTROL: the rule above actually fires on a regressed list', () => {
    // A guard that has never failed is a guard nobody has tested. This is the
    // permanent in-file control (repo rule: never mutate the shared tree to prove
    // falsifiability — git-sync sweeps the whole tree and can commit the mutant).
    // It runs the SAME predicate against a deliberately-regressed list, so if the
    // predicate is ever weakened into a tautology, THIS test fails first.
    const regressed = ['draft', 'ready', 'active']; // the pre-fix value
    const offenders = regressed.filter((s) => NOT_YET_APPROVED.includes(s));
    expect(offenders).toEqual(['draft']);

    // ...and the calibration case: the real value must pass the same predicate.
    expect(LIVE_PLAN_STATUSES.filter((s) => NOT_YET_APPROVED.includes(s))).toEqual([]);
  });
});
