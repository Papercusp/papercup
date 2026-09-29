import { describe, expect, it } from 'vitest';
import { linuxPgrpFromProcStat, readProcessGroupId } from './process-identity';

describe('linuxPgrpFromProcStat (EI-24635523980082322)', () => {
  it('reads field 5 past a comm that contains spaces and a closing paren', () => {
    // pid (comm) state ppid pgrp session …
    const stat = '68752 (bash -lc (x) y) S 1 68752 68752 0 -1 4194560 1103 0 0 0';
    expect(linuxPgrpFromProcStat(stat)).toBe(68752);
  });

  it('distinguishes the group from the ppid', () => {
    expect(linuxPgrpFromProcStat('4101 (claude) S 4100 4000 4000 0 -1')).toBe(4000);
  });

  it('returns null for a kernel thread (pgrp 0) and for garbage', () => {
    expect(linuxPgrpFromProcStat('88 (kworker/1:1) I 2 0 0 0 -1')).toBeNull();
    expect(linuxPgrpFromProcStat('no parens here')).toBeNull();
    expect(linuxPgrpFromProcStat('12 (x) S 1')).toBeNull();
  });
});

describe('readProcessGroupId', () => {
  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reads a real positive group id for this process (positive control)',
    () => {
      const pgid = readProcessGroupId(process.pid);
      expect(pgid).not.toBeNull();
      expect(pgid!).toBeGreaterThan(0);
    },
  );

  it('fails closed on an invalid pid', () => {
    expect(readProcessGroupId(0)).toBeNull();
    expect(readProcessGroupId(-5)).toBeNull();
  });
});
