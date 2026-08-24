import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateCellSpec,
  registerCell,
  getCell,
  listCells,
  listCellsUnchecked,
  canReadCell,
  CellRegistrationError,
  __resetCellRegistryForTests,
  CELL_FEDERATION_TRANSPORT_AVAILABLE,
  type CellSpec,
} from './cell-registry';

/**
 * The enforcement tier for unified-agent-state-plane-2026-07-27 D-038/D-039.
 * Modelled on agent-tools/coordination/liveness-parity.test.ts: the contract is only
 * a contract if a test refuses a spec that breaks it.
 *
 * The positive fixtures below are the three INDEPENDENT cells the contract was
 * derived from (D-036) — different domains, different stores, different authors.
 */

/** `git-pipeline-position` — a POLL cell, so it must carry a real assessment. */
const pipelineCell = (): CellSpec => ({
  cell: 'git.pipelinePosition',
  owner: 'su-28464',
  headline: 'positions.onStaging',
  assessment: {
    path: 'assessments.position',
    codes: {
      advancing: {
        meaning: 'the change is moving through the pipeline and the legs are ticking.',
        safeAction: 'Wait. There is no lever to pull.',
      },
      'leg-dead': {
        meaning: 'the leg is not past this stage AND the mechanism moving it has stopped.',
        safeAction: 'Investigate the named stage. Waiting is futile — this is the reading a position boolean alone cannot distinguish from "not yet".',
      },
    },
    evidence: ['stages[].health'],
  },
  nullable: true,
  unknownHoist: 'stagesUnknown',
  callerRelativity: { kind: 'parameter', param: 'path' },
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  provenance: {
    obtainedBy: 'git rev-list / rev-parse against the live repo',
    liveExercised: true,
    evidence: 'the realGit trim defect surfaced only under live execution; no fixture caught it',
  },
  resolver: 'packages/operator-core/lib/git-pipeline-position.ts#gitPipelinePosition',
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
  shape: 'PipelinePosition',
  ordered: { stages: ['committedLocal', 'onStaging', 'inMain', 'deployed'] },
});

/**
 * `session.state` — the file's generic KNOWN-GOOD spec, and an EVENT-signalled one.
 *
 * ⚠ `assessment: null` is REQUIRED here, not an omission (D-016). An event cell has no
 * resolver payload to read a code out of, so a non-null assessment is rejected
 * (`assessment-on-event-cell`) — and since P-006 the field cannot simply be left off.
 * Null is how an event cell SAYS it has no semantics channel.
 */
const sessionCell = (): CellSpec => ({
  cell: 'session.state',
  assessment: null,
  owner: 'presence-derivation-unification-2026-07-17',
  headline: 'heartbeatFresh',
  nullable: true,
  unknownHoist: 'subjectsWithoutSignal',
  callerRelativity: { kind: 'global' },
  visibility: { kind: 'workspace' },
  // `local`, and deliberately so: this fixture is the file's generic KNOWN-GOOD spec —
  // a dozen axis tests spread it and assert `[]` — so its federation must be the valid
  // answer, not the subject under test. It was `shareable` until P-009/D-013 made that
  // a rejection; the federation tests below now opt INTO shareable explicitly, which is
  // also clearer about which assertions are actually about federation.
  federation: { kind: 'local' },
  provenance: {
    obtainedBy: 'resolveSessionStates over coord_presence + event_awaits + adv_sessions',
    liveExercised: true,
    evidence: 'liveness-parity.test.ts asserts cross-surface parity against real derivation',
  },
  resolver: 'packages/operator-core/lib/agent-tools/coordination/liveness-oracle.ts#resolveSessionStates',
  changeSignal: { kind: 'event', key: 'coord:presence-changed' },
  shape: 'Map<ownerId, SessionState>',
});

