/**
 * WI-38266 — A CELL MUST NOT BLAME ITS RESOLVER FOR WHAT THE DOOR ATE.
 *
 * The bug, measured end-to-end on `deploy.3070.sha` before this suite existed:
 *
 *   1. `gitPipelinePosition()` emitted BOTH declared paths correctly, each carrying an
 *      enumerated reason — `serving.unknownReason = { code:'not-applicable', detail:'No
 *      path was given (sha-only probe), so no serving process can be identified.' }` and
 *      a non-empty `verdictUnknown[]`.
 *   2. `dev:pipeline_position` bounded its own response to fit
 *      `PIPELINE_POSITION_RESPONSE_BUDGET_CHARS`, dropping both.
 *   3. `readCell` — which dispatches the TOOL, so it walks the SHAPED payload — reported
 *      `drifted: true`, whose prose tells the agent to read it "as a registration defect
 *      in the resolver".
 *
 * So a correct, fully-explained measurement was rendered as a code bug in a blameless
 * resolver, and `serving.startedSinceCodeChange` — the falsifier CLAUDE.md names as the
 * ONLY way to separate "deployed sha X" from "the process is EXECUTING X" — silently
 * stopped arriving on every read of the cell built to kill that exact misreading.
 *
 * ── FALSIFIABILITY (CLAUDE.md's tiering) ─────────────────────────────────────────────
 * The subject is a MODULE we `import`, so falsifiability is bought with permanent
 * CONTROLS in this file — never by mutating the shared tree (a mutation probe here would
 * be committable by the git-sync sweep even if nothing went wrong). Two kinds appear
 * below and both are load-bearing:
 *
 *   • DRIFT CONTROLS — a genuinely missing field with NO truncation marker must still
 *     report `drifted`. Without these, "always report truncatedByDoor" would pass every
 *     other test in this file while destroying the real signal.
 *   • CALIBRATION — the drift prose must still say "registration defect". Without it the
 *     controls above would also pass if the prose branch were deleted entirely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    // Only the DISPATCH is faked. `valueAtPath`, the own-key falsifier walk and the
    // hoist/drift classification are all the REAL ones — this suite is about them.
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { CELL_READ_SPAWN_ID, formatCellHoist, readCell } from './cell-read';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from './cell-registry';
import { shapePipelinePosition } from './agent-tools/dev/pipeline_position';
import type { PipelinePosition } from './git-pipeline-position';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };

/** A registrable spec shaped like the real DEPLOYED_SHA_CELL — same headline, same
 *  falsifier field, same hoist — so this suite exercises the cell that actually broke. */
function deployedShaLikeSpec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.deployedSha',
    owner: 'test',
    headline: 'deployedSha',
    falsifier: {
      field: 'serving.startedSinceCodeChange',
      measurement: 'a live systemd start-time probe compared against when the code last changed',
      kills: '"deployed sha X" read as "the process is EXECUTING X"',
    },
    nullable: true,
    unknownHoist: 'verdictUnknown',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'release-checkout HEAD', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'deployedSha' },
    shape: '{ deployedSha, serving, verdictUnknown[] }',
    ...over,
  };
}

/** The shape a bounding door actually returns — headline survives, periphery is gone,
 *  and the payload SAYS SO. Modelled on the live `dev:pipeline_position` reply. */
const TRUNCATED_PAYLOAD = {
  deployedSha: '8779b1c7f2885274b57ad0ffc30359f35aa75d62',
  projection: {
    kind: 'bounded',
    truncated: true,
    originalChars: 16035,
    returnedChars: 2505,
    omittedFields: ['repoRoot', 'verdictUnknown', 'runtime', 'runtimes'],
    fullRead: { tool: 'dev:pipeline_position', args: {} },
  },
};

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
});

describe('WI-38266: a truncated payload makes an absence UNATTRIBUTABLE, not the resolver’s fault', () => {
  it('the HOIST reports truncatedByDoor — never drifted — and carries the re-read lever', async () => {
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue(TRUNCATED_PAYLOAD);

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.unknownHoist?.truncatedByDoor).toBe(true);
    // The whole point: the OLD verdict must not also be present. `drifted` is what the
    // prose keys on to accuse the resolver.
    expect(r.unknownHoist?.drifted).toBeUndefined();
    expect(r.unknownHoist?.fullRead).toEqual({ tool: 'dev:pipeline_position', args: {} });
  });

  it('the FALSIFIER reports truncatedByDoor — so the headline reads as UNFALSIFIED, not confirmed', async () => {
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue(TRUNCATED_PAYLOAD);

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.falsifier?.truncatedByDoor).toBe(true);
    expect(r.falsifier?.drifted).toBeUndefined();
    // `kills` must survive: a reader who lost the measurement still has to be told which
    // false reading is now un-killed.
    expect(r.falsifier?.kills).toContain('EXECUTING');
  });

  it('the PROSE stops accusing the resolver and names the re-read instead', () => {
    const line = formatCellHoist({
      key: 'verdictUnknown',
      value: null,
      truncatedByDoor: true,
      fullRead: { tool: 'dev:pipeline_position', args: {} },
    });

    expect(line).not.toContain('registration defect');
    expect(line).not.toContain('did not emit');
    expect(line).toContain('UNATTRIBUTABLE');
    expect(line).toContain('dev:pipeline_position');
  });

  /**
   * The live payload dropped `serving` WITHOUT listing it in `omittedFields` (that list
   * is computed against one shaping tier, so it under-reports exactly when the shaping
   * was most aggressive). Keying on the list instead of the truncation flag would
   * reintroduce the same false-blame bug one level down — this pins the sound rule.
   */
  it('truncation ALONE decides it — a field missing from omittedFields is still unattributable', async () => {
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue({
      ...TRUNCATED_PAYLOAD,
      projection: { ...TRUNCATED_PAYLOAD.projection, omittedFields: ['repoRoot'] },
    });

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    // `serving` is named nowhere in omittedFields, yet must NOT be blamed on the resolver.
    expect(r.falsifier?.truncatedByDoor).toBe(true);
    expect(r.falsifier?.drifted).toBeUndefined();
  });
});

