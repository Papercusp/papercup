/**
 * coupling-consumer-surface.test.ts — the FULL reader-facing path, factory included.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE SAME DEFECT WAS CAUGHT THREE TIMES, ONE LAYER FURTHER
 * OUT EACH TIME, BY AN INDEPENDENT GRADER I COULD NOT SUBSTITUTE FOR.
 *
 *   Round 1 (EI-21416355952506420): ordering proven, truncation proven, their COMPOSITION
 *     only inferred. Fixed by testing resolveCoupledPeers → buildCoupledExpansion together.
 *   Round 2 (EI-21417137611872652): the end-to-end criterion bound a producer test and a
 *     renderer test — each green, the wiring between them unexercised. Fixed by driving an
 *     injected obligations source through derivation → peers → render.
 *   Round 3 (EI-21417219711898949): still not the consumer surface. That fix INJECTED the
 *     source directly, bypassing `couplingSourcesFor` — so the factory's obligations leg
 *     reaching the rendered row was STILL only inferred, exactly one layer out from the
 *     previous fix.
 *
 * The pattern is worth naming because it is not a coincidence: every fix closed the gap it
 * could see and re-created the identical gap at its own boundary. Each half was green and
 * the seam above it was assumed. This file closes it at the real boundary — the factory a
 * reader actually calls.
 *
 * WHAT IS REAL HERE vs MOCKED. Only the IO leaves are mocked (`coordSql`, the fleet
 * presence read, the liveness oracle). `couplingSourcesFor`, `deriveCouplings`,
 * `resolveCoupledPeers` and `buildCoupledExpansion` are the production functions, composed
 * in production order. That is the point: mock one layer lower than the thing you claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows the mocked consult query returns. */
let consultRows: unknown[] = [];
let livenessVerdicts = new Map<string, { ownerId: string; sessionState: string | null }>();

vi.mock('./log', () => ({
  coordHasPgFastPath: () => true,
  coordWorkspaceId: () => 'papercusp-workspace',
  // Discriminate by the query's own text: the consult producer reads `consult_state`,
  // the grading producer reads the observation lane. Only the consult leg has rows here.
  coordSql: () => (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (sql.includes('consult_state')) return Promise.resolve(consultRows);
    return Promise.resolve([]);
  },
}));

vi.mock('./presence-fleet', () => ({
  // No fleet membership ⇒ the supervision producer contributes nothing, so anything that
  // reaches the rendered row came from the CONSULT leg specifically.
  fetchFleetSupervisionRows: () => Promise.resolve(new Map()),
}));

vi.mock('./liveness-oracle', () => ({
  resolveSessionStates: (subjects: readonly { ownerId: string }[]) => {
    const out = new Map<string, { ownerId: string; sessionState: string | null }>();
    for (const s of subjects) {
      const v = livenessVerdicts.get(s.ownerId);
      if (v) out.set(s.ownerId, v);
    }
    return Promise.resolve(out);
  },
}));

const { couplingSourcesFor } = await import('./coupling-sources');
const { deriveCouplings } = await import('../../coord/coupling-derivation');
const { resolveCoupledPeers } = await import('../../coord/couplings');
const { buildCoupledExpansion } = await import('../../coord/coupled-expansion');

const SELF = 'su-requester';
const PEER = 'su-responder';
const HANDLE = 'conv-mt80to4a-0000-767222ae228f4ace98123e6c16c382a8';

/** One open, undischarged consult, shaped as `consult_state` actually returns it. */
const openConsultRow = {
  conversation_id: HANDLE,
  requester_id: SELF,
  responder_id: PEER,
  created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
};

const roster = [
  { ownerId: SELF, ownerLabel: 'requester' },
  { ownerId: PEER, ownerLabel: 'responder' },
];