/** `port.listener` — a POLL cell whose relativity is AMBIENT. */
const portCell = (): CellSpec => ({
  cell: 'port.listener',
  owner: 'papercusp',
  headline: 'pid',
  assessment: {
    path: 'assessments.binding',
    codes: {
      unbound: {
        meaning: 'no process is listening on this port, and the kernel disclosed enough to say so.',
        safeAction: 'Bind it.',
      },
      'bound-owner-hidden': {
        meaning: 'the port IS bound, but the kernel did not disclose the owner to this uid.',
        safeAction: 'Do NOT read the absent pid as a free port. Re-probe with sufficient privilege before binding.',
      },
    },
    evidence: ['ownerVisible'],
  },
  nullable: true,
  unknownHoist: 'ownerHidden',
  callerRelativity: { kind: 'ambient', source: 'the calling process uid' },
  visibility: { kind: 'harness', ref: 'papercusp' },
  federation: { kind: 'local' },
  provenance: {
    obtainedBy: 'ss -ltnp over the live host',
    liveExercised: true,
    evidence: '~60% of listening sockets on this host are the owner-unreadable middle case',
  },
  resolver: 'packages/operator-core/lib/agent-tools/dev/listening_ports.ts#listeningPorts',
  changeSignal: { kind: 'poll', tool: 'dev:listening_ports', path: 'totalListening' },
  shape: '{ sockets[], matched, totalListening, ownerHidden }',
});

beforeEach(() => __resetCellRegistryForTests());

describe('the three independent cells the contract was derived from all register', () => {
  it.each([
    ['git.pipelinePosition', pipelineCell],
    ['session.state', sessionCell],
    ['port.listener', portCell],
  ])('%s passes every axis', (_name, make) => {
    expect(validateCellSpec(make())).toEqual([]);
    expect(registerCell(make()).cell).toBe(_name);
  });

  it('registers and reads back, sorted', () => {
    registerCell(portCell());
    registerCell(sessionCell());
    // portCell is harness-scoped, so the reader must be in that harness to see both.
    const reader = { ownerId: 'su-anyone', harnessSlug: 'papercusp' };
    expect(listCells(reader).map((c) => c.cell)).toEqual(['port.listener', 'session.state']);
    expect(getCell('port.listener', reader)?.owner).toBe('papercusp');
  });
});

