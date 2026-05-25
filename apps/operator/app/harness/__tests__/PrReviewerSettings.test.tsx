/**
 * @vitest-environment jsdom
 *
 * PrReviewerSettings — P-049 tests.
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
  PrReviewerSettings,
  type AutoReviewAuditRow,
  type PrReviewerSettingsValues,
  type TrustedAuthorRow,
} from '../PrReviewerSettings';

afterEach(() => {
  cleanup();
});

function defaultValues(
  overrides: Partial<PrReviewerSettingsValues> = {},
): PrReviewerSettingsValues {
  return {
    pr_reviewer_role_enabled: false,
    auto_review: false,
    auto_merge: false,
    merge_method: 'squash',
    ...overrides,
  };
}

function renderModal(
  overrides: {
    initial?: PrReviewerSettingsValues;
    trusted?: TrustedAuthorRow[];
    audit?: AutoReviewAuditRow[];
    open?: boolean;
    onSave?: (next: PrReviewerSettingsValues) => Promise<void>;
    onRemoveTrust?: (id: number) => Promise<void>;
    onClose?: () => void;
  } = {},
) {
  const onSave = overrides.onSave ?? (async () => {});
  const onRemoveTrust = overrides.onRemoveTrust ?? (async () => {});
  const onClose = overrides.onClose ?? (() => {});
  return render(
    <PrReviewerSettings
      open={overrides.open ?? true}
      onClose={onClose}
      initialValues={overrides.initial ?? defaultValues()}
      trustedAuthors={overrides.trusted ?? []}
      recentAudit={overrides.audit ?? []}
      onSave={onSave}
      onRemoveTrust={onRemoveTrust}
    />,
  );
}

describe('PrReviewerSettings — P-049', () => {
  it('does not render when open=false', () => {
    renderModal({ open: false });
    expect(screen.queryByTestId('pr-reviewer-settings')).toBeNull();
  });

  it('renders sections + footer when open', () => {
    renderModal();
    expect(screen.getByTestId('pr-reviewer-settings')).toBeTruthy();
    expect(screen.getByTestId('role-toggle')).toBeTruthy();
    expect(screen.getByTestId('auto-review-toggle')).toBeTruthy();
    expect(screen.getByTestId('auto-merge-toggle')).toBeTruthy();
    expect(screen.getByTestId('merge-method-radio')).toBeTruthy();
    expect(screen.getByTestId('pr-reviewer-settings-save')).toBeTruthy();
    expect(screen.getByTestId('pr-reviewer-settings-cancel')).toBeTruthy();
  });

  it('disables auto_review/auto_merge/merge-method when role disabled', () => {
    renderModal({
      initial: defaultValues({ pr_reviewer_role_enabled: false }),
    });
    const autoReview = screen
      .getByTestId('auto-review-toggle')
      .querySelector('input') as HTMLInputElement;
    const autoMerge = screen
      .getByTestId('auto-merge-toggle')
      .querySelector('input') as HTMLInputElement;
    const radio = screen.getByTestId('merge-method-squash') as HTMLInputElement;
    expect(autoReview.disabled).toBe(true);
    expect(autoMerge.disabled).toBe(true);
    expect(radio.disabled).toBe(true);
  });

  it('enables inner controls once role is toggled on', () => {
    renderModal({
      initial: defaultValues({ pr_reviewer_role_enabled: false }),
    });
    const roleInput = screen
      .getByTestId('role-toggle')
      .querySelector('input') as HTMLInputElement;
    fireEvent.click(roleInput);
    const autoReview = screen
      .getByTestId('auto-review-toggle')
      .querySelector('input') as HTMLInputElement;
    expect(autoReview.disabled).toBe(false);
  });

  it('shows the trust list when populated', () => {
    renderModal({
      trusted: [
        {
          trusted_github_user_id: 1,
          display_login: 'alice',
          trusted_at_label: '2 days ago',
        },
        {
          trusted_github_user_id: 2,
          display_login: 'bob',
          trusted_at_label: 'just now',
        },
      ],
    });
    const list = screen.getByTestId('trust-list');
    expect(list.textContent).toContain('@alice');
    expect(list.textContent).toContain('@bob');
  });

  it('shows empty-state copy when trust list is empty', () => {
    renderModal({ trusted: [] });
    expect(screen.queryByTestId('trust-list')).toBeNull();
    expect(screen.getByTestId('pr-reviewer-settings').textContent).toContain(
      'No trusted authors yet',
    );
  });

  it('calls onRemoveTrust when remove clicked', async () => {
    const onRemoveTrust = vi.fn(async () => {});
    renderModal({
      trusted: [
        {
          trusted_github_user_id: 7,
          display_login: 'carol',
          trusted_at_label: 'today',
        },
      ],
      onRemoveTrust,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-trust-7'));
    });
    expect(onRemoveTrust).toHaveBeenCalledWith(7);
  });

  it('shows audit list when populated', () => {
    renderModal({
      audit: [
        { id: 'a1', display_text: 'approved PR #1', action: 'approved' },
        { id: 'a2', display_text: 'merged PR #1', action: 'merged' },
        { id: 'a3', display_text: 'skipped PR #2', action: 'skipped' },
      ],
    });
    const list = screen.getByTestId('audit-list');
    expect(list.textContent).toContain('approved PR #1');
    expect(list.textContent).toContain('merged PR #1');
    expect(list.textContent).toContain('skipped PR #2');
  });

  it('save calls onSave with current draft', async () => {
    const onSave = vi.fn(async () => {});
    renderModal({ onSave });
    // toggle the role on, switch merge method
    fireEvent.click(
      screen.getByTestId('role-toggle').querySelector('input')!,
    );
    fireEvent.click(screen.getByTestId('merge-method-rebase'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-save'));
    });
    expect(onSave).toHaveBeenCalledWith({
      pr_reviewer_role_enabled: true,
      auto_review: false,
      auto_merge: false,
      merge_method: 'rebase',
    });
  });

  it('save calls onClose after onSave resolves', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {});
    renderModal({ onSave, onClose });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pr-reviewer-settings-save'));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cancel calls onClose without onSave', () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {});
    renderModal({ onSave, onClose });
    fireEvent.click(screen.getByTestId('pr-reviewer-settings-cancel'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('overlay click cancels but inner click does not', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('pr-reviewer-settings'));
    expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();
    // clicking inside the modal body (an input) should not close
    fireEvent.click(
      screen.getByTestId('role-toggle').querySelector('input')!,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('save button shows pending state while save in flight', async () => {
    let resolve: (() => void) | null = null;
    const onSave = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = () => r();
        }),
    );
    renderModal({ onSave });
    const save = screen.getByTestId('pr-reviewer-settings-save') as HTMLButtonElement;
    fireEvent.click(save);
    expect(save.textContent).toBe('Saving…');
    expect(save.disabled).toBe(true);
    await act(async () => {
      resolve!();
    });
  });

  it('resets draft to initialValues when modal re-opens', () => {
    const { rerender } = render(
      <PrReviewerSettings
        open={true}
        onClose={() => {}}
        initialValues={defaultValues({ merge_method: 'squash' })}
        trustedAuthors={[]}
        recentAudit={[]}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-method-rebase'));
    rerender(
      <PrReviewerSettings
        open={false}
        onClose={() => {}}
        initialValues={defaultValues({ merge_method: 'squash' })}
        trustedAuthors={[]}
        recentAudit={[]}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    rerender(
      <PrReviewerSettings
        open={true}
        onClose={() => {}}
        initialValues={defaultValues({ merge_method: 'squash' })}
        trustedAuthors={[]}
        recentAudit={[]}
        onSave={async () => {}}
        onRemoveTrust={async () => {}}
      />,
    );
    expect(
      (screen.getByTestId('merge-method-squash') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
