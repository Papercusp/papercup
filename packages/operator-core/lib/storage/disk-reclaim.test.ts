import { describe, expect, it } from 'vitest';
import { compilePolicy, type RetentionClass } from './retention-policy';
import { selectRetentionEntries, type RetentionEntry } from './disk-reclaim';

const HOUR = 3_600_000;
const now = 1000 * HOUR;
const policy: RetentionClass[] = [
  { id: 'scratch', title: 'scratch', origin: 'agent', roots: ['/scratch'], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'dumps', title: 'dumps', origin: 'agent', roots: ['/dumps'], keep: { kind: 'newest', keep: 1 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'protected', title: 'protected', origin: 'owner', roots: ['/scratch/owner'], keep: { kind: 'keep', reason: 'owner data' }, enforcers: [{ kind: 'none' }] },
  { id: 'leased', title: 'leased', origin: 'agent', roots: ['/leased'], keep: { kind: 'lease', record: 'live session', graceHours: 1 }, enforcers: [{ kind: 'standing-reclaim', via: 'owning-program' }] },
];
const compiled = compilePolicy(policy, '/home/test');
const entry = (path: string, classId: string, ageHours: number): RetentionEntry => ({ path, root: path.slice(0, path.lastIndexOf('/')), classId, newestWriteMs: now - ageHours * HOUR, bytes: 100, dev: 1, ino: 1 });

describe('scheduled retention selection', () => {
  it('expires only stale entries, oldest first, without a disk-pressure input', () => {
    const selected = selectRetentionEntries([entry('/scratch/new', 'scratch', 1), entry('/scratch/old', 'scratch', 25), entry('/scratch/older', 'scratch', 48)], compiled, now);
    expect(selected.map((e) => e.path)).toEqual(['/scratch/older', '/scratch/old']);
  });
  it('keeps the newest backup per root even when the entire group is old', () => {
    expect(selectRetentionEntries([entry('/dumps/newest', 'dumps', 90), entry('/dumps/old', 'dumps', 100)], compiled, now).map((e) => e.path)).toEqual(['/dumps/old']);
  });
  it('never selects an owner subtree, root, unmatched path or lease from age alone', () => {
    expect(selectRetentionEntries([entry('/scratch/owner/data', 'scratch', 90), entry('/scratch', 'scratch', 90), entry('/other/file', 'scratch', 90), entry('/leased/run', 'leased', 90)], compiled, now)).toEqual([]);
  });
  it('fails closed when the declared class differs from the authoritative selector', () => {
    expect(selectRetentionEntries([entry('/dumps/old', 'scratch', 90)], compiled, now)).toEqual([]);
  });
});