describe('P-019 — visibility and federation are declared at registration', () => {
  const anyone = { ownerId: 'su-stranger' };

  it('REFUSES a cell that declares no visibility', () => {
    const spec = { ...sessionCell(), visibility: undefined as unknown as CellSpec['visibility'] };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('visibility-undeclared');
  });

  it('REFUSES a cell that declares no federation', () => {
    const spec = { ...sessionCell(), federation: undefined as unknown as CellSpec['federation'] };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('federation-undeclared');
  });

  it('REFUSES a narrow visibility with no ref', () => {
    expect(
      validateCellSpec({ ...sessionCell(), visibility: { kind: 'owner', ref: '  ' } }).map((r) => r.rule),
    ).toContain('visibility-ref-missing');
  });

  it('REFUSES a shareable cell whose visibility is narrower than the workspace', () => {
    // A ref like an owner id or work-item does not resolve in a foreign hive, so the
    // receiver can neither evaluate nor honour the audience: it fails open (leak) or
    // closed (silently invisible). Refused rather than guessed.
    const spec: CellSpec = {
      ...portCell(),
      visibility: { kind: 'owner', ref: 'su-8d9a6' },
      federation: { kind: 'shareable' },
    };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('shareable-narrow-visibility');
  });

  it('ACCEPTS any visibility + local', () => {
    expect(validateCellSpec(portCell())).toEqual([]); // harness-narrow + local
    expect(validateCellSpec(sessionCell())).toEqual([]); // workspace-wide + local
  });

  // ── P-009 / D-013 — `shareable` fails CLOSED while nothing transports it.
  /** Workspace-visible + shareable: valid under P-019 alone, refused only by D-013. */
  const shareableCell = (): CellSpec => ({ ...sessionCell(), federation: { kind: 'shareable' } });

  it('REFUSES a shareable cell while no transport consumes spec.federation, and for NO OTHER reason', () => {
    // Pinning the rejection set EXACTLY (not toContain) is the point: it proves the
    // spec is otherwise entirely valid — sessionCell() asserts `[]` directly above —
    // so flipping CELL_FEDERATION_TRANSPORT_AVAILABLE re-accepts it unchanged rather
    // than uncovering a second latent violation.
    expect(CELL_FEDERATION_TRANSPORT_AVAILABLE).toBe(false); // the premise this test is about
    expect(validateCellSpec(shareableCell()).map((r) => r.rule)).toEqual(['shareable-no-transport']);
  });

  it('tells a shareable author WHAT WOULD HAVE TO EXIST, not merely that it is refused', () => {
    // A refusal that does not name its own remedy just relocates the dead end.
    const [rejection] = validateCellSpec(shareableCell());
    expect(rejection.detail).toContain('CELL_FEDERATION_TRANSPORT_AVAILABLE');
    expect(rejection.detail).toContain('D-013');
  });

  it('reports BOTH federation violations at once for shareable + narrow visibility', () => {
    // validateCellSpec's contract is to return EVERY reason (it pushes, never throws),
    // so the transport gate must not mask the narrow-visibility rule. That rule is
    // deliberately KEPT rather than deleted, and this is what proves it is not dead
    // code: it still fires today, and it is what will police shareable cells the day
    // a transport lands.
    const spec: CellSpec = {
      ...portCell(),
      visibility: { kind: 'owner', ref: 'su-8d9a6' },
      federation: { kind: 'shareable' },
    };
    const rules = validateCellSpec(spec).map((r) => r.rule);
    expect(rules).toContain('shareable-narrow-visibility');
    expect(rules).toContain('shareable-no-transport');
  });

  it('an OUT-OF-AUDIENCE caller cannot read the cell — P-019 acceptance criterion', () => {
    registerCell(portCell()); // visibility: { kind: 'harness', ref: 'papercusp' }
    const inAudience = { ownerId: 'su-a', harnessSlug: 'papercusp' };
    const outOfAudience = { ownerId: 'su-b', harnessSlug: 'some-other-harness' };

    expect(getCell('port.listener', inAudience)?.cell).toBe('port.listener');
    expect(getCell('port.listener', outOfAudience)).toBeUndefined();
    expect(canReadCell(portCell(), outOfAudience)).toBe(false);
  });

  it('hides EXISTENCE, not just the value — a refusal must not be a probe oracle', () => {
    registerCell(portCell());
    const outOfAudience = { ownerId: 'su-b', harnessSlug: 'other' };
    // Indistinguishable from a cell that was never registered at all.
    expect(getCell('port.listener', outOfAudience)).toBe(getCell('cell.doesNotExist', outOfAudience));
    expect(listCells(outOfAudience)).toEqual([]);
  });

  it('each visibility kind admits exactly its own audience', () => {
    expect(canReadCell({ ...portCell(), visibility: { kind: 'workspace' } }, anyone)).toBe(true);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'owner', ref: 'su-x' } }, { ownerId: 'su-x' })).toBe(true);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'owner', ref: 'su-x' } }, { ownerId: 'su-y' })).toBe(false);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'role', ref: 'admin' } }, { ownerId: 'su-x', roles: ['admin'] })).toBe(true);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'role', ref: 'admin' } }, { ownerId: 'su-x', roles: ['dev'] })).toBe(false);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'work_item', ref: 'WI-1' } }, { ownerId: 'su-x', workItems: ['WI-1'] })).toBe(true);
    expect(canReadCell({ ...portCell(), visibility: { kind: 'work_item', ref: 'WI-1' } }, { ownerId: 'su-x' })).toBe(false);
  });

  it('fails CLOSED on an unregistrable visibility rather than defaulting open', () => {
    const bogus = { ...portCell(), visibility: { kind: 'nonsense' } as unknown as CellSpec['visibility'] };
    expect(canReadCell(bogus, { ownerId: 'su-x', harnessSlug: 'papercusp' })).toBe(false);
  });

  it('listCellsUnchecked bypasses the audience — the loud name is the point', () => {
    registerCell(portCell());
    expect(listCellsUnchecked().map((c) => c.cell)).toEqual(['port.listener']);
    expect(listCells({ ownerId: 'su-b', harnessSlug: 'other' })).toEqual([]);
  });
});

/**
 * P-006/D-016 — `assessment` IS REQUIRED, AND NULL IS THE EVENT CELL'S ANSWER.
 *
 * These two tests are the pair. Either one alone reads as a working requirement while
 * the other direction is broken, and the broken direction is silent: a requirement that
 * also caught event cells would make them unregisterable (they cannot carry an
 * assessment at all — `assessment-on-event-cell`), and a requirement that exempted
 * anything non-poll would let a cell with a malformed `changeSignal` ship with no
 * declared semantics.
 */
