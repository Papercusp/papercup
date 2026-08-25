/**
 * coupling-sources-obligations.test.ts — P-004, the consult obligation source.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, stated up front because the distinction is the
 * whole point of D-093's starvation lesson. A mocked `sql` proves the MAPPING (which side
 * of a stored pair the caller is on ⇒ which direction is emitted) and the SHAPE of the
 * predicate. It cannot prove the predicate SELECTS the right rows — only live data can,
 * and that half was measured separately against `harness_shared.consult_state` (workspace
 * papercusp-workspace, 2026-08-25, with a passing positive control):
 *
 *   110 excluded closed_at set · 45 excluded no responder (no_qualified_responder)
 *     2 excluded substantive post already landed · 2 EMIT (both awaiting_responder)
 *
 * The fixtures below are the REAL rows from that measurement, not invented ones, so this
 * file and the live verdict describe the same three consults.
 *
 * ⚠ The two exclusions worth keeping honest are the ones reasoning alone gets wrong:
 *   · the discharge check is NOT redundant with `closed_at IS NULL` — two live consults
 *     sit in state='active' with closed_at NULL while ALREADY carrying an answer/close
 *     post, so without it they emit a false debt against an agent who already replied;
 *   · `clarifying_question` must NOT discharge — that is the responder asking the
 *     requester for more, so the debt has not ended.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows the mocked handle returns for the next call. */
let nextRows: unknown[] = [];
/** Whether the coord backend claims a PG fast path. */
let hasPgFastPath = true;
/** Set when the handle should throw, to exercise the fail-soft path. */
let sqlThrows = false;
/** The SQL text of the last query, reassembled from the tagged-template strings. */
let lastSqlText = '';
/** The interpolated values of the last query, in order. */
let lastSqlValues: unknown[] = [];

vi.mock('./log', () => ({
  coordHasPgFastPath: () => hasPgFastPath,
  coordWorkspaceId: () => 'papercusp-workspace',
  coordSql: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    lastSqlText = strings.join('?');
    lastSqlValues = values;
    if (sqlThrows) throw new Error('pg down');
    return Promise.resolve(nextRows);
  },
}));

/** Oracle verdicts by ownerId. An ABSENT key models a counterpart with no presence row
 *  at all — the live `su-e40dceb1` case, and the one P-011 names explicitly. */
let livenessVerdicts = new Map<string, { ownerId: string; sessionState: string | null }>();
/** Set when the oracle itself should throw, to prove the degradation is `unknown`. */
let oracleThrows = false;
/** Subjects handed to the oracle on the last call — proves ONE batched call, not N. */
let oracleCalls: { ownerId: string }[][] = [];

vi.mock('./liveness-oracle', () => ({
  resolveSessionStates: (subjects: readonly { ownerId: string }[]) => {
    oracleCalls.push([...subjects]);
    if (oracleThrows) throw new Error('oracle down');
    const out = new Map<string, { ownerId: string; sessionState: string | null }>();
    // Deliberately omits unknown subjects rather than returning a placeholder — the real
    // oracle can return a map missing a subject, and that must land on 'unknown'.
    for (const s of subjects) {
      const v = livenessVerdicts.get(s.ownerId);
      if (v) out.set(s.ownerId, v);
    }
    return Promise.resolve(out);
  },
}));

const { fetchConsultObligations, CONSULT_DISCHARGING_POST_KINDS, COUPLING_OBLIGATION_ROW_CAP } =
  await import('./coupling-sources');

/** The two agents on the live undischarged consult (conv-mt80to4a…). */
const REQUESTER = 'su-b9ddacb7-d005-4748-a49f-b02e80d39c90';
const RESPONDER = 'su-886dfc99-bf14-4a88-9522-8b580b8c11d8';
const HANDLE = 'conv-mt80to4a-0000-767222ae228f4ace98123e6c16c382a8';
const CREATED = '2026-08-25T02:03:31.581Z';

/** The live `awaiting_responder` consult, exactly as the table holds it. */
const LIVE_ROW = {
  conversation_id: HANDLE,
  requester_id: REQUESTER,
  responder_id: RESPONDER,
  created_at: CREATED,
};

beforeEach(() => {
  nextRows = [];
  hasPgFastPath = true;
  sqlThrows = false;
  lastSqlText = '';
  lastSqlValues = [];
  oracleThrows = false;
  oracleCalls = [];
  // Both parties measurable and alive by default, so a test that cares about liveness
  // has to say so — and a test that does not is never silently exercising 'unknown'.
  livenessVerdicts = new Map([
    [REQUESTER, { ownerId: REQUESTER, sessionState: 'live' as string | null }],
    [RESPONDER, { ownerId: RESPONDER, sessionState: 'live' as string | null }],
  ]);
});

describe('P-004 — direction is read off which side of the stored pair the caller is on', () => {
  it('emits `owes-me` to the REQUESTER: they are owed the reply', async () => {
    nextRows = [LIVE_ROW];
    expect(await fetchConsultObligations(REQUESTER)).toEqual([
      {
        ownerId: RESPONDER,
        direction: 'owes-me',
        what: 'a consult reply',
        since: CREATED,
        handle: HANDLE,
        counterpartLiveness: 'live',
      },
    ]);
  });

  it('emits `i-owe` to the RESPONDER for the SAME consult — one fact, two readings', async () => {
    // The mirror is the property that makes the relation trustworthy: the identical
    // stored row must never render as the same direction to both parties, or one of
    // them is being told the opposite of the truth.
    nextRows = [LIVE_ROW];
    expect(await fetchConsultObligations(RESPONDER)).toEqual([
      {
        ownerId: REQUESTER,
        direction: 'i-owe',
        what: 'a consult reply',
        since: CREATED,
        handle: HANDLE,
      },
    ]);
  });

  it('CONTROL: a direction-blind mapping renders both parties identically', () => {
    // Permanent wrong-implementation control. If the two assertions above ever pass
    // against a mapping that ignores which side the caller is on, they are not
    // measuring direction at all — this proves they can tell the difference.
    const directionBlind = (self: string) => ({
      ownerId: self === LIVE_ROW.requester_id ? RESPONDER : REQUESTER,
      direction: 'owes-me' as const,
    });
    expect(directionBlind(REQUESTER).direction).toBe(directionBlind(RESPONDER).direction);
  });
});

