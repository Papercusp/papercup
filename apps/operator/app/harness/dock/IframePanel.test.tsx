/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IframePanel } from './IframePanel';
import { _registrySize, _resetForTests } from './iframe-host';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

beforeEach(() => _resetForTests());
afterEach(() => {
  cleanup();
  _resetForTests();
});

describe('IframePanel', () => {
  it('shows missing-src placeholder when params.src absent', () => {
    const api = mockApi();
    render(
      <IframePanel
        panelId="p1"
        panelType="view:vscode"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/missing required.*src/i)).toBeTruthy();
  });

  it('creates the iframe in the iframe-host registry on first mount', () => {
    const api = mockApi();
    expect(_registrySize()).toBe(0);
    render(
      <IframePanel
        panelId="vscode-1"
        panelType="view:vscode"
        params={{ src: '/embed/vscode', title: 'VSCode' }}
        api={api}
      />,
    );
    expect(_registrySize()).toBe(1);
  });

  it('container has aria-label from params.title', () => {
    const api = mockApi();
    const { container } = render(
      <IframePanel
        panelId="p1"
        panelType="view:vscode"
        params={{ src: '/x', title: 'My Editor' }}
        api={api}
      />,
    );
    const el = container.querySelector('[aria-label="My Editor"]');
    expect(el).toBeTruthy();
  });

  it('container falls back to panelType when no title', () => {
    const api = mockApi();
    const { container } = render(
      <IframePanel
        panelId="p1"
        panelType="view:vscode"
        params={{ src: '/x' }}
        api={api}
      />,
    );
    expect(container.querySelector('[aria-label="view:vscode content"]')).toBeTruthy();
  });

  it('iframe survives panel unmount (moved back to off-DOM, not destroyed)', () => {
    const api = mockApi();
    const { unmount } = render(
      <IframePanel
        panelId="vscode-1"
        panelType="view:vscode"
        params={{ src: '/embed/vscode' }}
        api={api}
      />,
    );
    expect(_registrySize()).toBe(1);
    unmount();
    // Iframe is detached but still in the registry — destroy is a
    // separate explicit call (HarnessDock calls it on onDidRemovePanel).
    expect(_registrySize()).toBe(1);
  });

  it('two panels with the same panelId share the same iframe', () => {
    const api = mockApi();
    const { unmount: unmount1 } = render(
      <IframePanel
        panelId="vscode-1"
        panelType="view:vscode"
        params={{ src: '/embed/vscode' }}
        api={api}
      />,
    );
    expect(_registrySize()).toBe(1);
    unmount1();
    render(
      <IframePanel
        panelId="vscode-1"
        panelType="view:vscode"
        params={{ src: '/embed/vscode' }}
        api={api}
      />,
    );
    // Still 1 — same panelId → same iframe.
    expect(_registrySize()).toBe(1);
  });
});
