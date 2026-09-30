import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIVE_CERTIFICATION_BUILD_END_DIRT_FILE,
  LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT,
  LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION,
  assessLiveReleaseCertification,
  readBuildEndDirtyPaths,
  readLiveReleaseCertification,
  type LiveFederationVerdictRecord,
} from './live-release-certification';

const TARGET = '0123456789abcdef0123456789abcdef01234567';
const DESKTOP = 'abcdef0123456789abcdef0123456789abcdef01';
const NOW = Date.parse('2026-08-26T12:00:00Z');

function record(overrides: Partial<LiveFederationVerdictRecord> = {}): LiveFederationVerdictRecord {
  return {
    schema_version: LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION,
    epoch: Math.floor(NOW / 1_000) - 60,
    verdict: 'GREEN',
    head: TARGET.slice(0, 12),
    desktop_head: DESKTOP.slice(0, 12),
    source_mode: 'rebuilt',
    source_head: TARGET.slice(0, 12),
    source_desktop_head: DESKTOP.slice(0, 12),
    source_dirty_files: 0,
    terminal_dirty_files: 0,
    certification_target_sha: TARGET,
    certification_expires_epoch: Math.floor(NOW / 1_000) + 3_600,
    // WI-483569 — a certifying GREEN must show the federation legs it actually ran. Before this
    // field existed here, the fixture modelled a GREEN with no leg outcomes at all, which is
    // precisely the blind spot the production reader had: the suite could not have caught a green
    // that skipped every federation leg, because it never described legs in the first place.
    // local_matrix SKIPPED is deliberate and realistic — that leg is on a 144h cadence, so most
    // windows are not due to run it, and requiring it here would be a rule ordinary deploys
    // could not satisfy.
    legs: {
      content_matrix: 'PASS',
      from_repo: 'PASS',
      from_repo_witness: 'PASS',
      local_matrix: 'SKIPPED',
      build: 'OK',
    },
    ...overrides,
  };
}