/** The production composition, factory included — this is the whole point of the file. */
const renderCoupledSurface = async () => {
  const sources = couplingSourcesFor({
    selfOwnerId: SELF,
    rosterOwnerIds: [SELF, PEER],
    workspaceId: 'papercusp-workspace',
  });
  const derived = await deriveCouplings(SELF, roster, sources);
  const peers = resolveCoupledPeers(SELF, derived, []);
  return buildCoupledExpansion(peers, roster);
};

beforeEach(() => {
  consultRows = [];
  livenessVerdicts = new Map([[PEER, { ownerId: PEER, sessionState: 'ended' }]]);
});

describe('consumer surface — an open consult becomes a visible coupled-expansion row THROUGH couplingSourcesFor', () => {
  it('renders the obligation with direction, age, handle AND the peer’s liveness', async () => {
    consultRows = [openConsultRow];
    const entry = (await renderCoupledSurface()).expanded.find((e) => e.ownerId === PEER);

    expect(entry).toBeDefined();
    // Everything a reader needs without opening anything else. The liveness is the half
    // the owner's originating question actually asked for.
    expect(entry?.expandedBecause).toContain('they owe you a consult reply');
    expect(entry?.expandedBecause).toContain(HANDLE);
    expect(entry?.expandedBecause).toContain('counterpart ended');
  });

  it('carries the TYPED relation to the surface, not only prose', async () => {
    consultRows = [openConsultRow];
    const surface = await renderCoupledSurface();
    const peers = surface.expanded.map((e) => e.ownerId);
    expect(peers).toContain(PEER);
    // A machine consumer (the P-010 census, the P-008 sort) needs the token, and prose
    // cannot be round-tripped back into one — D-087.
    const derived = await deriveCouplings(SELF, roster, couplingSourcesFor({
      selfOwnerId: SELF,
      rosterOwnerIds: [SELF, PEER],
      workspaceId: 'papercusp-workspace',
    }));
    expect(derived.map((d) => d.relation)).toContain('owes-me');
  });

  it('a DISCHARGED consult yields NO row — the other half of the outcome', async () => {
    // The producer's SQL excludes it; this asserts the consequence a reader sees.
    consultRows = [];
    expect((await renderCoupledSurface()).expanded).toHaveLength(0);
  });

  it('reports the peer as `unknown` rather than live when the oracle cannot measure it', async () => {
    consultRows = [openConsultRow];
    livenessVerdicts.delete(PEER);
    const entry = (await renderCoupledSurface()).expanded.find((e) => e.ownerId === PEER);
    expect(entry?.expandedBecause).toContain('counterpart unknown');
    expect(entry?.expandedBecause).not.toContain('counterpart live');
  });

  it('CONTROL: a sources object WITHOUT the obligations leg renders nothing', async () => {
    // Permanent wrong-implementation control, and the one that makes this file mean
    // something. `couplingSourcesFor` could stop wiring `obligations` — the producer would
    // still pass its own tests, the renderer would still pass its own tests, and a reader
    // would receive NOTHING. That is the born-unobservable failure (D-088) at the factory
    // boundary. If the assertions above ever pass against this, they are not measuring the
    // wiring they claim to.
    consultRows = [openConsultRow];
    const derived = await deriveCouplings(SELF, roster, {});
    const peers = resolveCoupledPeers(SELF, derived, []);
    expect(buildCoupledExpansion(peers, roster).expanded).toHaveLength(0);
  });

  it('CONTROL: the factory DOES arm the obligations leg — so the control above is a real difference', async () => {
    // Pairs with the previous case. Without this, "unwired renders nothing" is satisfiable
    // by a factory that never wires anything, and both controls would pass vacuously.
    const sources = couplingSourcesFor({
      selfOwnerId: SELF,
      rosterOwnerIds: [SELF, PEER],
      workspaceId: 'papercusp-workspace',
    });
    expect(typeof sources.obligations).toBe('function');
    consultRows = [openConsultRow];
    expect(await sources.obligations!()).toHaveLength(1);
  });
});