describe('P-006 — a value-bearing cell must declare what its value MEANS', () => {
  it('REFUSES a poll cell whose assessment is null', () => {
    const spec: CellSpec = { ...pipelineCell(), assessment: null };
    const r = validateCellSpec(spec);
    expect(r.map((x) => x.rule)).toContain('assessment-missing');
    expect(r.find((x) => x.rule === 'assessment-missing')!.axis).toBe('assessment');
  });

  it('ACCEPTS an event cell whose assessment is null — that is the legal answer, not an omission', () => {
    expect(validateCellSpec(sessionCell())).toEqual([]);
  });

  // The requirement is keyed on NOT-event rather than on IS-poll, so a broken
  // discriminator falls INTO the requirement instead of silently out of it.
  it('REFUSES a null assessment when changeSignal is malformed, rather than exempting it', () => {
    const spec = {
      ...pipelineCell(),
      assessment: null,
      changeSignal: undefined as unknown as CellSpec['changeSignal'],
    };
    expect(validateCellSpec(spec).map((x) => x.rule)).toContain('assessment-missing');
  });
});

describe('axis 2 — the unknown must be enumerated AND hoisted (D-039)', () => {
  // liveness-oracle.ts:243 does `if (!w) continue`, so a degraded subject gets NO
  // MAP ENTRY — an unknown signalled by OMISSION, worse than a bare null because
  // map.get() returns undefined, indistinguishable from "I never asked".
  it('refuses a nullable verdict with no result-level hoist', () => {
    const spec = { ...sessionCell(), unknownHoist: undefined };
    const r = validateCellSpec(spec);
    expect(r.map((x) => x.rule)).toContain('unknown-not-hoisted');
    expect(r[0].axis).toBe(2);
  });

  it('refuses a blank hoist as firmly as a missing one', () => {
    expect(validateCellSpec({ ...sessionCell(), unknownHoist: '   ' }).map((r) => r.rule)).toContain(
      'unknown-not-hoisted',
    );
  });

  it('refuses a hoist declared on a non-nullable cell', () => {
    const spec = { ...sessionCell(), nullable: false };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('hoist-without-nullable');
  });

  it('a non-nullable cell needs no hoist', () => {
    expect(
      validateCellSpec({
        ...sessionCell(),
        nullable: false,
        unknownHoist: undefined,
        whyTotal: 'the resolver returns a value or throws; no read can fail into a default.',
      }),
    ).toEqual([]);
  });

  // EI-18773925664381842 — the gate used to be HONESTY-GATED. `nullable: true` cost
  // you a hoist; `nullable: false` cost NOTHING, so the author who admitted their
  // value could be unknown did strictly more work than one who declared totality
  // they had never checked. These four tests pin the branch that used to be free.
  it('refuses a non-nullable verdict that does not attest WHY it is total', () => {
    const r = validateCellSpec({ ...sessionCell(), nullable: false, unknownHoist: undefined });
    expect(r.map((x) => x.rule)).toContain('total-not-attested');
    expect(r.every((x) => x.axis === 2)).toBe(true);
  });

  it('refuses a blank attestation as firmly as a missing one', () => {
    expect(
      validateCellSpec({
        ...sessionCell(),
        nullable: false,
        unknownHoist: undefined,
        whyTotal: '   ',
      }).map((r) => r.rule),
    ).toContain('total-not-attested');
  });

  it('refuses an attestation of totality on a cell that declares it can be unknown', () => {
    expect(
      validateCellSpec({ ...sessionCell(), whyTotal: 'cannot be unknown' }).map((r) => r.rule),
    ).toContain('total-attested-on-nullable');
  });

  // The incentive gradient, asserted directly: before this rule the LEFT spec passed
  // clean and the RIGHT one was rejected, so the cheapest declaration was also the
  // least honest. Neither may now pass for free.
  it('no longer rewards the weaker cell: bare `nullable: false` is not cheaper than an honest nullable', () => {
    const bareTotal = validateCellSpec({ ...sessionCell(), nullable: false, unknownHoist: undefined });
    const honestNullableMissingHoist = validateCellSpec({ ...sessionCell(), unknownHoist: undefined });
    expect(bareTotal.length).toBeGreaterThan(0);
    expect(honestNullableMissingHoist.length).toBeGreaterThan(0);
  });
});

describe('axis 3 — relativity is declared, never inferred', () => {
  // An inferring registry would inspect listening_ports, find no caller parameter,
  // and conclude `global`. Wrong, and wrong in the confident direction.
  it('accepts ambient relativity as first-class', () => {
    expect(validateCellSpec(portCell())).toEqual([]);
  });

  it('refuses an omitted declaration', () => {
    const spec = { ...portCell(), callerRelativity: undefined as unknown as CellSpec['callerRelativity'] };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('relativity-undeclared');
  });

  it('refuses an unnamed parameter or ambient source', () => {
    expect(
      validateCellSpec({ ...pipelineCell(), callerRelativity: { kind: 'parameter', param: '' } }).map((r) => r.rule),
    ).toContain('relativity-parameter-unnamed');
    expect(
      validateCellSpec({ ...portCell(), callerRelativity: { kind: 'ambient', source: '' } }).map((r) => r.rule),
    ).toContain('relativity-ambient-unnamed');
  });

  it('`global` is a valid stated answer', () => {
    expect(validateCellSpec({ ...sessionCell(), callerRelativity: { kind: 'global' } })).toEqual([]);
  });
});

