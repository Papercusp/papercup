/**
 * coord/index.test.ts — loadCoordInbox (EI-18138089781782660 follow-up, WI-5618).
 *
 * loadCoordInbox used to read the WHOLE coord corpus every call
 * (readAllMessages() / listEscalations({}) / listHandoffs({}), each an
 * unbounded full-surface event replay), then filter down to the human-facing
 * subset in JS — cost grew unboundedly with total coord volume, the same
 * anti-pattern loadCoordHistory had before its own fix. This pins that it now
 * uses the same BOUNDED primitives loadCoordHistory uses (readLinesBounded /
 * listEscalationsPaginated / listHandoffsPaginated) — never the unbounded
 * readLines/listEscalations({})/listHandoffs({}) — while preserving the exact
 * same filter semantics: messages/handoffs addressed to `'human'`, and only
 * OPEN (unresolved) escalations.
 *
 * `@papercusp/agent-mcp`'s `defineTool` and the `./inbox-sse` route are
 * mocked out (identity passthrough / no-op) purely to keep this a lean, pure
 * unit test of `loadCoordInbox`'s own logic — this file also defines HTTP
 * route objects and pulls in the coord_inbox PG-notify bus transitively via
 * inbox-sse.ts, neither of which this test exercises.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope, EscalationRecord } from '@papercusp/coordination/core';
import type { HandoffWithAcceptance } from '../../../agent-tools/coordination/handoffs';
import { assertShapeMatchesRecordedVersion } from '../../../derived-reads/shape-fingerprint';

const {
  readLinesBoundedMock,
  listEscalationsMock,
  listEscalationsPaginatedMock,
  listHandoffsMock,
  listHandoffsPaginatedMock,
  readAllPlansMock,
  readPlanBySlugMock,
} = vi.hoisted(() => ({
  readLinesBoundedMock: vi.fn(async () => [] as CoordEnvelope[]),
  listEscalationsMock: vi.fn(async () => [] as EscalationRecord[]),
  listEscalationsPaginatedMock: vi.fn(async () => ({
    escalations: [] as EscalationRecord[],
    truncated: false,
    total: 0,
  })),
  listHandoffsMock: vi.fn(async () => [] as HandoffWithAcceptance[]),
  listHandoffsPaginatedMock: vi.fn(async () => ({
    handoffs: [] as HandoffWithAcceptance[],
    truncated: false,
    total: 0,
  })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readAllPlansMock: vi.fn(async () => [] as any[]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readPlanBySlugMock: vi.fn(async () => null as any),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineTool: (spec: unknown) => spec as any,
}));
vi.mock('./inbox-sse', () => ({ default: {} }));
vi.mock('../../../agent-tools/coordination/log', () => ({
  coordLog: { readLinesBounded: readLinesBoundedMock },
}));
vi.mock('../../../agent-tools/coordination/escalations', () => ({
  listEscalations: listEscalationsMock,
  listEscalationsPaginated: listEscalationsPaginatedMock,
}));
vi.mock('../../../agent-tools/coordination/handoffs', () => ({
  listHandoffs: listHandoffsMock,
  listHandoffsPaginated: listHandoffsPaginatedMock,
}));
vi.mock('../../../agent-tools/coordination/plan-events', () => ({ readPlanEvents: vi.fn(async () => []) }));
vi.mock('../../../agent-tools/plans/source', () => ({
  readAllPlans: readAllPlansMock,
  readPlanBySlug: readPlanBySlugMock,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => 'mock markdown') }));

import routesDefault, { loadCoordInbox, loadCoordPlans, loadCoordHistory, preWarmCoordPlans } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planBySlugRoute = (routesDefault as any[]).find((r) => r.path === '/coord/plans/:slug');

function msg(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-07-20T00:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLinesBoundedMock.mockResolvedValue([]);
  listEscalationsPaginatedMock.mockResolvedValue({ escalations: [], truncated: false, total: 0 });
  listHandoffsPaginatedMock.mockResolvedValue({ handoffs: [], truncated: false, total: 0 });
});

describe('loadCoordInbox — bounded reads (EI-18138089781782660 follow-up)', () => {
  it('reads messages via readLinesBounded (never the unbounded readLines) and filters to `to: human`', async () => {
    readLinesBoundedMock.mockResolvedValueOnce([
      msg({ msg_id: 'm1', to: ['human'] }),
      msg({ msg_id: 'm2', to: ['bob'] }),
    ]);
    const items = await loadCoordInbox();
    expect(readLinesBoundedMock).toHaveBeenCalledWith('messages', expect.objectContaining({ limit: expect.any(Number) }));
    expect(items.map((i) => i.msg_id)).toEqual(['m1']);
  });

  it('requests escalations via listEscalationsPaginated({ status: "open" }) — no JS resolved==null filter, no unbounded listEscalations({}) call', async () => {
    listEscalationsPaginatedMock.mockResolvedValueOnce({
      escalations: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ts: '2026-07-20T00:00:00.000Z', msg_id: 'e1', from: 'x', to: ['human'], kind: 'escalation', severity: 'question', summary: 's', resolved: null } as any,
      ],
      truncated: false,
      total: 1,
    });
    const items = await loadCoordInbox();
    expect(listEscalationsPaginatedMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
    expect(listEscalationsMock).not.toHaveBeenCalled();
    expect(items.map((i) => i.msg_id)).toContain('e1');
  });

  it('reads handoffs via listHandoffsPaginated (never the unbounded listHandoffs({})) and filters to `to: human`', async () => {
    listHandoffsPaginatedMock.mockResolvedValueOnce({
      handoffs: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { record: { ts: '2026-07-20T00:00:00.000Z', msg_id: 'h1', from: 'x', to: ['human'], kind: 'handoff' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { record: { ts: '2026-07-20T00:00:00.000Z', msg_id: 'h2', from: 'x', to: ['someone-else'], kind: 'handoff' } } as any,
      ],
      truncated: false,
      total: 2,
    });
    const items = await loadCoordInbox();
    expect(listHandoffsMock).not.toHaveBeenCalled();
    expect(items.map((i) => i.msg_id)).toEqual(['h1']);
  });

  it('never falls back to the unbounded full-corpus reads', async () => {
    await loadCoordInbox();
    expect(listEscalationsMock).not.toHaveBeenCalled();
    expect(listHandoffsMock).not.toHaveBeenCalled();
  });

  it('merges all three surfaces and sorts newest-first', async () => {
    readLinesBoundedMock.mockResolvedValueOnce([
      msg({ msg_id: 'm-old', to: ['human'], ts: '2026-01-01T00:00:00.000Z' }),
    ]);
    listEscalationsPaginatedMock.mockResolvedValueOnce({
      escalations: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ts: '2026-06-01T00:00:00.000Z', msg_id: 'e-new', from: 'x', to: ['human'], kind: 'escalation', severity: 'question', summary: 's', resolved: null } as any,
      ],
      truncated: false,
      total: 1,
    });
    const items = await loadCoordInbox();
    expect(items.map((i) => i.msg_id)).toEqual(['e-new', 'm-old']);
  });
});

/**
 * loadCoordPlans — canonical identity, never the plan's self-declared
 * frontmatter (WI-7246).
 *
 * A scheduled-run snapshot is stored under `<slug>@run-<epochms>` and copies
 * its parent plan's markdown VERBATIM, frontmatter included. Reading `slug` /
 * `status` / `updated` out of that frontmatter therefore reports the PARENT's
 * identity and lifecycle for every snapshot. Measured live 2026-08-03 on
 * papercusp: 973 rows collapsed to 923 distinct slugs, `critical-severity-
 * alert-2026-07-06` appearing 51x byte-identical, with 50 identity mismatches,
 * 50 stale `updated` dates and 51 stale statuses.
 *
 * The fixture below is that exact real-world shape in miniature.
 */
