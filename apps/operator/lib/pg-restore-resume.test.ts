import { describe, expect, it } from 'vitest';
import { planPgRestoreResume } from '../../../scripts/backup/pg-restore-resume.mjs';

const toc = `;     Dumped by pg_dump version: 18.3
1; 1 1 TABLE public canary postgres
2; 0 1 TABLE DATA public canary postgres
3; 1 2 INDEX public canary_idx postgres
4; 0 2 TABLE DATA public waiting postgres
5; 0 0 ACL public TABLE canary postgres
`;
const log = `pg_restore: processing item 9 ENCODING ENCODING
pg_restore: processing item 1 TABLE canary
pg_restore: entering main parallel loop
pg_restore: launching item 2 TABLE DATA canary
pg_restore: finished item 2 TABLE DATA canary
pg_restore: launching item 3 INDEX canary_idx
`;
const plan = (override = {}) => planPgRestoreResume({ toc, log, exitOnError: true, interrupted: true, ...override });

describe('interrupted strict native restore resume list', () => {
  it('preserves completed data and schedules untouched data, the interrupted index and final ACL', () => {
    const result = plan();
    expect(result.completedIds).toEqual([1, 2]);
    expect(result.remainingIds).toEqual([3, 4, 5]);
    expect(result.inFlightIds).toEqual([3]);
    expect(result.remainingList.split('\n').filter(line => /^\d+;/.test(line))).toEqual([
      '3; 1 2 INDEX public canary_idx postgres',
      '4; 0 2 TABLE DATA public waiting postgres',
      '5; 0 0 ACL public TABLE canary postgres',
    ]);
    expect(result.tocSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.logSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('recovers doubled and concatenated worker prefixes without replaying completed data', () => {
    const interleaved = log.replace('pg_restore: finished item 2', 'pg_restore: pg_restore: finished item 2')
      .replace('\npg_restore: launching item 3', 'pg_restore: launching item 3');
    expect(plan({ log: interleaved }).completedIds).toEqual([1, 2]);
    expect(plan({ log: interleaved }).inFlightIds).toEqual([3]);
    expect(() => plan({ log: interleaved + 'pg_restore: pg_restore: error: failed\n' })).toThrow('native error');
  });

  it.each([
    { exitOnError: false }, { interrupted: false },
    { toc: toc.replace('18.3', '17.6') },
    { log: log + 'pg_restore: error: worker process failed\n' },
    { log: log + 'ERROR: index failed\n' },
    { log: log.replace('entering main parallel loop', 'unknown transition') },
    { log: log + 'pg_restore: entering main parallel loop\n' },
    { log: log + 'pg_restore: finished main parallel loop\n' },
    { log: log.replace('launching item 3 INDEX', 'launching item 4 TABLE DATA') },
    { log: log.replace('finished item 2', 'finished item 77') },
    { log: log.replace('processing item 1', 'processing item 77') },
    { log: log + 'pg_restore: launching item 3 INDEX canary_idx\n' },
    { toc: toc + '3; 1 2 INDEX public other_idx postgres\n' },
  ])('refuses incomplete, errored or incompatible evidence: %j', (override) => {
    expect(() => plan(override)).toThrow('restore_resume_refused:');
  });
});
