/**
 * @vitest-environment jsdom
 *
 * PrReviewerSettingsTrigger — P-049 wiring helper tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  PrReviewerSettingsTrigger,
  type PrReviewerSettingsTriggerData,
} from '../PrReviewerSettingsTrigger';

afterEach(() => {
  cleanup();
});

function fakeData(): PrReviewerSettingsTriggerData {
  return {
    values: {
      pr_reviewer_role_enabled: true,
      auto_review: true,
      auto_merge: false,
      merge_method: 'squash',
    },
    trustedAuthors: [
      {
        trusted_github_user_id: 1,
        display_login: 'alice',
        trusted_at_label: 'today',
      },
    ],
    recentAudit: [
      { id: 'a1', display_text: 'approved PR #1', action: 'approved' },
    ],
  };
}

describe('PrReviewerSettingsTrigger — P-049 wiring helper', () => {
  it('renders just the trigger button initially', () => {
    render(
      <PrReviewerSettingsTrigger
        loadInitial={async () => fakeData()}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    expect(screen.getByTestId('pr-reviewer-settings-trigger')).toBeTruthy();
    expect(screen.queryByTestId('pr-reviewer-settings')).toBeNull();
  });

  it('clicking trigger loads + opens modal', async () => {
    const loadInitial = vi.fn(async () => fakeData());
    render(
      <PrReviewerSettingsTrigger
        loadInitial={loadInitial}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-trigger'));
    });
    expect(loadInitial).toHaveBeenCalledOnce();
    expect(screen.getByTestId('pr-reviewer-settings')).toBeTruthy();
  });

  it('loadInitial failure surfaces error + leaves modal closed', async () => {
    const loadInitial = vi.fn(async () => {
      throw new Error('PG unreachable');
    });
    render(
      <PrReviewerSettingsTrigger
        loadInitial={loadInitial}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-trigger'));
    });
    expect(screen.queryByTestId('pr-reviewer-settings')).toBeNull();
    expect(
      screen.getByTestId('pr-reviewer-settings-load-error').textContent,
    ).toContain('PG unreachable');
  });

  it('trigger is disabled while load is in flight', async () => {
    let resolve: ((d: PrReviewerSettingsTriggerData) => void) | null = null;
    const loadInitial = vi.fn(
      () =>
        new Promise<PrReviewerSettingsTriggerData>((r) => {
          resolve = r;
        }),
    );
    render(
      <PrReviewerSettingsTrigger
        loadInitial={loadInitial}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    const btn = screen.getByTestId(
      'pr-reviewer-settings-trigger',
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await act(async () => {
      resolve!(fakeData());
    });
    expect(btn.disabled).toBe(false);
  });

  it('label prop replaces the icon-only render', async () => {
    render(
      <PrReviewerSettingsTrigger
        loadInitial={async () => fakeData()}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
        label="Settings"
      />,
    );
    expect(screen.getByTestId('pr-reviewer-settings-trigger').textContent).toBe(
      'Settings',
    );
  });

  it('save flows through to caller onSave', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <PrReviewerSettingsTrigger
        loadInitial={async () => fakeData()}
        onSave={onSave}
        onRemoveTrust={async () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-trigger'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-save'));
    });
    expect(onSave).toHaveBeenCalledOnce();
  });
});
