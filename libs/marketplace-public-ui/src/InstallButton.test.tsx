// @vitest-environment jsdom
/**
 * InstallButton.test.tsx — P-007 of test-coverage-rest-non-critical.
 *
 * InstallButton is the marketplace install affordance (Phase A — live external
 * surface, previously 0 tests). With no `onInstall` it's a read-only public
 * "View details" link; with `onInstall` it drives the idle → fresh → submit
 * install flow. The install action is an injected prop, so the flow is tested
 * without any network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstallButton } from './InstallButton';

afterEach(cleanup);

describe('InstallButton (P-007)', () => {
  it('with no onInstall, renders a read-only "View details" link to the given href', () => {
    render(<InstallButton slug="my-template" detailHref="/x/my-template" />);
    const link = screen.getByText('View details') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/x/my-template');
  });

  it('defaults the link href to /marketplace/<encoded-slug>', () => {
    render(<InstallButton slug="t e/st" />);
    const link = screen.getByText('View details') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/marketplace/t%20e%2Fst');
  });

  it('install flow: Install → name form → submit dispatches onInstall + fires success', async () => {
    const onInstall = vi.fn(async () => ({
      ok: true as const,
      projectSlug: 'my-template',
      projectPath: '/p',
    }));
    const onSuccess = vi.fn();
    const notify = vi.fn();
    render(
      <InstallButton
        slug="my-template"
        onInstall={onInstall}
        onSuccess={onSuccess}
        notify={notify}
      />,
    );
    fireEvent.click(screen.getByText('Install')); // idle → fresh
    fireEvent.click(screen.getByText('Install')); // fresh → submit

    await waitFor(() => expect(onInstall).toHaveBeenCalled());
    expect(onInstall).toHaveBeenCalledWith('my-template', { projectName: 'my-template' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('installed'), expect.anything());
  });

  it('surfaces an install failure through notify(error) and does not fire success', async () => {
    const onInstall = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
    const onSuccess = vi.fn();
    const notify = vi.fn();
    render(<InstallButton slug="t" onInstall={onInstall} onSuccess={onSuccess} notify={notify} />);
    fireEvent.click(screen.getByText('Install'));
    fireEvent.click(screen.getByText('Install'));

    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'boom', undefined));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
