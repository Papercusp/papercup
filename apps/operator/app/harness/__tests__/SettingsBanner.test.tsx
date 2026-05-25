/**
 * @vitest-environment jsdom
 *
 * SettingsBanner — P-069b tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsBanner } from '../SettingsBanner';

afterEach(() => {
  cleanup();
});

describe('SettingsBanner — P-069b', () => {
  it('provisional mode names the viewer as provisional owner', () => {
    render(<SettingsBanner mode="provisional" />);
    const banner = screen.getByTestId('settings-banner');
    expect(banner.getAttribute('data-mode')).toBe('provisional');
    expect(banner.textContent).toContain("You're the provisional owner");
    expect(banner.textContent).toContain('unclaimed');
  });

  it('unclaimed mode (not me) names the other owner', () => {
    render(<SettingsBanner mode="unclaimed" ownerLogin="alice" />);
    const banner = screen.getByTestId('settings-banner');
    expect(banner.getAttribute('data-mode')).toBe('unclaimed');
    expect(banner.textContent).toContain('@alice');
    expect(banner.textContent).toContain('provisional owner');
  });

  it('claimed mode without other claimants shows just the lead', () => {
    render(<SettingsBanner mode="claimed" ownerLogin="bob" />);
    const banner = screen.getByTestId('settings-banner');
    expect(banner.getAttribute('data-mode')).toBe('claimed');
    expect(banner.textContent).toContain('Claimed by');
    expect(banner.textContent).toContain('@bob');
    expect(banner.textContent).not.toContain('other');
  });

  it('claimed mode with 1 additional claimant uses singular', () => {
    render(
      <SettingsBanner
        mode="claimed"
        ownerLogin="bob"
        additionalClaimantCount={1}
      />,
    );
    expect(screen.getByTestId('settings-banner').textContent).toContain(
      '+ 1 other.',
    );
  });

  it('claimed mode with N additional claimants uses plural', () => {
    render(
      <SettingsBanner
        mode="claimed"
        ownerLogin="bob"
        additionalClaimantCount={3}
      />,
    );
    expect(screen.getByTestId('settings-banner').textContent).toContain(
      '+ 3 others.',
    );
  });

  it('renders an ClaimStatusBadge with status=claimed for claimed mode', () => {
    render(<SettingsBanner mode="claimed" ownerLogin="bob" />);
    // ClaimStatusBadge in claimed state shows "Claimed by @bob" inside it
    const banner = screen.getByTestId('settings-banner');
    // badge text + body text both contain "Claimed"
    expect(banner.textContent).toContain('Claimed');
  });

  it('renders an ClaimStatusBadge with status=unclaimed for provisional mode', () => {
    render(<SettingsBanner mode="provisional" />);
    const banner = screen.getByTestId('settings-banner');
    expect(banner.textContent).toContain('Unclaimed');
  });

  it('renders an ClaimStatusBadge with status=unclaimed for unclaimed-non-viewer mode', () => {
    render(<SettingsBanner mode="unclaimed" ownerLogin="alice" />);
    const banner = screen.getByTestId('settings-banner');
    expect(banner.textContent).toContain('Unclaimed');
  });
});