const bank = (...records: LiveFederationVerdictRecord[]) => `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

describe('assessLiveReleaseCertification', () => {
  it('certifies only a clean rebuilt GREEN for the exact target sha', () => {
    const verdict = assessLiveReleaseCertification(bank(record()), TARGET, NOW, '/tmp/verdicts.jsonl');

    expect(verdict).toMatchObject({
      status: 'certified',
      certified: true,
      targetSha: TARGET,
      bankPath: '/tmp/verdicts.jsonl',
    });
    expect(verdict.evidence?.source_head).toBe(TARGET.slice(0, 12));
  });

  it('refuses a clean GREEN produced for a different sha', () => {
    const verdict = assessLiveReleaseCertification(
      bank(record({
        head: 'f'.repeat(12),
        source_head: 'f'.repeat(12),
        certification_target_sha: 'f'.repeat(40),
      })),
      TARGET,
      NOW,
    );

    expect(verdict).toMatchObject({ status: 'target-mismatch', certified: false });
  });

  it.each([
    ['dirty at build start', { source_dirty_files: 1 }],
    ['dirty at terminal verdict', { terminal_dirty_files: 2 }],
    ['shared-tree source', { source_mode: 'shared-working-tree' }],
    ['desktop submodule moved', { desktop_head: 'f'.repeat(12) }],
  ])('refuses %s', (_label, overrides) => {
    const verdict = assessLiveReleaseCertification(bank(record(overrides)), TARGET, NOW);

    expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
  });

  describe('federation-leg coverage (WI-483569) — a GREEN is a claim about the run, not proof of coverage', () => {
    /**
     * THE BUG: acceptance branched on `verdict` and `certification_expires_epoch` only, so a GREEN
     * that had exercised NO federation at all certified a release SHA exactly as strongly as a
     * fully-exercised one. Measured 2026-08-28: all four GREENs in the retained 374-row bank were
     * that shape — content_matrix SKIPPED, local_matrix SKIPPED, carried to a clean verdict by the
     * from-repo leg alone, because no Package=papercusp-gui .deb existed to repack (WI-478707) and
     * that one selector failure sets SKIP_MATRIX=1 + RUN_LOCAL_MATRIX=0 together.
     */
    it('THE BUG: refuses the exact false-green shape observed live (both matrix legs skipped)', () => {
      const verdict = assessLiveReleaseCertification(
        bank(
          record({
            legs: {
              content_matrix: 'SKIPPED',
              from_repo: 'PASS',
              from_repo_witness: 'SKIPPED',
              local_matrix: 'SKIPPED',
              build: 'OK',
            },
          }),
        ),
        TARGET,
        NOW,
      );

      expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
      // The reason must name the leg and its actual value — a reader who only sees "unqualified"
      // will go looking for an expiry or a sha mismatch and find neither.
      expect(verdict.reason).toMatch(/content-matrix/);
      expect(verdict.reason).toMatch(/"SKIPPED"/);
    });

    it.each([
      ['a leg that ran and FAILED', 'FAIL'],
      ['the attestation-wall decline', 'SKIPPED-ATTESTATION-WALL'],
      ['the never-ran marker', '?'],
      ['an empty outcome', ''],
    ])('refuses %s', (_label, contentMatrix) => {
      const verdict = assessLiveReleaseCertification(
        bank(record({ legs: { content_matrix: contentMatrix, from_repo: 'PASS', build: 'OK' } })),
        TARGET,
        NOW,
      );
      expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
    });

    it('fails CLOSED on a record that cannot answer the question at all (no legs object)', () => {
      // "not measured" and "measured green" must never collapse to the same answer — that
      // collapse IS the defect. Older bank rows predate the field; they do not inherit trust.
      const verdict = assessLiveReleaseCertification(
        bank(record({ legs: undefined })),
        TARGET,
        NOW,
      );
      expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
      expect(verdict.reason).toMatch(/does not report which legs ran/);
    });

    it('POSITIVE CONTROL: accepts the WI-971 pass variant the gate actually emits', () => {
      // Without this the rule could be "reject everything", which passes every case above while
      // making certification unreachable. PASS-971 is a real token from the live bank.
      const verdict = assessLiveReleaseCertification(
        bank(record({ legs: { content_matrix: 'PASS-971', from_repo: 'PASS', build: 'OK' } })),
        TARGET,
        NOW,
      );
      expect(verdict).toMatchObject({ status: 'certified', certified: true });
    });

    it('a SKIPPED local_matrix still certifies — the heavy leg is on a 144h cadence by design', () => {
      // Guards against over-tightening: demanding the weekly containerized matrix on every deploy
      // would be a rule so expensive it gets routed around, which is worse than no rule.
      const verdict = assessLiveReleaseCertification(
        bank(record({ legs: { content_matrix: 'PASS', local_matrix: 'SKIPPED', build: 'OK' } })),
        TARGET,
        NOW,
      );
      expect(verdict).toMatchObject({ status: 'certified', certified: true });
    });

    it('does not read a SKIPPED-prefixed token as a pass', () => {
      // The matcher is anchored and hyphen-delimited so no future SKIPPED-PASS* token slips through.
      const verdict = assessLiveReleaseCertification(
        bank(record({ legs: { content_matrix: 'SKIPPED-PASSTHROUGH', build: 'OK' } })),
        TARGET,
        NOW,
      );
      expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
    });
  });

  it('expires using the writer-owned expiry rather than a reader-side TTL guess', () => {
    const verdict = assessLiveReleaseCertification(
      bank(record({ certification_expires_epoch: Math.floor(NOW / 1_000) })),
      TARGET,
      NOW,
    );

    expect(verdict).toMatchObject({ status: 'expired', certified: false });
  });

  it('lets a newer exact-source RED revoke an older GREEN', () => {
    const verdict = assessLiveReleaseCertification(
      bank(
        record({ epoch: Math.floor(NOW / 1_000) - 120 }),
        record({ epoch: Math.floor(NOW / 1_000) - 30, verdict: 'RED' }),
      ),
      TARGET,
      NOW,
    );

    expect(verdict).toMatchObject({ status: 'failed', certified: false });
  });

  it('does not let a freshness/no-op token inherit certification', () => {
    const verdict = assessLiveReleaseCertification(
      bank(record(), record({ verdict: 'FRESH-GREEN', source_mode: 'freshness-only' })),
      TARGET,
      NOW,
    );

    expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
  });

  it('fails closed on a torn newest append instead of falling back to an older GREEN', () => {
    const raw = `${bank(record())}{"schema_version":2,"verdict":"RED"`;
    const verdict = assessLiveReleaseCertification(raw, TARGET, NOW);

    expect(verdict).toMatchObject({ status: 'unreadable', certified: false, invalidLines: 1 });
  });

  it('refuses legacy GREEN records that lack immutable-source evidence', () => {
    const verdict = assessLiveReleaseCertification(
      bank({ epoch: Math.floor(NOW / 1_000) - 30, verdict: 'GREEN', head: TARGET.slice(0, 12) }),
      TARGET,
      NOW,
    );

    expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
  });
});

describe('deterministic source dirt (EI-24610020645182418) — a repeat is a verdict, not a retry', () => {
  // The observed 93f1c720 shape: every functional leg passed, but the build rewrote the
  // lockfile, so the run ended `certification-source-dirty-at-build-end`.
  const dirtyRun = (work: string, overrides: Partial<LiveFederationVerdictRecord> = {}) =>
    record({ verdict: 'RED', terminal_dirty_files: 1, work, ...overrides });
  const lockDirt = (r: LiveFederationVerdictRecord) =>
    typeof r.work === 'string' && r.work.startsWith('/tmp/live-fed-gate-') ? [' M package-lock.json'] : null;

  it('THE BUG: a second identical dirty run of the same sha is failed, which stops the relaunch', () => {
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a'), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
      null,
      lockDirt,
    );

    expect(verdict).toMatchObject({ status: 'failed', certified: false });
    expect(verdict.reason).toContain(`on ${LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT} consecutive certification runs`);
    expect(verdict.reason).toContain('M package-lock.json');
  });

  it('keeps ONE retry for dirt that may be transient', () => {
    const verdict = assessLiveReleaseCertification(bank(dirtyRun('/tmp/live-fed-gate-a')), TARGET, NOW, null, lockDirt);

    expect(verdict).toMatchObject({ status: 'unqualified', certified: false });
    expect(verdict.reason).toContain(`run 1 of ${LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT}`);
  });

  it('judges the dirt, not the verdict word: a storm-skipped dirty run counts toward the streak', () => {
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a', { verdict: 'SKIPPED-STORM' }), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
      null,
      lockDirt,
    );

    expect(verdict.status).toBe('failed');
  });

  it('different dirty paths are not the same failure', () => {
    const paths = (r: LiveFederationVerdictRecord) =>
      r.work === '/tmp/live-fed-gate-a' ? [' M package-lock.json'] : [' M apps/operator/package.json'];
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a'), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
      null,
      paths,
    );

    expect(verdict.status).toBe('unqualified');
  });

  it('different dirty counts are not the same failure', () => {
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a', { terminal_dirty_files: 2 }), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
    );

    expect(verdict.status).toBe('unqualified');
  });

  it('a clean run in between ends the streak', () => {
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a'), record({ verdict: 'RED' }), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
      null,
      lockDirt,
    );

    expect(verdict.status).toBe('unqualified');
  });

  it('a freshness token in between is not a run and does not end the streak', () => {
    const verdict = assessLiveReleaseCertification(
      bank(
        dirtyRun('/tmp/live-fed-gate-a'),
        record({ verdict: 'FRESH', source_mode: 'unmeasured' }),
        dirtyRun('/tmp/live-fed-gate-b'),
      ),
      TARGET,
      NOW,
      null,
      lockDirt,
    );

    expect(verdict.status).toBe('failed');
  });

  it('dirty runs of ANOTHER sha do not count', () => {
    const other = 'fedcba9876543210fedcba9876543210fedcba98';
    const verdict = assessLiveReleaseCertification(
      bank(
        dirtyRun('/tmp/live-fed-gate-a', {
          head: other.slice(0, 12),
          source_head: other.slice(0, 12),
          certification_target_sha: other,
        }),
        dirtyRun('/tmp/live-fed-gate-b'),
      ),
      TARGET,
      NOW,
      null,
      lockDirt,
    );

    expect(verdict.status).toBe('unqualified');
  });

  it('a pruned work directory degrades to comparing counts', () => {
    const verdict = assessLiveReleaseCertification(
      bank(dirtyRun('/tmp/live-fed-gate-a'), dirtyRun('/tmp/live-fed-gate-b')),
      TARGET,
      NOW,
    );

    expect(verdict.status).toBe('failed');
  });
});

describe('readBuildEndDirtyPaths', () => {
  it("reads the run's build-end dirt list from its gate work directory", () => {
    const work = mkdtempSync('/tmp/live-fed-gate-test-');
    try {
      writeFileSync(join(work, LIVE_CERTIFICATION_BUILD_END_DIRT_FILE), ' M package-lock.json\n\n');
      expect(readBuildEndDirtyPaths(record({ work }))).toEqual([' M package-lock.json']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('returns null when the work directory is pruned', () => {
    expect(readBuildEndDirtyPaths(record({ work: '/tmp/live-fed-gate-pruned-000000' }))).toBeNull();
  });

  it('refuses to read outside a gate work directory', () => {
    expect(readBuildEndDirtyPaths(record({ work: '/etc' }))).toBeNull();
    expect(readBuildEndDirtyPaths(record({ work: '/tmp/live-fed-gate-x/../../etc' }))).toBeNull();
    expect(readBuildEndDirtyPaths(record())).toBeNull();
  });
});

describe('readLiveReleaseCertification', () => {
  it('returns missing for an absent bank without throwing', async () => {
    const verdict = await readLiveReleaseCertification(TARGET, {
      bankPath: '/missing/verdicts.jsonl',
      nowMs: NOW,
      readText: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });

    expect(verdict).toMatchObject({ status: 'missing', certified: false });
  });
});
