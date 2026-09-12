import { describe, expect, it } from 'vitest';

import { serializeBenchmarkReport } from './bench-release-task-reuse';
import {
  findBoxIdentityPaths,
  findIdentityLiterals,
  findOwnerNameLeaks,
} from './lib/identity-leak-patterns.mjs';

describe('benchmark evidence serialization', () => {
  it('redacts host, home and owner identity while preserving measurements and digests', () => {
    const fixtureUser = 'benchmark-person';
    const fixtureOwner = 'Exampleperson';
    const identities: [string, string][] = [
      ['build-hostname', 'benchmark-private-machine'],
      ['build-user-name', fixtureUser],
    ];
    const report = {
      host: 'benchmark-private-machine',
      source: `/home/${fixtureUser}/repo`,
      note: `[owner:${fixtureOwner} 2026-09-12] measured on one machine`,
      samples: [{ coldPreparationMs: 186.041, hitPreparationMs: 30.13 }],
      result: { passed: true, reductionPct: 83.805 },
      fixture: { sourceSha256: 'a'.repeat(64) },
    };

    const output = serializeBenchmarkReport(report, identities);
    const evidence = JSON.parse(output);

    expect(findIdentityLiterals(output, identities)).toEqual([]);
    expect(findBoxIdentityPaths(output)).toEqual([]);
    expect(findOwnerNameLeaks(output)).toEqual([]);
    expect(evidence).toEqual({
      ...report,
      host: 'buildhost',
      source: '/home/builduser/repo',
      note: '[owner 2026-09-12] measured on one machine',
    });
    expect(report.host).toBe('benchmark-private-machine');
  });

  it('preserves valid JSON and a terminal newline for already anonymous evidence', () => {
    const report = { host: 'buildhost', note: 'quoted "result"\nsecond line', passed: false };
    const output = serializeBenchmarkReport(report, []);

    expect(JSON.parse(output)).toEqual(report);
    expect(output.endsWith('\n')).toBe(true);
  });
});
