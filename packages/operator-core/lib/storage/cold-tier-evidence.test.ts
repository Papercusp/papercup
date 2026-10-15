import { describe, expect, it, vi } from 'vitest';
import { assessColdMounts, assessColdMoves, measureColdMounts, parseColdMounts,
  COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY, type ColdMountObservation } from './cold-tier-evidence';
import { DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY } from './retention-interval-evidence';
import { getRegisteredInstrument } from '../rubric-instrument-registry';

const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h)).toISOString();
const uuid = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const current = (): ColdMountObservation => ({ host: 'fixture-host', bootId: uuid[1]!, at: at(10), mounts: [
  { path: '/mnt/cold-a', source: '/dev/sda2', uuidSource: '/dev/sda2', uuid: uuid[0]!, type: 'xfs', nofail: true },
  { path: '/mnt/cold-b', source: '/dev/sdb3', uuidSource: '/dev/sdb3', uuid: uuid[1]!, type: 'xfs', nofail: true },
] });
const previous = () => ({ ...current(), bootId: uuid[0]!, at: at(1) });

describe('native cold mount evidence', () => {
  it('parses exact kernel mounts and unique UUID/nofail fstab entries', () => {
    const kernel = '1 0 8:2 / /mnt/cold-a rw - xfs /dev/sda2 rw\n2 0 8:19 / /mnt/cold-b rw - xfs /dev/sdb3 rw';
    const fstab = `UUID=${uuid[0]} /mnt/cold-a xfs defaults,nofail 0 2\nUUID=${uuid[1]} /mnt/cold-b xfs nofail 0 2`;
    expect(parseColdMounts(kernel, fstab)).toMatchObject(current().mounts.map(({ uuidSource, ...m }) => m));
    expect(parseColdMounts(kernel, fstab + '\n/dev/sdb3 /mnt/cold-b xfs nofail 0 2')[1]!.uuid).toBe('');
  });
  it('requires a real same-host boot transition with stable volume identities', () => {
    expect(assessColdMounts(current(), previous()).verdict).toBe('pass');
    for (const witness of [null, current(), { ...previous(), host: 'other' }, { ...previous(), at: at(11) }]) {
      expect(assessColdMounts(current(), witness).verdict).toBe('unknown');
    }
    const changed = current(); changed.mounts[0]!.uuid = uuid[1]!;
    expect(assessColdMounts(changed, previous()).verdict).toBe('fail');
  });
  it.each(['nofail', 'type', 'source', 'uuidSource', 'uuid'] as const)('rejects a bad %s even when a previous boot was good', field => {
    const now = current(); Object.assign(now.mounts[0]!, { [field]: field === 'nofail' ? false : '' });
    expect(assessColdMounts(now, previous()).verdict).toBe('fail');
  });
  it('retains native boot observations in the existing workspace/host audit seam', async () => {
    const unsafe = vi.fn().mockResolvedValueOnce([{ details: previous() }]).mockResolvedValueOnce([]);
    expect((await measureColdMounts({ unsafe } as never, 'workspace', async () => current())).verdict).toBe('pass');
    expect(unsafe.mock.calls[0]![1]).toEqual(['workspace', 'storage:cold-mount-observation', 'fixture-host', uuid[1], Date.parse(at(10))]);
    expect(unsafe.mock.calls[1]![0]).toContain('WHERE NOT EXISTS');
  });
  it('registers executable platform checks on the maintained rescore seam', () => {
    for (const key of [COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY, DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY]) {
      expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', rescore: { scope: 'harness', resolve: expect.any(Function) } });
    }
  });
});

const moves = () => ['kopia-repo', 'papercusp-backups', 'Debug'].map(name => {
  const destination = name === 'Debug' ? `/mnt/cold-b/${name}` : name === 'kopia-repo' ? '/mnt/cold-a/Backup/kopia-repo' : `/mnt/cold-a/${name}`;
  return { name, source: `/mnt/data/${name}`, destination, repointed: true, asideAbsent: true,
    log: `${at(1)} COPY ${name}\n${at(2)} VERIFY1 ${name} entries src=2 dst=2 bytes src=100 dst=100\n${at(3)} VERIFY2 ${name} entries src=2 dst=2 bytes src=100 dst=100\n${at(4)} DONE ${name} -> ${destination} (source removed, symlink left)` };
});
const backup = () => ({ repositoryPath: '/mnt/cold-a/Backup/kopia-repo', host: 'host', snapshotHost: 'host',
  snapshotId: 'native-snapshot', startedAt: at(5), finishedAt: at(6), complete: true });
describe('verified cold bulk cutover', () => {
  it('requires each move and an actual post-cutover backup from the moved repository', () => {
    expect(assessColdMoves(moves(), backup(), at(8)).verdict).toBe('pass');
    expect(assessColdMoves(moves().slice(0, 2), backup(), at(8)).verdict).toBe('unknown');
    for (const bad of [null, { ...backup(), startedAt: at(3) }, { ...backup(), snapshotHost: 'remote' },
      { ...backup(), complete: false }, { ...backup(), repositoryPath: '/mnt/data/Backup/kopia-repo' }]) {
      expect(assessColdMoves(moves(), bad, at(8)).verdict).toBe('unknown');
    }
  });
  it('catches middle verification mismatch, missing verification and wrong DONE destination', () => {
    for (const edit of [(s: string) => s.replace('bytes src=100 dst=100', 'bytes src=100 dst=99'),
      (s: string) => s.replace(/^.* VERIFY1 .*\n/m, ''), (s: string) => s.replace(' -> /mnt/cold-a/Backup/kopia-repo', ' -> /wrong')]) {
      const input = moves(); input[0]!.log = edit(input[0]!.log);
      expect(assessColdMoves(input, backup(), at(8)).verdict).toBe('fail');
    }
  });
  it('does not borrow another directory proof, stale success, symlink or failed removal', () => {
    const input = moves(); input[0]!.log = input[1]!.log;
    expect(assessColdMoves(input, backup(), at(8)).verdict).toBe('unknown');
    const retried = moves(); retried[0]!.log += `\n${at(7)} COPY kopia-repo`;
    expect(assessColdMoves(retried, backup(), at(8)).verdict).toBe('unknown');
    for (const field of ['repointed', 'asideAbsent'] as const) {
      const bad = moves(); bad[0]![field] = false;
      expect(assessColdMoves(bad, backup(), at(8)).verdict).toBe('fail');
    }
  });
});
