// @vitest-environment jsdom
//
// SetupPreviewPane composition + read-only safety (desktop-workbench-shell
// P-006 / P-007).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SetupPreviewPane } from './SetupPreviewPane';

afterEach(cleanup);

describe('SetupPreviewPane (first-run app preview)', () => {
  it('embeds the operator app (carries the chat) + the pui terminal', () => {
    render(<SetupPreviewPane />);
    expect(
      (screen.getByTestId('setup-preview-app') as HTMLIFrameElement).getAttribute('src'),
    ).toBe('/adv');
    expect(
      (screen.getByTestId('setup-preview-pui') as HTMLIFrameElement).getAttribute('src'),
    ).toBe('/pi');
  });

  it('renders the previews read-only / non-interactive (P-007)', () => {
    render(<SetupPreviewPane />);
    for (const id of ['setup-preview-app', 'setup-preview-pui']) {
      const f = screen.getByTestId(id);
      // Not focusable + hidden from a11y tree — illustrative, not live.
      expect(f.getAttribute('tabindex')).toBe('-1');
      expect(f.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
