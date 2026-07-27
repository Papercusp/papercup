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

/** `git-pipeline-position` — falsifier is a different SUBJECT (change vs mechanism). */
const pipelineCell = (): CellSpec => ({
  cell: 'git.pipelinePosition',
  owner: 'su-28464',
  headline: 'positions.onStaging',
  falsifier: {
    field: 'stages[].health',
    measurement: "the git-sync routine's own error ticks and last-tick age",
    kills: 'not-past reads as "wait" when the leg is actually dead and waiting is futile',
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

/** `session.state` — falsifier is a DERIVATION LEVEL (raw leg vs verdict). */
const sessionCell = (): CellSpec => ({
  cell: 'session.state',
  owner: 'presence-derivation-unification-2026-07-17',
  headline: 'heartbeatFresh',
  falsifier: {
    field: 'sessionState',
    measurement: 'wakeability + recorded-session + pid probe + hardStale legs',
    kills: 'a fresh heartbeat reads as "working" when the session is warm-dead',
  },
  nullable: true,
  unknownHoist: 'subjectsWithoutSignal',
  callerRelativity: { kind: 'global' },
  visibility: { kind: 'workspace' },
  federation: { kind: 'shareable' },
  provenance: {
    obtainedBy: 'resolveSessionStates over coord_presence + event_awaits + adv_sessions',
    liveExercised: true,
    evidence: 'liveness-parity.test.ts asserts cross-surface parity against real derivation',
  },
  resolver: 'packages/operator-core/lib/agent-tools/coordination/liveness-oracle.ts#resolveSessionStates',
  changeSignal: { kind: 'event', key: 'coord:presence-changed' },
  shape: 'Map<ownerId, SessionState>',
});

/** `port.listener` — falsifier is EXISTENCE, and relativity is AMBIENT. */
const portCell = (): CellSpec => ({
  cell: 'port.listener',
  owner: 'papercusp',
  headline: 'pid',
  falsifier: {
    field: 'ownerVisible',
    measurement: 'whether the kernel disclosed the socket owner to this uid',
    kills: 'pid:null reads as "nothing bound" when the port IS bound by another user',
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

  it('ACCEPTS workspace-visible + shareable, and any visibility + local', () => {
    expect(validateCellSpec(sessionCell())).toEqual([]); // workspace + shareable
    expect(validateCellSpec(portCell())).toEqual([]); // harness-narrow + local
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

describe('axis 1 — the falsifier cannot be the headline wearing a hat', () => {
  it('refuses a falsifier that IS the headline', () => {
    const spec = { ...pipelineCell(), falsifier: { ...pipelineCell().falsifier, field: 'positions.onStaging' } };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('falsifier-is-headline');
  });

  // The whole point of axis 1: a cell that "declares health" by re-projecting its
  // own position is a confident wrong answer wearing the contract's badge.
  it('refuses a falsifier DERIVED from the headline rather than independently measured', () => {
    const spec = {
      ...pipelineCell(),
      falsifier: { ...pipelineCell().falsifier, measurement: 'computed from positions.onStaging' },
    };
    const r = validateCellSpec(spec);
    expect(r.map((x) => x.rule)).toContain('falsifier-derived-from-headline');
    expect(r[0].axis).toBe(1);
  });

  it('refuses an incomplete falsifier', () => {
    const spec = { ...sessionCell(), falsifier: { field: 'sessionState', measurement: '  ', kills: '' } };
    expect(validateCellSpec(spec).map((r) => r.rule)).toContain('falsifier-incomplete');
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
    expect(validateCellSpec({ ...sessionCell(), nullable: false, unknownHoist: undefined })).toEqual([]);
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
    expect(listCells()).toHaveLength(1);
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
      falsifier: { field: 'heartbeatFresh', measurement: 'heartbeatFresh', kills: 'x' },
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
    expect([...axes].sort()).toEqual([1, 2, 4, 5]);
    expect(getCell('session.state')).toBeUndefined();
  });
});