function planRec(planSlug: string, dbStatus: string, dbUpdated: string, frontmatter: Record<string, unknown>) {
  return {
    parsed: {
      isLegacy: false,
      slug: planSlug,
      frontmatter,
      now: { state: null, next: null },
      items: [],
      decisions: [],
    },
    archived: false,
    row: { planSlug, status: dbStatus, updated: dbUpdated },
  };
}

describe('loadCoordPlans — identity comes from the row, not the markdown (WI-7246)', () => {
  // The parent plan plus two of its run snapshots. All three carry byte-identical
  // frontmatter, because a snapshot copies the parent's body verbatim.
  const parentFrontmatter = { slug: 'alert-2026-07-06', title: 'Alert', status: 'draft', updated: '2026-07-06' };
  const corpus = [
    planRec('alert-2026-07-06', 'draft', '2026-07-06', parentFrontmatter),
    planRec('alert-2026-07-06@run-1784241963690', 'superseded', '2026-07-21', parentFrontmatter),
    planRec('alert-2026-07-06@run-1784244243583', 'superseded', '2026-07-22', parentFrontmatter),
  ];

  it('gives each run snapshot its OWN slug — three distinct plans never collapse into one identity', async () => {
    readAllPlansMock.mockResolvedValueOnce(corpus);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.slug)).toEqual([
      'alert-2026-07-06',
      'alert-2026-07-06@run-1784241963690',
      'alert-2026-07-06@run-1784244243583',
    ]);
    // The regression this pins: distinct rows in, distinct identities out.
    // React keys, openPlan(slug) navigation and the openSlug===slug expansion
    // test in CoordDashboard's PlansPanel all key on this value.
    expect(new Set(plans.map((p) => p.slug)).size).toBe(plans.length);
  });

  it('reports the row status, so a superseded snapshot never renders as its parent draft', async () => {
    readAllPlansMock.mockResolvedValueOnce(corpus);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.status)).toEqual(['draft', 'superseded', 'superseded']);
  });

  it('prefers the row updated date when the column carries one', async () => {
    readAllPlansMock.mockResolvedValueOnce(corpus);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.updated)).toEqual(['2026-07-06', '2026-07-21', '2026-07-22']);
  });

  it('falls back to the frontmatter date when the row column is NULL — the real snapshot shape', async () => {
    // Measured 2026-08-03: `updated` is NULL on all 50 live run snapshots, so
    // canonical-first is a no-op there. Pinned so the fallback is not later
    // "cleaned up" into a row-only read that would blank the date on all 50.
    readAllPlansMock.mockResolvedValueOnce([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      planRec('alert@run-1', 'superseded', null as any, parentFrontmatter),
    ]);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.updated)).toEqual(['2026-07-06']);
  });

  it('still prefers the frontmatter title (display text, not identity) and falls back to the canonical slug', async () => {
    readAllPlansMock.mockResolvedValueOnce([
      ...corpus,
      planRec('untitled-plan', 'active', '2026-08-01', { status: 'active' }),
    ]);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.title)).toEqual(['Alert', 'Alert', 'Alert', 'untitled-plan']);
  });

  it('falls back to the frontmatter status only when the row carries none', async () => {
    readAllPlansMock.mockResolvedValueOnce([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      planRec('no-db-status', null as any, '2026-08-01', { status: 'active' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      planRec('no-status-anywhere', null as any, '2026-08-01', {}),
    ]);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.status)).toEqual(['active', 'unknown']);
  });

  it('drops legacy plans', async () => {
    const legacy = planRec('legacy-plan', 'active', '2026-08-01', { title: 'Legacy' });
    legacy.parsed.isLegacy = true;
    readAllPlansMock.mockResolvedValueOnce([legacy, ...corpus]);
    const plans = await loadCoordPlans();
    expect(plans.map((p) => p.slug)).not.toContain('legacy-plan');
    expect(plans).toHaveLength(3);
  });
});

