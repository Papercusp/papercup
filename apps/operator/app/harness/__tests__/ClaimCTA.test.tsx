/**
 * @vitest-environment jsdom
 *
 * ClaimCTA — P-069e tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClaimCTA } from '../ClaimCTA';
import {
  BindingServiceErrorThrowable,
  type BindingRecord,
} from '../../../lib/harness/binding-types';

afterEach(() => {
  cleanup();
});

function makeBinding(overrides: Partial<BindingRecord> = {}): BindingRecord {
  return {
    binding_id: 'github:123',
    workspace_id: 'ws-1',
    harness_slug: 'papercup',
    provider: 'github',
    repository_id: '123',
    github_full_name: 'octo/repo',
    privacy: 'shared-public',
    claim_status: 'claimed',
    provisional_owner_github_user_id: 'u1',
    claimed_by_github_user_ids: ['u1'],
    claimed_at: new Date().toISOString(),
    last_permission_verified_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  } as BindingRecord;
}

describe('ClaimCTA — P-069e', () => {
  it('renders the default label', () => {
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={async () => makeBinding()}
      />,
    );
    expect(screen.getByTestId('claim-cta-button').textContent).toBe(
      'Claim this harness',
    );
  });

  it('accepts a custom label', () => {
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={async () => makeBinding()}
        label="Claim now"
      />,
    );
    expect(screen.getByTestId('claim-cta-button').textContent).toBe(
      'Claim now',
    );
  });

  it('disables while pending and calls onSuccess on resolve', async () => {
    let resolve: ((b: BindingRecord) => void) | null = null;
    const onClaim = vi.fn(
      () =>
        new Promise<BindingRecord>((r) => {
          resolve = r;
        }),
    );
    const onSuccess = vi.fn();
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
        onSuccess={onSuccess}
      />,
    );
    const btn = screen.getByTestId('claim-cta-button') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.textContent).toBe('Claiming…');
    expect(btn.disabled).toBe(true);
    await act(async () => {
      resolve!(makeBinding());
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(btn.disabled).toBe(false);
  });

  it('CLAIM_PERMISSION_DENIED surfaces actual + required + help link', async () => {
    const onClaim = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({
        code: 'CLAIM_PERMISSION_DENIED',
        actual: 'write',
        required: 'maintain or admin',
      });
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    const error = screen.getByTestId('claim-cta-error');
    expect(error.textContent).toContain('maintain or admin');
    expect(error.textContent).toContain('write');
    const link = screen.getByTestId('claim-cta-help-link') as HTMLAnchorElement;
    expect(link.href).toContain('github.com/octo/repo/settings/access');
  });

  it('BINDING_NOT_CLAIMABLE shows the reason', async () => {
    const onClaim = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({
        code: 'BINDING_NOT_CLAIMABLE',
        reason: 'binding superseded',
      });
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.getByTestId('claim-cta-error').textContent).toContain(
      'binding superseded',
    );
  });

  it('BINDING_NOT_FOUND shows refresh hint', async () => {
    const onClaim = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({ code: 'BINDING_NOT_FOUND' });
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.getByTestId('claim-cta-error').textContent).toContain(
      'Refresh and try again',
    );
  });

  it('GITHUB_API_RATE_LIMIT shows retry-after seconds', async () => {
    const onClaim = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({
        code: 'GITHUB_API_RATE_LIMIT',
        retry_after_ms: 30000,
      });
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.getByTestId('claim-cta-error').textContent).toContain('30s');
  });

  it('GITHUB_API_DOWN shows generic retry message', async () => {
    const onClaim = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({
        code: 'GITHUB_API_DOWN',
        message: 'connection refused',
      });
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.getByTestId('claim-cta-error').textContent).toContain(
      'GitHub is unreachable',
    );
  });

  it('non-binding errors fall through to a generic message', async () => {
    const onClaim = vi.fn(async () => {
      throw new Error('boom');
    });
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.getByTestId('claim-cta-error').textContent).toContain('boom');
  });

  it('error clears when the user retries successfully', async () => {
    let attempt = 0;
    const onClaim = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new BindingServiceErrorThrowable({ code: 'BINDING_NOT_FOUND' });
      }
      return makeBinding();
    });
    const onSuccess = vi.fn();
    render(
      <ClaimCTA
        bindingId="github:123"
        githubRepo="octo/repo"
        onClaim={onClaim}
        onSuccess={onSuccess}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.queryByTestId('claim-cta-error')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim-cta-button'));
    });
    expect(screen.queryByTestId('claim-cta-error')).toBeNull();
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
