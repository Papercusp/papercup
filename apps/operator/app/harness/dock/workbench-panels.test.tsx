/**
 * @vitest-environment jsdom
 *
 * WorkbenchPuiPanel behaviour (desktop-workbench-shell P-002).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkbenchPuiPanel } from './workbench-panels';
import type { PanelComponentProps } from './panel-registry';

afterEach(cleanup);

function props(params: Record<string, unknown>): PanelComponentProps {
  return {
    panelId: 'p-wb-pui',
    panelType: 'workbench:pui',
    params,
    api: { setParams: () => {}, setTitle: () => {}, close: () => {} },
  };
}

describe('WorkbenchPuiPanel', () => {
  it('shows an empty state (no iframe) when no harness is selected', () => {
    render(<WorkbenchPuiPanel {...props({})} />);
    expect(screen.getByText(/No harness selected/i)).toBeTruthy();
    expect(screen.queryByTestId('workbench-pui-iframe')).toBeNull();
  });

  it('embeds /pi?harness=<slug> when a harness is set', () => {
    render(<WorkbenchPuiPanel {...props({ harnessSlug: 'papercup' })} />);
    const iframe = screen.getByTestId('workbench-pui-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('/pi?harness=papercup');
  });

  it('url-encodes the harness slug in the iframe src', () => {
    render(<WorkbenchPuiPanel {...props({ harnessSlug: 'a/b c' })} />);
    const iframe = screen.getByTestId('workbench-pui-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('/pi?harness=a%2Fb%20c');
  });
});
