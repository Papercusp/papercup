import { describe, expect, it } from 'vitest';
import {
  LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION,
  assessLiveReleaseCertification,
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