describe('axis 4 — no cell registered on fixture evidence alone', () => {
  it('refuses liveExercised:false however good the evidence prose is', () => {
    const spec = {
      ...pipelineCell(),
      provenance: { ...pipelineCell().provenance, liveExercised: false },
    };
    const r = validateCellSpec(spec);
    expect(r.map((x) => x.rule)).toContain('fixture-evidence-only');
    expect(r[0].axis).toBe(4);
  });

  it('refuses an unevidenced attestation', () => {
    const spec = { ...portCell(), provenance: { ...portCell().provenance, evidence: '' } };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('provenance-unevidenced');
  });
});

describe('axis 5 — one derivation, many lenses', () => {
  it('refuses a cell with no resolver', () => {
    expect(validateCellSpec({ ...sessionCell(), resolver: '' }).map((r) => r.rule)).toContain('no-resolver');
  });

  it('refuses re-registering a cell under a SECOND resolver', () => {
    registerCell(sessionCell());
    expect(() => registerCell({ ...sessionCell(), resolver: 'some/other/module.ts#reDerive' })).toThrow(
      CellRegistrationError,
    );
  });

  it('re-registering the SAME resolver is idempotent, not a conflict', () => {
    registerCell(sessionCell());
    expect(() => registerCell(sessionCell())).not.toThrow();
    expect(listCells({ ownerId: 'su-a' })).toHaveLength(1);
  });
});

describe('axis 6 — ordered is optional and its ABSENCE is not "clear"', () => {
  it('a cell without a stage order registers fine', () => {
    expect(validateCellSpec({ ...portCell(), ordered: undefined })).toEqual([]);
  });

  it('absence is representable as absence — never as an empty verdict', () => {
    registerCell({ ...portCell(), ordered: undefined });
    expect(getCell('port.listener', { ownerId: 'su-a', harnessSlug: 'papercusp' })).toHaveProperty(
      'ordered',
      undefined,
    );
  });
});

describe('registration refuses rather than admits-and-flags', () => {
  // A registered cell reads as system truth, which raises the cost of a wrong one
  // above anything prose ever had. So a refused cell is ABSENT, not present-and-suspect.
  it('throws, reports EVERY violation at once, and does not register', () => {
    const broken: CellSpec = {
      ...sessionCell(),
      unknownHoist: undefined,
      provenance: { obtainedBy: 'fixtures', liveExercised: false, evidence: '' },
      resolver: '',
    };
    let err: CellRegistrationError | undefined;
    try {
      registerCell(broken);
    } catch (e) {
      err = e as CellRegistrationError;
    }
    expect(err).toBeInstanceOf(CellRegistrationError);
    const axes = new Set(err!.rejections.map((r) => r.axis));
    expect([...axes].sort()).toEqual([2, 4, 5]);
    expect(getCell('session.state', { ownerId: 'su-a' })).toBeUndefined();
  });
});

describe('P-017 — alternate door projections are delivery metadata, not resolvers', () => {
  const rules = (spec: CellSpec) =>
    validateCellSpec(spec)
      .filter((r) => r.axis === 'doorProjections')
      .map((r) => r.rule);

  it('accepts another door/path while preserving the canonical poll resolver', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      doorProjections: [{ tool: 'release:deploy', path: 'deploy.deployedSha' }],
    };
    expect(rules(spec)).toEqual([]);
    expect(spec.changeSignal).toEqual({
      kind: 'poll',
      tool: 'dev:pipeline_position',
      path: 'positions.deployed',
    });
  });

  it('refuses a duplicate of the canonical signal or another projection', () => {
    const canonical = pipelineCell().changeSignal as { kind: 'poll'; tool: string; path: string };
    const spec: CellSpec = {
      ...pipelineCell(),
      doorProjections: [
        { tool: canonical.tool, path: canonical.path },
        { tool: 'release:deploy', path: 'deploy.deployedSha' },
        { tool: 'release:deploy', path: 'deploy.deployedSha' },
      ],
    };
    expect(rules(spec).filter((r) => r === 'door-projection-duplicate')).toHaveLength(2);
  });

  it('refuses projections on an event cell because state:read has no resolver', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      changeSignal: { kind: 'event', key: 'release:deployed' },
      doorProjections: [{ tool: 'release:status', path: 'deployedSha' }],
    };
    expect(rules(spec)).toContain('door-projections-on-event-cell');
  });
});

