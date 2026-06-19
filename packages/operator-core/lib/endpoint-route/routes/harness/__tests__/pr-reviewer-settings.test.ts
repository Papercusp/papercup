/**
 * pr-reviewer-settings.test.ts — Phase 8 P-049. Unit tests for the
 * route shape + the pure validation/mapping helpers:
 *   - parseSettingsPatch     (P-049a toggle/merge-method body)
 *   - parseTrustRemoveBody   (P-049b trust-remove body)
 *   - toToggles              (row → UI projection)
 *
 * Handlers themselves are PG + gh-token bound (integration territory);
 * the testable surface is the validation/mapping, exercised here.
 */

import { describe, it, expect } from 'vitest';
import routes, {
  parseSettingsPatch,
  parseTrustRemoveBody,
  toToggles,
  patchTouchesAutoMode,
  autoModeEditableFrom,
} from '../pr-reviewer-settings';
import { defaultPrReviewerSettings } from '../../../../pr-host/pr-reviewer-settings-types';

describe('pr-reviewer-settings routes — shape', () => {
  it('exports 3 routes', () => {
    expect(routes).toHaveLength(3);
  });

  it('GET /harness/:slug/pr-reviewer-settings is public', () => {
    const r = routes.find((x) => x.method === 'GET');
    expect(r?.path).toBe('/harness/:slug/pr-reviewer-settings');
    expect(r?.auth).toBe('public');
  });

  it('POST settings + POST trust/remove are registered', () => {
    const posts = routes.filter((x) => x.method === 'POST');
    const paths = posts.map((p) => p.path).sort();
    expect(paths).toEqual([
      '/harness/:slug/pr-reviewer-settings',
      '/harness/:slug/pr-reviewer-settings/trust/remove',
    ]);
  });
});

describe('parseSettingsPatch', () => {
  it('rejects null / non-object / empty', () => {
    expect(parseSettingsPatch(null).ok).toBe(false);
    expect(parseSettingsPatch('x').ok).toBe(false);
    expect(parseSettingsPatch({}).ok).toBe(false);
  });

  it('accepts a single boolean toggle', () => {
    const r = parseSettingsPatch({ pr_reviewer_role_enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ pr_reviewer_role_enabled: true });
  });

  it('accepts all toggles + merge_method together', () => {
    const r = parseSettingsPatch({
      pr_reviewer_role_enabled: true,
      auto_review: false,
      auto_merge: true,
      merge_method: 'rebase',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({
        pr_reviewer_role_enabled: true,
        auto_review: false,
        auto_merge: true,
        merge_method: 'rebase',
      });
    }
  });

  it('rejects a non-boolean toggle', () => {
    const r = parseSettingsPatch({ auto_review: 'yes' });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown merge_method', () => {
    const r = parseSettingsPatch({ merge_method: 'fast-forward' });
    expect(r.ok).toBe(false);
  });

  it('accepts each valid merge_method', () => {
    for (const m of ['squash', 'merge', 'rebase'] as const) {
      const r = parseSettingsPatch({ merge_method: m });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.patch.merge_method).toBe(m);
    }
  });

  it('drops unknown fields (only recognised survive)', () => {
    const r = parseSettingsPatch({ auto_merge: true, bogus: 123 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ auto_merge: true });
  });
});

describe('parseTrustRemoveBody', () => {
  it('rejects null / non-object', () => {
    expect(parseTrustRemoveBody(null).ok).toBe(false);
    expect(parseTrustRemoveBody('x').ok).toBe(false);
  });

  it('rejects missing / non-positive / float ids', () => {
    expect(parseTrustRemoveBody({}).ok).toBe(false);
    expect(parseTrustRemoveBody({ trusted_github_user_id: 0 }).ok).toBe(false);
    expect(parseTrustRemoveBody({ trusted_github_user_id: -1 }).ok).toBe(false);
    expect(parseTrustRemoveBody({ trusted_github_user_id: 1.5 }).ok).toBe(false);
  });

  it('accepts a positive int + coerces a numeric string', () => {
    const a = parseTrustRemoveBody({ trusted_github_user_id: 42 });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.trustedId).toBe(42);
    const b = parseTrustRemoveBody({ trusted_github_user_id: '99' });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.trustedId).toBe(99);
  });

  it('rejects a non-numeric string', () => {
    expect(parseTrustRemoveBody({ trusted_github_user_id: 'bob' }).ok).toBe(false);
  });
});

describe('PR-3 owner-gated auto-mode — patchTouchesAutoMode', () => {
  it('true when the patch flips auto_review or auto_merge', () => {
    expect(patchTouchesAutoMode({ auto_review: true })).toBe(true);
    expect(patchTouchesAutoMode({ auto_merge: false })).toBe(true);
    expect(patchTouchesAutoMode({ auto_review: false, auto_merge: true })).toBe(true);
  });
  it('false for non-auto-mode patches (role / merge_method are not gated here)', () => {
    expect(patchTouchesAutoMode({ pr_reviewer_role_enabled: true })).toBe(false);
    expect(patchTouchesAutoMode({ merge_method: 'rebase' })).toBe(false);
    expect(patchTouchesAutoMode({})).toBe(false);
  });
});

describe('PR-3 owner-gated auto-mode — autoModeEditableFrom (the teeth)', () => {
  it('editable ONLY for a gh-authed claimed owner', () => {
    expect(autoModeEditableFrom({ editable: true, claimOwner: true })).toBe(true);
  });
  it('a non-owner viewer (even gh-authed) is read-only — the 403 case', () => {
    expect(autoModeEditableFrom({ editable: true, claimOwner: false })).toBe(false);
  });
  it('an anonymous viewer is read-only', () => {
    expect(autoModeEditableFrom({ editable: false, claimOwner: true })).toBe(false);
    expect(autoModeEditableFrom({ editable: false, claimOwner: false })).toBe(false);
  });
});

describe('toToggles', () => {
  it('projects the default row to all-off + squash', () => {
    const row = defaultPrReviewerSettings({ harness_slug: 's', github_user_id: 1, now: 0 });
    expect(toToggles(row)).toEqual({
      pr_reviewer_role_enabled: false,
      auto_review: false,
      auto_merge: false,
      merge_method: 'squash',
    });
  });

  it('carries through an enabled row', () => {
    const row = defaultPrReviewerSettings({ harness_slug: 's', github_user_id: 1, now: 0 });
    expect(
      toToggles({ ...row, pr_reviewer_role_enabled: true, auto_review: true, merge_method: 'merge' }),
    ).toEqual({
      pr_reviewer_role_enabled: true,
      auto_review: true,
      auto_merge: false,
      merge_method: 'merge',
    });
  });
});
