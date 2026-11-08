import { describe, expect, it, vi } from 'vitest';
import type { FrozenCandidateRepairQueue } from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import type { AdmissionOutcome } from '@papercusp/operator-core/lib/release/repair-head-admission';
import { genCheckHealTransition, type GenCheckHealIo } from './green-checkpoint-gen-check-self-heal';
import { healGeneratedRepair, SELECTIVE_DECLARATION_OUTPUT as OUTPUT, type GeneratedRepairRuntime } from './heal-generated-repair';

// The protocol is real; only the costly checkout/process boundary is replaced.
vi.mock('./green-checkpoint', () => ({}));
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const queue = { schemaVersion: 3, candidate: HEAD, repairHead: HEAD, updatedAtMs: 1,
  phase: 'awaiting-fixer', admissions: [], failingTests: ['lint:tsc'] } as unknown as FrozenCandidateRepairQueue;

function fixture(options: { fresh?: boolean; writerFails?: boolean; recheckFails?: boolean; outside?: boolean } = {}) {
  let wrote = false;
  const commands: Array<[string, readonly string[] | undefined]> = [];
  const release = vi.fn();
  const build = vi.fn(async () => 'c'.repeat(40));
  const admit = vi.fn(async (input) => ({ ok: true, commit: NEXT, tree: 'd'.repeat(40), entry: {
    fromRepairHead: HEAD, toRepairHead: NEXT, paths: input.paths, actor: input.actor, atMs: 2,
    source: { ref: input.source.ref, sha: input.source.ref }, reason: input.reason,
  } }) as AdmissionOutcome);
  const readQueue = vi.fn(async () => queue);
  const record = vi.fn(async () => true);
  const io: GenCheckHealIo = {
    runScript: async (script, args) => {
      commands.push([script, args]);
      if (script === 'gen:declarations') {
        wrote = true;
        return { code: options.writerFails ? 1 : 0, tail: 'writer' };
      }
      return { code: options.fresh || (wrote && !options.recheckFails) ? 0 : 1, tail: 'checker' };
    },
    dirtyPaths: async () => wrote ? [OUTPUT, ...(options.outside ? ['generator-input.ts'] : [])] : [],
    buildSourceCommit: build, admit, log: () => {},
  };
  const setup = vi.fn(async () => {});
  const runtime: GeneratedRepairRuntime = { acquire: () => ({ acquired: true, release }), setup, io: () => io };
  const input = { integrationRoot: '/isolated', queue, readQueue, admit, record };
  return { input, runtime, commands, release, build, admit, readQueue, record, setup };
}

describe('explicit selected generated repair', () => {
  it('measures failure, runs the selected writer/check, admits only the declaration and records under the lock', async () => {
    const f = fixture();
    f.input.record = vi.fn(async () => { expect(f.release).not.toHaveBeenCalled(); return true; });
    const result = await healGeneratedRepair(f.input, f.runtime);
    expect(result).toMatchObject({ kind: 'healed', persisted: true, fromRepairHead: HEAD, toRepairHead: NEXT, paths: [OUTPUT] });
    expect(f.commands.map(([script]) => script)).toEqual(['gen:declarations:check', 'gen:declarations', 'gen:declarations:check']);
    expect(f.commands.every(([, args]) => args?.[0] === '--files=apps/operator/scripts/tool-delivery.generated.mjs')).toBe(true);
    expect(f.build).toHaveBeenCalledWith(HEAD, [OUTPUT]);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('a passing check performs no writer, source build, admission or queue write', async () => {
    const f = fixture({ fresh: true });
    expect(await healGeneratedRepair(f.input, f.runtime)).toEqual({ kind: 'already-fresh' });
    expect(f.commands).toHaveLength(1);
    expect(f.build).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it.each([{ writerFails: true, kind: 'regeneration-failed' }, { recheckFails: true, kind: 'recheck-failed' },
    { outside: true, kind: 'probe-failed' }])('leaves the queue untouched for $kind', async (options) => {
    const f = fixture(options);
    expect(await healGeneratedRepair(f.input, f.runtime)).toMatchObject({ kind: options.kind });
    expect(f.build).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('does not materialize when another run holds the checkpoint lock', async () => {
    const f = fixture(); f.runtime.acquire = () => ({ acquired: false });
    expect(await healGeneratedRepair(f.input, f.runtime)).toMatchObject({ reason: 'checkpoint-run-lock-held' });
    expect(f.setup).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });
  it('refuses a changed queue before materialization', async () => {
    const f = fixture(); f.readQueue.mockResolvedValue({ ...queue, updatedAtMs: 3 });
    expect(await healGeneratedRepair(f.input, f.runtime)).toMatchObject({ reason: 'exact_queue_identity_mismatch' });
    expect(f.setup).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it('does not publish a generator measured before a concurrent admission', async () => {
    const f = fixture(); f.readQueue.mockResolvedValueOnce(queue).mockResolvedValue({ ...queue, repairHead: NEXT });
    expect(await healGeneratedRepair(f.input, f.runtime)).toMatchObject({ kind: 'admission-refused' });
    expect(f.admit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it('preserves an independently moved queue in the existing CAS reducer', async () => {
    const f = fixture(); const healed = await healGeneratedRepair(f.input, f.runtime);
    if (healed.kind !== 'healed') throw new Error('fixture must heal');
    const moved = { ...queue, repairHead: 'e'.repeat(40) };
    expect(genCheckHealTransition(moved, queue, healed)).toBe(moved);
  });
  it('releases the run lock if materialization fails', async () => {
    const f = fixture(); f.setup.mockRejectedValue(new Error('setup failed'));
    await expect(healGeneratedRepair(f.input, f.runtime)).rejects.toThrow('setup failed');
    expect(f.release).toHaveBeenCalledOnce(); expect(f.admit).not.toHaveBeenCalled();
  });
});