describe('WI-36259 — headlineSource is optional, but a declared one must be able to do work', () => {
  const ruleOf = (spec: CellSpec) =>
    validateCellSpec(spec).filter((r) => r.axis === 'headlineSource').map((r) => r.rule);
  const src = { path: 'gate.candidateSource', authoritative: ['retriage-marker'], why: 'the probe degrades to live HEAD on cron' };

  it('OMITTING it is valid — most cells reach their headline exactly one way', () => {
    expect(ruleOf(pipelineCell())).toEqual([]);
  });

  it('accepts a source path into the same result that differs from the changeSignal path', () => {
    expect(ruleOf({ ...pipelineCell(), headlineSource: src })).toEqual([]);
  });

  it('REFUSES a source path equal to the changeSignal path — a value cannot be its own provenance', () => {
    const changeSignal = pipelineCell().changeSignal as { kind: 'poll'; tool: string; path: string };
    const spec: CellSpec = { ...pipelineCell(), headlineSource: { ...src, path: changeSignal.path } };
    expect(ruleOf(spec)).toContain('headline-source-is-changesignal-path');
  });

  it('REFUSES an empty authoritative list — it could only ever downgrade, never distinguish', () => {
    const spec: CellSpec = { ...pipelineCell(), headlineSource: { ...src, authoritative: [] } };
    expect(ruleOf(spec)).toContain('headline-source-no-authoritative-values');
  });

  it('REFUSES an unjustified source — `why` must say what the untrusted reading DEGRADES TO', () => {
    // "Less trustworthy" is unactionable. The caller needs to know that a cron-path probe
    // is the checkout's live HEAD, because that is what tells them not to act on it.
    const spec: CellSpec = { ...pipelineCell(), headlineSource: { ...src, why: '  ' } };
    expect(ruleOf(spec)).toContain('headline-source-unjustified');
  });
});

describe('P-021 — materiality is optional, but a declared one must be able to do work', () => {
  const ruleOf = (spec: CellSpec) => validateCellSpec(spec).filter((r) => r.axis === 'materiality').map((r) => r.rule);

  it('OMITTING it is valid and is the default — every change is material', () => {
    // The default must stay free: a field you have to opt OUT of is a field
    // every author pays for, and D-010 makes cheapness the adoption precondition.
    expect(ruleOf(pipelineCell())).toEqual([]);
  });

  it('accepts a path into the same result that differs from the changeSignal path', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      materiality: { path: 'positions.serving', why: 'the headline follows every commit; this is the question.' },
    };
    expect(ruleOf(spec)).toEqual([]);
  });

  it('REFUSES a materiality path equal to the changeSignal path — a declared no-op', () => {
    const changeSignal = pipelineCell().changeSignal as { kind: 'poll'; tool: string; path: string };
    const spec: CellSpec = {
      ...pipelineCell(),
      materiality: { path: changeSignal.path, why: 'why not' },
    };
    expect(ruleOf(spec)).toContain('materiality-is-changesignal-path');
  });

  it('REFUSES an unjustified suppression — `why` is required', () => {
    // Every other field here fails LOUDLY when wrong. This one fails SILENTLY
    // and in the confident direction: a wrong material path stops telling agents
    // about real changes and nothing surfaces to say so. A reader told "N
    // changes were not raised" must be able to check the claim.
    const spec: CellSpec = {
      ...pipelineCell(),
      materiality: { path: 'positions.serving', why: '   ' },
    };
    expect(ruleOf(spec)).toContain('materiality-unjustified');
  });

  it('REFUSES a path-less declaration', () => {
    const spec: CellSpec = { ...pipelineCell(), materiality: { path: '', why: 'because' } };
    expect(ruleOf(spec)).toContain('materiality-path-missing');
  });

  it('REFUSES materiality on an EVENT-signalled cell — there is no result to path into', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      changeSignal: { kind: 'event', key: 'release:deployed' },
      materiality: { path: 'positions.serving', why: 'because' },
    };
    expect(ruleOf(spec)).toContain('materiality-on-event-cell');
  });

  it('registration THROWS on a bad materiality, so a half-declared suppression is absent not live', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      cell: 'mat.broken',
      materiality: { path: 'positions.serving', why: '' },
    };
    expect(() => registerCell(spec)).toThrow(CellRegistrationError);
    expect(getCell('mat.broken', { ownerId: 'su-a' })).toBeUndefined();
  });
});