describe('P-004 — rows that cannot form a renderable obligation are dropped at the source', () => {
  it('drops a row with no created_at rather than shipping an ageless edge', async () => {
    // `obligationPhrase` refuses an edge whose age it cannot state, so such a row would
    // be silently skipped downstream. Dropping it HERE keeps the census honest: an
    // unrenderable row must not count as an emitted input.
    nextRows = [{ ...LIVE_ROW, created_at: null }];
    expect(await fetchConsultObligations(REQUESTER)).toEqual([]);
  });

  it('drops a self-consult (an agent coupled to itself is not a relation)', async () => {
    nextRows = [{ ...LIVE_ROW, responder_id: REQUESTER }];
    expect(await fetchConsultObligations(REQUESTER)).toEqual([]);
  });

  it('drops a row missing its conversation handle — the reader could not act on it', async () => {
    nextRows = [{ ...LIVE_ROW, conversation_id: '' }];
    expect(await fetchConsultObligations(REQUESTER)).toEqual([]);
  });

  it('preserves SOURCE ORDER — oldest debt first, never re-sorted by ownerId', async () => {
    const older = { ...LIVE_ROW, conversation_id: 'conv-older', responder_id: 'su-zzz' };
    const newer = { ...LIVE_ROW, conversation_id: 'conv-newer', responder_id: 'su-aaa' };
    nextRows = [older, newer];
    const out = await fetchConsultObligations(REQUESTER);
    // Sorted by ownerId this would invert (su-aaa before su-zzz). The derivation
    // preserves source order for obligations and P-008 renders it.
    expect(out.map((e) => e.handle)).toEqual(['conv-older', 'conv-newer']);
  });
});

describe('P-004 — the predicate keeps all four exclusions and stays caller-scoped', () => {
  it('asks for every exclusion the live measurement depends on', async () => {
    nextRows = [];
    await fetchConsultObligations(REQUESTER);
    const sql = lastSqlText.replace(/\s+/g, ' ');
    // Each of these corresponds to a measured live population. Weakening any one of
    // them silently re-admits rows the live verdict proved must never emit.
    expect(sql).toContain('closed_at IS NULL'); // 110 closed rows
    expect(sql).toContain('responder_id IS NOT NULL'); // 45 no_qualified_responder
    expect(sql).toContain('NOT EXISTS'); // 2 already-discharged
    expect(sql).toContain('consult_post_meta'); // …via the post table
    expect(sql).toContain('responder_id <> cs.requester_id'); // self-consult
  });

  it('is CALLER-SCOPED — an agent can only learn about consults it is a party to', async () => {
    nextRows = [];
    await fetchConsultObligations(REQUESTER);
    const sql = lastSqlText.replace(/\s+/g, ' ');
    expect(sql).toContain('cs.requester_id =');
    expect(sql).toContain('cs.responder_id =');
    // The caller's own id is bound twice — once per side of the pair — and never
    // interpolated into the SQL text itself.
    expect(lastSqlValues.filter((v) => v === REQUESTER)).toHaveLength(2);
    expect(sql).not.toContain(REQUESTER);
  });

  it('bounds the scan and scopes it to the workspace', async () => {
    nextRows = [];
    await fetchConsultObligations(REQUESTER);
    expect(lastSqlValues).toContain(COUPLING_OBLIGATION_ROW_CAP);
    expect(lastSqlValues).toContain('papercusp-workspace');
  });
});

describe('P-004 — the discharging vocabulary is the measured one', () => {
  it('discharges on answer / decline / close', () => {
    expect([...CONSULT_DISCHARGING_POST_KINDS].sort()).toEqual(['answer', 'close', 'decline']);
  });

  it('does NOT discharge on clarifying_question or new_fact', () => {
    // The omission IS the design. `clarifying_question` is the responder asking the
    // REQUESTER for more — the debt has not been discharged, and treating it as one
    // would silently retire exactly the consults that are going badly. `new_fact` adds
    // to a consult that is still owed an answer.
    const kinds: readonly string[] = CONSULT_DISCHARGING_POST_KINDS;
    expect(kinds).not.toContain('clarifying_question');
    expect(kinds).not.toContain('new_fact');
  });
});

describe('P-004 — fail-soft: a coupling signal must never degrade the roster', () => {
  it('returns [] when the backend has no PG fast path', async () => {
    hasPgFastPath = false;
    nextRows = [LIVE_ROW];
    expect(await fetchConsultObligations(REQUESTER)).toEqual([]);
  });

  it('returns [] when the query throws, instead of propagating', async () => {
    sqlThrows = true;
    expect(await fetchConsultObligations(REQUESTER)).toEqual([]);
  });

  it('returns [] for a blank caller id without touching the database', async () => {
    nextRows = [LIVE_ROW];
    expect(await fetchConsultObligations('   ')).toEqual([]);
    expect(lastSqlText).toBe('');
  });
});