/**
 * preWarmCoordPlans — the boot fire-and-forget warm-up (WI-36179): a bare
 * `loadCoordPlans()` call fired once at boot so the first REAL post-restart
 * call is warm (module compile + parsePlan() JIT + PG connection already
 * paid), same pattern as system-health's preWarmSystemHealth. Pins that it
 * (a) actually kicks the same read `readAllPlans` backs, and (b) never
 * throws/rejects even when that read fails — boot must not block or fail
 * on this being best-effort.
 */
describe('preWarmCoordPlans (WI-36179 — fire-and-forget boot warm-up)', () => {
  it('kicks the loadCoordPlans read', async () => {
    readAllPlansMock.mockResolvedValueOnce([]);
    preWarmCoordPlans(); // synchronous call — does not return a promise to await
    // loadCoordPlans() itself awaits a dynamic import() before reaching readAllPlans,
    // which defers past this tick even though the module is already cached — flush
    // one tick so the (fire-and-forget) read has actually started.
    await new Promise((r) => setTimeout(r, 0));
    expect(readAllPlansMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, and swallows a rejection via console.warn (must not block/fail boot)', async () => {
    readAllPlansMock.mockRejectedValueOnce(new Error('cold pg pool boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => preWarmCoordPlans()).not.toThrow();
      await new Promise((r) => setTimeout(r, 0)); // let the rejected read's .catch run
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/boot pre-warm of coord\.plans failed/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * GET /coord/plans/:slug — status comes from the row, not the markdown
 * (WI-7259, sibling of WI-7246's loadCoordPlans fix above).
 *
 * Same scheduled-run-snapshot shape: the snapshot's frontmatter is a
 * byte-identical copy of its parent's, so `found.parsed.frontmatter.status`
 * reports the PARENT's lifecycle for a request naming the snapshot's own
 * slug.
 */
describe('GET /coord/plans/:slug — status comes from the row, not the markdown (WI-7259)', () => {
  async function callPlanBySlug(slug: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (planBySlugRoute as any).handler(new Request(`http://x/coord/plans/${slug}`), {
      params: { slug },
    });
    return res.json();
  }

  it('reports the row status for a snapshot slug whose frontmatter still reads the parent draft', async () => {
    readPlanBySlugMock.mockResolvedValueOnce({
      parsed: {
        isLegacy: false,
        slug: 'alert-2026-07-06',
        frontmatter: { title: 'Alert', status: 'draft' },
        filePath: '/synthetic/alert-2026-07-06@run-1.md',
      },
      archived: false,
      row: { planSlug: 'alert-2026-07-06@run-1', status: 'superseded' },
    });
    const body = await callPlanBySlug('alert-2026-07-06@run-1');
    expect(body.status).toBe('superseded');
    // title stays frontmatter-first — display text, not identity (WI-7246 precedent).
    expect(body.title).toBe('Alert');
  });

  it('falls back to the frontmatter status only when the row carries none', async () => {
    readPlanBySlugMock.mockResolvedValueOnce({
      parsed: {
        isLegacy: false,
        slug: 'no-db-status',
        frontmatter: { title: 'T', status: 'active' },
        filePath: '/synthetic/no-db-status.md',
      },
      archived: false,
      row: { planSlug: 'no-db-status', status: null },
    });
    const body = await callPlanBySlug('no-db-status');
    expect(body.status).toBe('active');
  });
});

describe('loadCoordHistory — `payload` never re-ships a projected column (WI-7295)', () => {
  // toHistoryItem used to set `payload: e` — the WHOLE envelope that the row's own
  // ts/msg_id/kind/from/to/plan_slug/harness_slug were projected FROM. Measured live
  // 2026-08-03 on the default 200-row view, that second copy was 42,328 B (16.2% of a
  // 261,140 B read against a 250,000 B budget), identical on 200/200 rows with zero
  // exceptions. These pin BOTH halves: the copies are gone, and nothing else is.
  const PROJECTED = ['ts', 'msg_id', 'kind', 'from', 'to', 'plan_slug', 'harness_slug'] as const;

  const rich = () =>
    msg({
      msg_id: 'm-rich',
      kind: 'notify',
      from: 'alice',
      to: ['bob', 'carol'],
      detail: 'the full detail text that summary truncates',
      body: 'a body the expand pane still needs',
      plan_slug: 'some-plan',
      harness_slug: 'papercusp',
    } as Partial<CoordEnvelope>);

  async function onlyRow() {
    readLinesBoundedMock.mockResolvedValueOnce([rich()]);
    const { items } = await loadCoordHistory({ kinds: ['message'] });
    expect(items).toHaveLength(1);
    return items[0];
  }

  it('strips every projected key from payload — asserting ABSENCE, not a null value', async () => {
    const row = await onlyRow();
    for (const k of PROJECTED) {
      // `not.toHaveProperty` is the point: a key present-but-null still costs
      // bytes on the wire, so `toBeNull()` would pass while the read stayed fat.
      expect(row.payload).not.toHaveProperty(k);
    }
  });

  it('keeps every projected VALUE reachable, byte-identical, at the row top level', async () => {
    const row = await onlyRow();
    expect(row.ts).toBe('2026-07-20T00:00:00.000Z');
    expect(row.msg_id).toBe('m-rich');
    expect(row.kind).toBe('notify');
    expect(row.from).toBe('alice');
    expect(row.to).toEqual(['bob', 'carol']);
    expect(row.plan_slug).toBe('some-plan');
    expect(row.harness_slug).toBe('papercusp');
  });

  it('does NOT over-strip: the fields only payload carries survive', async () => {
    const row = await onlyRow();
    // `summary` is DERIVED (envSummary truncates detail to 200 chars), not copied —
    // so `detail` must stay in payload or the expand pane loses the full text.
    expect(row.payload).toHaveProperty('detail', 'the full detail text that summary truncates');
    expect(row.payload).toHaveProperty('body', 'a body the expand pane still needs');
    expect(row.summary).toBe('the full detail text that summary truncates');
  });

  it('pins the stripped-field COUNT at 7 so a new projected column cannot silently ship twice', async () => {
    const row = await onlyRow();
    const stripped = PROJECTED.filter((k) => !(k in (row.payload as Record<string, unknown>)));
    expect(stripped).toHaveLength(7);
    // The row still projects all 7 columns — strip and project must stay in lockstep.
    expect(PROJECTED.filter((k) => k in row)).toHaveLength(7);
  });

  // ── WI-7289 shape guard ──────────────────────────────────────────────────
  //
  // The de-dup pin above (WI-7295) protects the payload/top-level split from
  // silent drift, but nothing tied it to the `coord.history` derived-read
  // producer's registered `producerVersion` in producers.ts — the exact gap
  // that shipped this fix inert once already (a stored v1 snapshot kept
  // passing registry.ts:204's version check and served the old fat rows
  // indefinitely). This ties them: fingerprint a REAL row (through
  // loadCoordHistory's actual toHistoryItem logic, not a stand-in) and
  // require it to match the shape recorded for the producer's LIVE
  // registered version — see shape-fingerprint.ts's module doc.
  it('shape-guard: the real history-item shape matches the shape recorded for its LIVE registered producerVersion (WI-7289)', async () => {
    // WI-7297: fingerprint what the producer actually STORES, which is no longer
    // loadCoordHistory's row verbatim — the producer runs it through
    // projectCoordHistoryForUi to drop `payload` before the snapshot is written.
    // Sampling the unprojected loader row here would pin a shape the snapshot
    // never has, which is the guard answering confidently about the wrong
    // object: the v3 payload cut could then regress back in with the guard
    // still green.
    const { projectCoordHistoryForUi } = await import('../../../sync-resolver/coord-ui-projection');
    const row = (projectCoordHistoryForUi([await onlyRow()]) as unknown[])[0];

    const registry = await import('../../../derived-reads/registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('../../../derived-reads/producers');
    const producer = registry.listDerivedReadProducers().find((p) => p.key === 'coord.history');
    if (!producer) throw new Error('coord.history producer not registered');

    assertShapeMatchesRecordedVersion({
      key: 'coord.history',
      producerVersion: producer.producerVersion,
      sample: row,
      expectedByVersion: {
        // Captured from a real loadCoordHistory() call against the `rich()`
        // fixture above (not hand-typed) — regenerate after a DELIBERATE
        // shape change, per shape-fingerprint.ts's module doc.
        //
        // v2 was the pre-WI-7297 shape, when the snapshot still carried
        // `payload:obj{body:string,detail:string}`. Kept for the record: it is
        // what a stored v2 row still looks like, and the contrast with v3 is
        // the whole point of the version key.
        2: 'obj{from:string,harness_slug:string,kind:string,msg_id:string,payload:obj{body:string,detail:string},plan_slug:string,source:string,summary:string,to:arr<string>,ts:string}',
        3: 'PLACEHOLDER_CAPTURE_ME',
      },
    });
  });
});