/**
 * P-006 — POINTERS.
 *
 * Two properties carry this feature and both are asserted here rather than assumed:
 *
 *  (1) THE THING IT MUST NOT BECOME. D-014 rules that ownership stays its own cell with
 *      its own independent check, and the plan's earlier P-005 draft assumed a cell could
 *      carry such a check per BLOCK. A pointer is the sanctioned alternative ONLY while it stays
 *      incapable of asserting a measurement — which is a property of the TYPE, so the
 *      test that matters is the compile-time one recorded at the bottom of this block.
 *
 *  (2) THE CHECK THAT IS DELIBERATELY *NOT* AT REGISTRATION. Target existence is resolved
 *      per-read, so a forward reference is legal here; `cell-registrations.test.ts` is
 *      what proves the SHIPPED pointers actually resolve. Both halves are needed: this one
 *      alone would let a typo register, that one alone would make declaration order matter.
 */
describe('cell contract — pointers (P-006)', () => {
  const ruleOf = (spec: CellSpec) =>
    validateCellSpec(spec).filter((r) => r.axis === 'pointers').map((r) => r.rule);

  const ok = { cell: 'gate.greenCheckpoint.ownership', when: 'the streak is nonzero', answers: 'who owns the red' };

  it('ACCEPTS a well-formed pointer — including one whose target is not registered YET', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, cell: 'not.registered.anywhere' }] };
    expect(ruleOf(spec)).toEqual([]);
    // And it REGISTERS: a forward reference must not be a load-order failure.
    expect(() => registerCell({ ...spec, cell: 'ptr.forward' })).not.toThrow();
  });

  it('REFUSES a pointer at ITSELF — the emptiness axis 1 rejects, in a third field', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, cell: 'git.pipelinePosition' }] };
    expect(ruleOf(spec)).toContain('pointer-to-self');
  });

  it('REFUSES a self-pointer that differs only in case/punctuation', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, cell: 'Git.Pipeline_Position' }] };
    expect(ruleOf(spec)).toContain('pointer-to-self');
  });

  it('REFUSES the same target twice', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [ok, { ...ok, when: 'some other time' }] };
    expect(ruleOf(spec)).toContain('pointer-duplicate-target');
  });

  it('REFUSES a target-less pointer', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, cell: '   ' }] };
    expect(ruleOf(spec)).toContain('pointer-target-missing');
  });

  /**
   * `when` is the field that keeps an ALWAYS-EMITTED channel affordable: nothing
   * evaluates it, so if it is not legible in the line, a reader on the healthy path is
   * sent to look at ownership for no reason. That is why blank is a REFUSAL, not a warning.
   */
  it('REFUSES a pointer with no `when` — the condition is what a reader self-gates on', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, when: '  ' }] };
    expect(ruleOf(spec)).toContain('pointer-when-missing');
  });

  it('REFUSES a pointer with no `answers` — "see also X" costs a dispatch to evaluate', () => {
    const spec: CellSpec = { ...pipelineCell(), pointers: [{ ...ok, answers: '' }] };
    expect(ruleOf(spec)).toContain('pointer-answers-missing');
  });

  it('REFUSES a non-list', () => {
    const spec = { ...pipelineCell(), pointers: ok } as unknown as CellSpec;
    expect(ruleOf(spec)).toContain('pointers-not-a-list');
  });

  it('reports EVERY malformed pointer, not just the first — validate is total by contract', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      pointers: [
        { cell: 'a.one', when: '', answers: 'x' },
        { cell: 'b.two', when: 'y', answers: '' },
      ],
    };
    expect(ruleOf(spec)).toEqual(['pointer-when-missing', 'pointer-answers-missing']);
  });

  it('registration THROWS on a bad pointer, so a half-declared door is absent not live', () => {
    const spec: CellSpec = { ...pipelineCell(), cell: 'ptr.broken', pointers: [{ ...ok, when: '' }] };
    expect(() => registerCell(spec)).toThrow(CellRegistrationError);
    expect(getCell('ptr.broken', { ownerId: 'su-a' })).toBeUndefined();
  });

  /**
   * D-014's GUARD, and the only form it can take. "A pointer must not carry a second
   * measurement" is not a value a validator can check — it is a claim about the SHAPE of
   * `CellPointer`, which has no field/measurement/kills to carry a measurement in. This
   * asserts that shape stays closed: if someone widens it later, `@ts-expect-error`
   * stops erroring and this test fails at COMPILE time, which is the only moment the
   * property can actually be enforced.
   */
  it('CANNOT express a measurement — the type has nowhere to put one (D-014)', () => {
    const spec: CellSpec = {
      ...pipelineCell(),
      pointers: [
        {
          ...ok,
          // @ts-expect-error a pointer carries no measurement — that is the whole guard
          field: 'gate.ownership.holderSessionState',
        },
      ],
    };
    expect(ruleOf(spec)).toEqual([]);
  });
});

