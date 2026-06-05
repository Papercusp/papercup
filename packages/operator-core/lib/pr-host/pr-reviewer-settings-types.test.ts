import { describe, expect, it } from 'vitest';
import {
  PR_REVIEWER_SETTINGS_SCHEMA_VERSION,
  applyPrReviewerSettingsPatch,
  defaultPrReviewerSettings,
  hasAnyAutoActionEnabled,
  isPrReviewerSettingsRow,
  isSafeDefaultState,
  type PrReviewerSettingsRow,
} from './pr-reviewer-settings-types';

function makeRow(over: Partial<PrReviewerSettingsRow> = {}): PrReviewerSettingsRow {
  return {
    harness_slug: 'papercup',
    github_user_id: 12345,
    pr_reviewer_role_enabled: false,
    auto_review: false,
    auto_merge: false,
    merge_method: 'squash',
    updated_at: 1716_000_000_000,
    schema_version: 1,
    ...over,
  };
}

describe('PR_REVIEWER_SETTINGS_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(PR_REVIEWER_SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});

describe('defaultPrReviewerSettings', () => {
  it('builds an all-FALSE row with squash + given identity + now', () => {
    const row = defaultPrReviewerSettings({
      harness_slug: 'papercup',
      github_user_id: 12345,
      now: 1716_000_000_000,
    });
    expect(row.pr_reviewer_role_enabled).toBe(false);
    expect(row.auto_review).toBe(false);
    expect(row.auto_merge).toBe(false);
    expect(row.merge_method).toBe('squash');
    expect(row.updated_at).toBe(1716_000_000_000);
    expect(row.schema_version).toBe(1);
  });

  it('round-trips through isPrReviewerSettingsRow', () => {
    const row = defaultPrReviewerSettings({
      harness_slug: 'x',
      github_user_id: 1,
      now: 1,
    });
    expect(isPrReviewerSettingsRow(row)).toBe(true);
  });
});

describe('isPrReviewerSettingsRow', () => {
  it('accepts a well-formed row', () => {
    expect(isPrReviewerSettingsRow(makeRow())).toBe(true);
  });

  it('accepts a row without schema_version (legacy)', () => {
    const r = { ...makeRow() };
    delete r.schema_version;
    expect(isPrReviewerSettingsRow(r)).toBe(true);
  });

  it('rejects bad merge_method', () => {
    expect(
      isPrReviewerSettingsRow({ ...makeRow(), merge_method: 'fast-forward' }),
    ).toBe(false);
  });

  it('rejects non-boolean toggles', () => {
    expect(
      isPrReviewerSettingsRow({ ...makeRow(), pr_reviewer_role_enabled: 1 }),
    ).toBe(false);
    expect(
      isPrReviewerSettingsRow({ ...makeRow(), auto_review: 'yes' }),
    ).toBe(false);
  });

  it('rejects empty harness_slug or non-positive github_user_id', () => {
    expect(isPrReviewerSettingsRow(makeRow({ harness_slug: '' }))).toBe(false);
    expect(isPrReviewerSettingsRow(makeRow({ github_user_id: 0 }))).toBe(false);
    expect(isPrReviewerSettingsRow(makeRow({ github_user_id: 1.5 }))).toBe(false);
  });

  it('rejects wrong schema_version when present', () => {
    expect(isPrReviewerSettingsRow({ ...makeRow(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isPrReviewerSettingsRow(null)).toBe(false);
    expect(isPrReviewerSettingsRow('x')).toBe(false);
  });
});

describe('applyPrReviewerSettingsPatch', () => {
  it('merges a single-field patch + bumps updated_at', () => {
    const existing = makeRow({ updated_at: 100 });
    const next = applyPrReviewerSettingsPatch(
      existing,
      { pr_reviewer_role_enabled: true },
      200,
    );
    expect(next.pr_reviewer_role_enabled).toBe(true);
    expect(next.auto_review).toBe(false); // unchanged
    expect(next.updated_at).toBe(200);
  });

  it('preserves fields not in the patch', () => {
    const existing = makeRow({
      pr_reviewer_role_enabled: true,
      auto_review: true,
      merge_method: 'rebase',
    });
    const next = applyPrReviewerSettingsPatch(existing, { auto_merge: true }, 1);
    expect(next.pr_reviewer_role_enabled).toBe(true);
    expect(next.auto_review).toBe(true);
    expect(next.merge_method).toBe('rebase');
    expect(next.auto_merge).toBe(true);
  });

  it('throws on bad merge_method', () => {
    expect(() =>
      applyPrReviewerSettingsPatch(
        makeRow(),
        { merge_method: 'fast-forward' as never },
        1,
      ),
    ).toThrow(TypeError);
  });

  it('does not mutate the existing row', () => {
    const existing = makeRow({ updated_at: 100 });
    applyPrReviewerSettingsPatch(existing, { pr_reviewer_role_enabled: true }, 200);
    expect(existing.updated_at).toBe(100);
    expect(existing.pr_reviewer_role_enabled).toBe(false);
  });

  it('empty patch still bumps updated_at', () => {
    const existing = makeRow({ updated_at: 100 });
    const next = applyPrReviewerSettingsPatch(existing, {}, 200);
    expect(next.updated_at).toBe(200);
  });
});

describe('hasAnyAutoActionEnabled', () => {
  it('false when master kill-switch off', () => {
    expect(
      hasAnyAutoActionEnabled(
        makeRow({ pr_reviewer_role_enabled: false, auto_review: true, auto_merge: true }),
      ),
    ).toBe(false);
  });

  it('false when all toggles off', () => {
    expect(
      hasAnyAutoActionEnabled(
        makeRow({ pr_reviewer_role_enabled: true, auto_review: false, auto_merge: false }),
      ),
    ).toBe(false);
  });

  it('true when role enabled + any auto-toggle on', () => {
    expect(
      hasAnyAutoActionEnabled(
        makeRow({ pr_reviewer_role_enabled: true, auto_review: true, auto_merge: false }),
      ),
    ).toBe(true);
    expect(
      hasAnyAutoActionEnabled(
        makeRow({ pr_reviewer_role_enabled: true, auto_review: false, auto_merge: true }),
      ),
    ).toBe(true);
  });
});

describe('isSafeDefaultState', () => {
  it('true when master kill-switch off (regardless of toggles)', () => {
    expect(
      isSafeDefaultState(
        makeRow({ pr_reviewer_role_enabled: false, auto_review: true, auto_merge: true }),
      ),
    ).toBe(true);
  });

  it('true when all auto-toggles off', () => {
    expect(
      isSafeDefaultState(
        makeRow({ pr_reviewer_role_enabled: true, auto_review: false, auto_merge: false }),
      ),
    ).toBe(true);
  });

  it('false when role on + any auto-toggle on', () => {
    expect(
      isSafeDefaultState(
        makeRow({ pr_reviewer_role_enabled: true, auto_review: true }),
      ),
    ).toBe(false);
  });
});