describe('WI-38266 CONTROLS — real drift must still be reported as drift', () => {
  it('DRIFT CONTROL: no truncation marker + a missing field ⇒ drifted, exactly as before', async () => {
    registerCell(deployedShaLikeSpec());
    // A resolver that genuinely forgot to emit either channel. No `projection` at all.
    dispatchReadOnlyTool.mockResolvedValue({ deployedSha: 'abc123' });

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.unknownHoist?.drifted).toBe(true);
    expect(r.unknownHoist?.truncatedByDoor).toBeUndefined();
    expect(r.falsifier?.drifted).toBe(true);
    expect(r.falsifier?.truncatedByDoor).toBeUndefined();
  });

  it('DRIFT CONTROL: projection present but truncated:false ⇒ still drifted', async () => {
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue({
      deployedSha: 'abc123',
      projection: { kind: 'bounded', truncated: false },
    });

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.unknownHoist?.drifted).toBe(true);
    expect(r.unknownHoist?.truncatedByDoor).toBeUndefined();
  });

  it('a MEASURED empty is neither — an empty verdictUnknown[] is a real negative result', async () => {
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue({
      deployedSha: 'abc123',
      verdictUnknown: [],
      serving: { startedSinceCodeChange: true },
      projection: { kind: 'bounded', truncated: true, fullRead: { tool: 'dev:pipeline_position', args: {} } },
    });

    const r = await readCell('test.deployedSha', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    // Present in the payload ⇒ the truncation marker is irrelevant; these are measurements.
    expect(r.unknownHoist?.value).toEqual([]);
    expect(r.unknownHoist?.drifted).toBeUndefined();
    expect(r.unknownHoist?.truncatedByDoor).toBeUndefined();
    expect(r.falsifier?.value).toBe(true);
    expect(r.falsifier?.truncatedByDoor).toBeUndefined();
  });

  it('CALIBRATION: the drift prose still names a registration defect', () => {
    // Without this, the controls above would also pass if the drift branch were deleted.
    const line = formatCellHoist({ key: 'verdictUnknown', value: null, drifted: true });
    expect(line).toContain('registration defect');
  });
});

describe('WI-38266: the door does not shape the payload it hands the CELL READER', () => {
  /** Big enough to blow the 5,000-char budget, so shaping is genuinely exercised. */
  function bulkyResult(): PipelinePosition {
    return {
      deployedSha: '8779b1c7f2885274b57ad0ffc30359f35aa75d62',
      verdictUnknown: [
        { leg: 'changeInCandidate.judgingSha', unknown: { code: 'not-applicable', detail: 'x'.repeat(400) } },
      ],
      serving: { startedSinceCodeChange: null, unknownReason: { code: 'not-applicable', detail: 'y'.repeat(400) } },
      repoRoot: 'r'.repeat(3000),
      notes: Array.from({ length: 40 }, (_, i) => `note ${i} ${'n'.repeat(200)}`),
      runtimes: Array.from({ length: 20 }, () => ({ host: 'h'.repeat(200) })),
    } as unknown as PipelinePosition;
  }

  it('unbounded:true returns the payload whole — including the fields the budget drops', () => {
    const shaped = shapePipelinePosition(bulkyResult(), {}, {}, { unbounded: true }) as Record<string, unknown>;

    expect(shaped.verdictUnknown).toBeDefined();
    expect(shaped.serving).toBeDefined();
    // No truncation marker, because nothing was truncated.
    expect(shaped.projection).toBeUndefined();
  });

  it('SHAPING CONTROL: without the flag the budget still applies and still announces itself', () => {
    // Proves the exemption is what changed the outcome — not that the budget stopped
    // working, which would make the test above vacuous.
    const shaped = shapePipelinePosition(bulkyResult(), {}, {}) as Record<string, unknown>;

    const projection = shaped.projection as Record<string, unknown> | undefined;
    expect(projection?.truncated).toBe(true);
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(6000);
  });

  it('readCell dispatches under the shared spawn id the door keys its exemption on', async () => {
    // Pins the TAG. The door imports this same constant, so a rename cannot silently
    // put the two back out of sync (which would restore the original bug in full).
    registerCell(deployedShaLikeSpec());
    dispatchReadOnlyTool.mockResolvedValue({ deployedSha: 'abc123' });

    await readCell('test.deployedSha', READER, ENV);

    expect(dispatchReadOnlyTool).toHaveBeenCalledWith(
      'dev:pipeline_position',
      {},
      expect.objectContaining({ spawnId: CELL_READ_SPAWN_ID }),
    );
  });
});