/**
 * P-005 — the operator-scope sentinel must not read as a literal harness name.
 *
 * THE BUG THIS PINS. `canReadCell`'s harness case was a bare
 * `reader.harnessSlug === v.ref`. An operator-scope session does not present a slug;
 * it presents `'*'`, assigned by `http-projection`'s `if (!spawnCtx.harnessSlug)`
 * fallback. So the scope meaning "every harness" compared equal to none of them, and
 * every harness-scoped cell read as `absent` for 418 distinct agents / 358,755 calls
 * in a measured 24h window — while `dev:pipeline_position` served those same agents
 * the identical values ungated and `stampStatePlane` silently dropped its whole
 * `plane` handle block (it shares this oracle).
 *
 * Each case below is a SEPARATE failure mode, and the two negative ones are why the
 * fix requires BOTH conditions rather than either alone.
 */
describe('P-005 — harness visibility and the operator-scope sentinel', () => {
  const OPERATOR_SCOPE = { ownerId: 'su-p005', roles: ['operator'], harnessSlug: '*' };

  it('admits an operator-scope reader ("*") to a harness-scoped cell', () => {
    // The regression itself: this returned false, which is what made the gate cells
    // unreadable and suppressed the plane block for essentially the whole fleet.
    expect(canReadCell(portCell(), OPERATOR_SCOPE)).toBe(true);
  });

  it('accepts the friendly "all" alias the canonical sentinel also accepts', () => {
    expect(canReadCell(portCell(), { ...OPERATOR_SCOPE, harnessSlug: 'all' })).toBe(true);
  });

  it('still admits a reader scoped to the cell\'s own concrete harness', () => {
    expect(
      canReadCell(portCell(), { ownerId: 'su-p005', roles: ['operator'], harnessSlug: 'papercusp' }),
    ).toBe(true);
  });

  it('FAILS CLOSED for a non-operator reader presenting the sentinel', () => {
    // The sentinel alone must never be sufficient: `'*'` is assigned by a bare
    // "harness is unset" fallback, so treating it as authority would be the
    // defaulted-audience failure D-016 names — an access default that fails OPEN.
    expect(canReadCell(portCell(), { ownerId: 'su-p005', roles: [], harnessSlug: '*' })).toBe(false);
    expect(
      canReadCell(portCell(), { ownerId: 'su-p005', roles: ['collaborator'], harnessSlug: '*' }),
    ).toBe(false);
  });

  it('FAILS CLOSED for an operator scoped to a DIFFERENT concrete harness', () => {
    // The role alone must never be sufficient either: `operator` sessions also run
    // scoped to sidestage / scout-runtime / engineering, and those have a pipeline of
    // their own to misread this one as — the hazard EI-20709429494940822 records.
    for (const harnessSlug of ['sidestage', 'scout-runtime', 'engineering']) {
      expect(canReadCell(portCell(), { ownerId: 'su-p005', roles: ['operator'], harnessSlug })).toBe(
        false,
      );
    }
  });

  it('does not widen any OTHER visibility kind', () => {
    // The sentinel is a harness-axis concept. An operator-scope reader must still be
    // refused an owner-scoped or work-item-scoped cell it has no claim to.
    const ownerScoped = { ...portCell(), visibility: { kind: 'owner', ref: 'su-someone-else' } as const };
    const itemScoped = { ...portCell(), visibility: { kind: 'work_item', ref: 'WI-999' } as const };
    expect(canReadCell(ownerScoped, OPERATOR_SCOPE)).toBe(false);
    expect(canReadCell(itemScoped, OPERATOR_SCOPE)).toBe(false);
  });
});
