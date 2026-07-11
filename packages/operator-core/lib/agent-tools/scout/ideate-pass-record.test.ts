/**
 * blender:ideate-pass-record (su-ideate-learning-substrate-2026-07-10 P-010).
 * Pins the su-pass → tick mapping:
 *  - a status='ran', origin='su-ideate' tick attributed to the caller's ownerId
 *    (detail.owner), with ideasFiled → ideas_routed and observationsMined →
 *    ideas_generated;
 *  - observationsMined omitted ⇒ ideas_generated 0 and absent from the result;
 *  - notes trimmed onto detail (blank/whitespace dropped);
 *  - install_slug from ctx.harnessSlug, defaulting 'papercusp' for a missing / '*';
 *  - the args schema (ideasFiled required non-negative int; strict).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordScoutTickInput } from '../../scout/tick-ledger';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  ideatePassRecordArgs,
  runIdeatePassRecord,
  toToolResult,
  type IdeatePassRecordDeps,
} from './ideate-pass-record';

vi.mock('../coordination/identity');
const mockIdentity = vi.mocked(resolveAgentIdentity);

function identity(ownerId = 'su-caller') {
  return {
    ownerId,
    ownerLabel: `su · ${ownerId}`,
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

/** A deps double: recordTick is a spy; any `over` REPLACES it so the returned
 *  handle is the one the core calls. */
function makeDeps(over: Partial<IdeatePassRecordDeps> = {}) {
  const recordTick = over.recordTick ?? vi.fn(async (_input: RecordScoutTickInput) => undefined);
  return { deps: { recordTick } as IdeatePassRecordDeps, recordTick };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentity.mockReturnValue(identity());
});

describe('runIdeatePassRecord', () => {
  it("writes a 'ran'/'su-ideate' tick with the pass yield mapped and the caller attributed", async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord(
      { ideasFiled: 3, observationsMined: 11, notes: 'mined the routed-idea corpus' },
      { harnessSlug: 'papercusp' },
      deps,
    );

    expect(recordTick).toHaveBeenCalledWith({
      status: 'ran',
      origin: 'su-ideate',
      installSlug: 'papercusp',
      ideasRouted: 3, // ideasFiled → ideas_routed
      ideasGenerated: 11, // observationsMined → ideas_generated
      detail: { owner: 'su-caller', notes: 'mined the routed-idea corpus' },
    });
    expect(out).toEqual({
      ok: true,
      origin: 'su-ideate',
      status: 'ran',
      ideasFiled: 3,
      observationsMined: 11,
      notes: 'mined the routed-idea corpus',
      owner: 'su-caller',
      installSlug: 'papercusp',
    });
  });

  it('defaults ideas_generated to 0 and omits observationsMined from the result when not given', async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord({ ideasFiled: 1 }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledWith(
      expect.objectContaining({ ideasGenerated: 0, ideasRouted: 1, detail: { owner: 'su-caller' } }),
    );
    expect(out).not.toHaveProperty('observationsMined');
    expect(out).not.toHaveProperty('notes');
  });

  it('drops blank/whitespace notes (neither on detail nor in the result)', async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord({ ideasFiled: 2, notes: '   ' }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ detail: { owner: 'su-caller' } }));
    expect(out).not.toHaveProperty('notes');
  });

  it("derives install_slug from ctx.harnessSlug and defaults 'papercusp' for a missing / '*' harness", async () => {
    const { deps, recordTick } = makeDeps();
    await runIdeatePassRecord({ ideasFiled: 0 }, { harnessSlug: 'my-harness' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'my-harness' }));

    recordTick.mockClear();
    await runIdeatePassRecord({ ideasFiled: 0 }, {}, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }));

    recordTick.mockClear();
    await runIdeatePassRecord({ ideasFiled: 0 }, { harnessSlug: '*' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }));
  });
});

describe('ideatePassRecordArgs (schema)', () => {
  it('requires a non-negative integer ideasFiled and is strict', () => {
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 4 }).success).toBe(true);
    expect(ideatePassRecordArgs.safeParse({}).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: -1 }).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 1.5 }).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 1, bogus: true }).success).toBe(false);
  });

  it('accepts optional observationsMined + notes', () => {
    const parsed = ideatePassRecordArgs.safeParse({ ideasFiled: 2, observationsMined: 9, notes: 'x' });
    expect(parsed.success).toBe(true);
  });
});

describe('toToolResult', () => {
  it('wraps an ok result with no isError flag', () => {
    const env = toToolResult({
      ok: true,
      origin: 'su-ideate',
      status: 'ran',
      ideasFiled: 1,
      owner: 'su-caller',
      installSlug: 'papercusp',
    });
    expect(env.isError).toBeUndefined();
    expect(JSON.parse(env.content[0].text)).toMatchObject({ ok: true, origin: 'su-ideate' });
  });
});
