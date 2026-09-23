/**
 * P-009(a)+(b) of plan `directive-visibility-and-ownership-2026-09-22` — the PIN.
 *
 * WHAT IS PINNED, and why it is a doc-claim rather than another bucket test.
 * `turn-start-orientation-owner-directive-buckets.test.ts` asserts what EACH of
 * the three buckets says. That is per-branch, which means it cannot catch the
 * regression that actually matters: a FOURTH reachable shape — a new bucket, a
 * degraded row, a refactor that drops `recordedBy` from `OrientationOwnerDirective`
 * again — rendering a directive line with no addressing on it at all. A per-branch
 * suite stays green through that, because the branches it names keep passing.
 *
 * So the claim pinned here is EXHAUSTIVE and quantified over the whole reachable
 * cross product: **no owner-directive line reaches an agent without stating whom
 * the owner was addressing.** D-006 measured why the claim needs a guard — the
 * field was dropped by the TYPE (`OrientationOwnerDirective` carried exactly
 * `{ id, captureStatus, verbatimText }`), one hop before the renderer, so the
 * renderer never had it to print and nothing anywhere failed.
 *
 * AND THE SECOND HALF, which no existing file asserts about ONE fixture: P-009(b)
 * requires that for the SAME foreign directive, B's banner carries no carry-out
 * imperative AND B's `orders:disposition` is refused. Those two live in different
 * files today, over different fixtures, so a drift that re-addressed one without
 * the other would leave both green. D-004 is explicit that the LABEL is not the
 * protection — the rail is — which is exactly why they are guarded as one claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectOrientationRows,
  type OrientationOwnerDirective,
  type OrientationState,
} from '../turn-start-orientation';
import type { DirectiveStatus } from '../owner-directive-status';

const h = vi.hoisted(() => ({
  dispositionOwnerDirective: vi.fn(),
  directiveActionVerdict: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../owner-directives')>();
  return { ...actual, dispositionOwnerDirective: h.dispositionOwnerDirective };
});

vi.mock('../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../owner-directive-agenda')>();
  return { ...actual, directiveActionVerdict: h.directiveActionVerdict };
});

vi.mock('../agent-tools/coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});

vi.mock('../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-registry')>();
  return { ...actual, activeWorkspaceId: h.activeWorkspaceId };
});

const disposition = (await import('../agent-tools/orders/disposition')).default;

const ADDRESSEE = 'su-9390fc63-26a0-46a9-95d1-805705cc5e2d';
const READER = 'su-51a6b83f-a691-4e44-b550-0adfe7a0d3c5';

const BASELINE: OrientationState = {
  lockTransitions: undefined,
  coupledPeers: [],
  planDecisions: undefined,
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  modes: [],
  authorityVerdict: null,
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

function status(kind: DirectiveStatus['kind'], over: Partial<DirectiveStatus> = {}): DirectiveStatus {
  return {
    kind,
    holders: [],
    activeWorkItemIds: [],
    workedButUndispositioned: false,
    ...over,
  };
}

/** Only the directive lines themselves — the `+N more` overflow row is a count, not a directive. */
function directiveLines(...directives: OrientationOwnerDirective[]): string[] {
  return projectOrientationRows({ ...BASELINE, ownerDirectives: directives }, 'turn-start')
    .filter((row) => row.classId === 'ownerDirectives')
    .map((row) => row.text)
    .filter((text) => /owner directive #\d+/.test(text));
}

/**
 * THE PINNED PREDICATE. A line states its addressing when it either claims the
 * directive for the reader (`YOURS`) or names the session it was recorded by.
 * Both spellings trace to the same input: `mine` is `recordedBy === ownerId`,
 * decided in the reader, and `addressed to <handle>` is `recordedBy` truncated.
 */
function statesAddressing(line: string): boolean {
  return /\bYOURS\b/.test(line) || /addressed to \S+/.test(line);
}

/**
 * Every reachable shape, enumerated rather than sampled. `settled` kinds are
 * deliberately absent: D-007 requires them to produce NO row at all, which the
 * bucket suite pins, and a line that does not exist cannot lack addressing.
 */
const REACHABLE: Array<{ name: string; row: OrientationOwnerDirective }> = [];
// D-001 (owner-directive-delivery-redesign-2026-09-22): every captured turn is
// open, so the lifecycle axis has one undispositioned value.
for (const captureStatus of ['open'] as const) {
  for (const capturedByHook of [true, false]) {
    const base = { id: 96, verbatimText: 'pause the 0.0.22 release', capturedByHook } as const;
    REACHABLE.push({
      name: `mine · ${captureStatus} · hook=${capturedByHook}`,
      row: { ...base, recordedBy: READER, addressedToMe: true, status: status('unclaimed') },
    });
    REACHABLE.push({
      name: `foreign unclaimed · ${captureStatus} · hook=${capturedByHook}`,
      row: { ...base, recordedBy: ADDRESSEE, addressedToMe: false, status: status('unclaimed') },
    });
    REACHABLE.push({
      name: `foreign claimed · ${captureStatus} · hook=${capturedByHook}`,
      row: {
        ...base,
        recordedBy: ADDRESSEE,
        addressedToMe: false,
        status: status('claimed', { claimedBy: 'su-c03852cb-1111-2222-3333-444455556666', holders: ['su-c03852cb'] }),
      },
    });
    REACHABLE.push({
      // WI-10002437 measured 41 damaged rows; an unattributable one still renders.
      name: `unattributable · ${captureStatus} · hook=${capturedByHook}`,
      row: { ...base, recordedBy: '', addressedToMe: false, status: status('unclaimed') },
    });
    REACHABLE.push({
      // Undecided addressing must fall to NOT-mine, and still say so.
      name: `undecided addressing · ${captureStatus} · hook=${capturedByHook}`,
      row: { ...base, recordedBy: ADDRESSEE, addressedToMe: undefined, status: status('unclaimed') },
    });
  }
}

describe('doc-claim: no owner-directive line reaches an agent without stating its addressing', () => {
  it.each(REACHABLE.map((c) => [c.name, c.row] as const))('%s states whom the owner addressed', (_name, row) => {
    const [line, ...rest] = directiveLines(row);
    expect(rest).toEqual([]);
    expect(line).toBeDefined();
    expect(statesAddressing(line!)).toBe(true);
  });

  it('CALIBRATION: the sweep is non-vacuous — every case really did produce a line', () => {
    expect(REACHABLE.length).toBeGreaterThanOrEqual(10);
    for (const { name, row } of REACHABLE) expect(directiveLines(row), name).toHaveLength(1);
  });

  /**
   * PERMANENT CONTROL (never mutate the tree to prove this — repo rule). This is
   * the line the renderer emitted BEFORE P-007: id, capture status, text, and one
   * imperative, with no addressing anywhere. The predicate must reject it, or every
   * assertion above passes vacuously against a renderer that regressed to it.
   */
  it('would catch the pre-P-007 line, which carried no addressing at all', () => {
    const asShipped = `- 📌 owner directive #96 [pending] "pause the 0.0.22 release" — orders:resolve-pending first.`;
    expect(statesAddressing(asShipped)).toBe(false);
  });

  /** The handle is DERIVED from recordedBy, not a constant that happens to look like one. */
  it('the rendered handle tracks recordedBy, truncated to the 12-char convention', () => {
    const of = (recordedBy: string) =>
      directiveLines({
        id: 96,
        verbatimText: 'pause the 0.0.22 release',
        capturedByHook: true,
        recordedBy,
        addressedToMe: false,
        status: status('unclaimed'),
      })[0]!;

    expect(of(ADDRESSEE)).toContain(`addressed to ${ADDRESSEE.slice(0, 12)}`);
    expect(of(READER)).toContain(`addressed to ${READER.slice(0, 12)}`);
    expect(of(ADDRESSEE)).not.toContain(READER.slice(0, 12));
    // An unattributable row renders a token that can never equal an ownerId, so it
    // can only ever read as NOT-mine — never as a session that might be you.
    expect(of('')).toContain('addressed to unknown');
  });
});

/**
 * P-009(b) — ONE directive, BOTH halves. The label and the rail are a single
 * contract (D-004): the label tells the reader it is not theirs, and the rail is
 * what makes that true even when the reader reads past the label. The live
 * reproduction in D-009 is exactly a reader acting on a rendered imperative.
 */
describe('doc-claim: the same foreign directive is un-imperative in the banner AND refused at the write verb', () => {
  const FOREIGN_ROW: OrientationOwnerDirective = {
    id: 96,
    verbatimText: 'pause the 0.0.22 release',
    capturedByHook: true,
    recordedBy: ADDRESSEE,
    addressedToMe: false,
    status: status('unclaimed'),
  };

  beforeEach(() => {
    h.dispositionOwnerDirective.mockReset();
    h.dispositionOwnerDirective.mockResolvedValue({ ok: true, row: { id: 96 } });
    h.directiveActionVerdict.mockReset();
    h.resolveAgentIdentity.mockReturnValue({ ownerId: READER });
    h.activeWorkspaceId.mockReturnValue('papercusp-workspace');
  });

  it("renders for the non-addressed reader, labelled, with no resolve/dispose imperative", () => {
    const [line] = directiveLines(FOREIGN_ROW);
    // D-004: it RENDERS. Filtering was the acting agent's first instinct and the
    // owner rejected it, so the absence of this line is a regression too.
    expect(line).toContain('owner directive #96');
    expect(line).toContain(`addressed to ${ADDRESSEE.slice(0, 12)}`);
    expect(line).toContain('NOT yours to resolve');
    expect(line).not.toContain('orders:resolve-pending');
    expect(line).not.toContain('orders:disposition');
    expect(line).not.toMatch(/\bYOURS\b/);
  });

  it('refuses that same id at orders:disposition, without reaching the writer', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: ADDRESSEE, holders: [] });

    const result = (await disposition.handler(
      { id: FOREIGN_ROW.id, status: 'done', note: 'not my lane' } as never,
      { uiClientId: 'pus-test', isPowerUser: false } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const [row] = (JSON.parse(result.content[0]!.text) as { results: Array<{ error?: string; addressedTo?: string }> })
      .results;
    expect(row!.error).toBe('foreign_directive');
    expect(row!.addressedTo).toBe(ADDRESSEE);
    // The absent write is the assertion: closing a directive stops it rendering
    // for EVERY session, and is not observably reversible afterwards.
    expect(h.dispositionOwnerDirective).not.toHaveBeenCalled();
  });

  it('CALIBRATION: the addressee is NOT refused, so the rail is addressing-sensitive rather than blanket-off', async () => {
    h.resolveAgentIdentity.mockReturnValue({ ownerId: ADDRESSEE });
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });

    const result = (await disposition.handler(
      { id: FOREIGN_ROW.id, status: 'done', note: 'carried out' } as never,
      { uiClientId: 'pus-test', isPowerUser: false } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(h.dispositionOwnerDirective).toHaveBeenCalledTimes(1);
  });
});
